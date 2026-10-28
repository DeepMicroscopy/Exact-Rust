// End-to-end test of the image set page in the system Chrome: create a set, upload by file picker and by drop, tags, products,
// selection, registration (job, result, inverse), move, delete, settings, lock, delete set. Needs a fresh scratch database.
// Usage: node e2e/imageset.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exact-e2e-"));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A noisy RGB PNG (so that it has detail at every scale). */
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let s = seed;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      raw[y * (w * 3 + 1) + 1 + x] = (((s >>> 24) & 0x3f) + ((x / 3 + y) % 128)) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const files = [1, 2, 3].map((n) => {
  const f = path.join(tmp, `e2e-img-${n}-${Date.now()}.png`);
  fs.writeFileSync(f, png(640, 420, n * 7919));
  return f;
});

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const waitFor = async (fn, msg, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 150));
  }
};
async function login(context, user, quiet = false) {
  const page = await context.newPage();
  if (!quiet) {
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/401|409/.test(m.text()) && errors.push(m.text()));
  }
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.waitForSelector("form.login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', "rust-test-pw");
  await page.click("button.primary");
  await page.waitForSelector(".cards");
  return page;
}
const apiCall = (page, method, url, body) =>
  page.evaluate(async ([method, url, body]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch(url, { method, headers: { "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }, [method, url, body ?? null]);

let setId = 0;
let otherSet = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await login(ctx, "rt_teamadmin");
  const root = await login(await browser.newContext(), "aubreville", true);

  // ---------------------------------------------------------------------------------------- create
  const name = `e2e-set-${Date.now()}`;
  await page.locator("button", { hasText: "New image set" }).click();
  await page.waitForSelector(".modal");
  await page.fill('.modal input[maxlength="256"]', name);
  const products = await page.locator(".modal .check").count();
  if (products > 0) await page.locator(".modal .check input").first().check();
  await page.locator(".modal .btn.primary").click();
  await page.waitForURL(/\/sets\/\d+$/);
  setId = Number(page.url().split("/").pop());
  await waitFor(async () => (await page.locator(".toolbar h2").innerText().catch(() => "")) === name, `a new image set was created (${name}, id ${setId})`);
  console.log("ok  - a new image set was created:", name, setId);
  check((await page.locator(".empty").count()) === 1 && (await page.locator(".empty").innerText()).includes("Drop image files here"), "an empty set says how to fill it");
  await page.screenshot({ path: shots ? `${shots}/s1-empty.png` : undefined });

  // ---------------------------------------------------------------------------------------- upload
  await page.setInputFiles('input[type="file"]', files.slice(0, 2));
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 2, "two uploaded images appear in the grid");
  check((await page.locator(".upload.done").count()) === 2, "the upload list shows both as done");
  // a dropped file (drag and drop): dispatch the events with a DataTransfer
  const dropData = fs.readFileSync(files[2]).toString("base64");
  await page.evaluate(async ([b64, fname]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], fname, { type: "image/png" }));
    const target = document.querySelector("section.main");
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [dropData, path.basename(files[2])]);
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 3, "a dropped file is uploaded too");
  // the same file again: the server refuses a duplicate, the list says so
  await page.setInputFiles('input[type="file"]', [files[0]]);
  await waitFor(async () => (await page.locator(".upload.error").count()) === 1, "a duplicate is reported");
  check((await page.locator(".upload.error").innerText()).includes("already exists"), "...with the server's reason");
  await page.locator(".uploads .btn", { hasText: "Clear finished" }).click();
  check((await page.locator(".grid .tile").count()) === 3, "the grid still has three images");
  await page.screenshot({ path: shots ? `${shots}/s2-grid.png` : undefined });

  // ---------------------------------------------------------------------------------------- tags and products
  await page.fill(".tag-input", "E2E Tag");
  await page.press(".tag-input", "Enter");
  await waitFor(async () => (await page.locator(".tag", { hasText: "e2e_tag" }).count()) === 1, "a tag is added (cleaned like the old UI does)");
  await page.locator(".tag", { hasText: "e2e_tag" }).locator("button").click();
  await waitFor(async () => (await page.locator(".tag", { hasText: "e2e_tag" }).count()) === 0, "...and removed");
  const productChips = await page.locator(".tag.product").count();
  check(products === 0 || productChips >= 1, `the product chosen at creation is on the set (${productChips})`);

  // ---------------------------------------------------------------------------------------- filter, sort, select
  await page.fill(".search[placeholder^='Filter']", "img-2");
  check((await page.locator(".grid .tile").count()) === 1, "the filter narrows the grid");
  await page.fill(".search[placeholder^='Filter']", "");
  await page.locator(".tile", { hasText: "img-1" }).locator("input[type=checkbox]").check({ force: true });
  await page.locator(".tile", { hasText: "img-2" }).locator("input[type=checkbox]").check({ force: true });
  check((await page.locator(".toolbar strong", { hasText: "2 selected" }).count()) === 1, "two images can be selected");

  // ---------------------------------------------------------------------------------------- registration
  await page.locator("button", { hasText: "Register these two" }).click();
  await page.waitForSelector(".modal");
  await page.locator(".modal .check input").first().uncheck(); // no inverse yet: it is added by hand below
  await page.locator(".modal .btn.primary").click();
  await page.waitForSelector(".tabs button.active:has-text('Registration')");
  await waitFor(async () => (await page.locator(".job .badge.queued").count()) === 1, "the registration is queued for a worker");
  const job = (await apiCall(root, "GET", "/api/v2/registration-jobs")).body.items.find((j) => j.status === "queued");
  // a worker takes the job and delivers a result
  const claimed = await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch("/api/v2/registration-jobs/claim", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ worker: "e2e" }) });
    return r.status === 200 ? await r.json() : null;
  });
  check(claimed && claimed.id === job.id, "a worker claims the job");
  await waitFor(async () => (await page.locator(".job .badge.running").count()) === 1, "the page shows it as running (polling)");
  await root.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const fd = new FormData();
    fd.append("worker", "e2e");
    fd.append("transformation_matrix", JSON.stringify({ t_00: 2, t_01: 0, t_02: 10, t_10: 0, t_11: 2, t_12: 5, t_20: 0, t_21: 0, t_22: 1 }));
    fd.append("registration_error", "0.75");
    fd.append("runtime", "4");
    const r = await fetch(`/api/v2/registration-jobs/${id}/complete`, { method: "POST", headers: { "x-csrf-token": csrf }, body: fd });
    if (!r.ok) throw new Error("complete failed: " + r.status + " " + (await r.text()));
  }, job.id);
  await waitFor(async () => (await page.locator(".reg").count()) === 1, "the finished registration appears");
  const facts = await page.locator(".reg-facts").innerText();
  check(facts.includes("error 0.75") && facts.includes("scale 2.000") && facts.includes("rotation 0.0"), `...with its numbers (${facts.replace(/\s+/g, " ")})`);
  await page.locator(".reg .btn", { hasText: "Add inverse" }).click();
  await waitFor(async () => (await page.locator(".reg").count()) === 2, "Add inverse creates the registration the other way");
  check((await page.locator(".reg-facts").first().innerText()).includes("scale 0.500") || (await page.locator(".reg-facts").nth(1).innerText()).includes("scale 0.500"), "...with the inverse scale");
  await page.locator(".reg").first().locator(".btn.danger").click();
  await waitFor(async () => (await page.locator(".reg").count()) === 1, "a registration can be deleted");
  await page.screenshot({ path: shots ? `${shots}/s3-registration.png` : undefined });

  // ---------------------------------------------------------------------------------------- move
  otherSet = (await apiCall(root, "POST", "/api/v2/image-sets", { name: `e2e-target-${Date.now()}`, team: 1 })).body.id;
  await page.locator(".tabs button", { hasText: "Images" }).click();
  await page.locator(".toolbar .btn", { hasText: "Clear" }).click(); // the two images of the registration are still selected
  await page.locator(".tile", { hasText: "img-3" }).locator("input[type=checkbox]").check({ force: true });
  await page.locator(".toolbar .btn", { hasText: "Move" }).click();
  await page.waitForSelector(".modal");
  await waitFor(async () => (await page.locator(".modal select option").count()) >= 1, "the move dialog lists target sets");
  await page.locator(".modal select").selectOption({ value: String(otherSet) });
  await page.locator(".modal .btn.primary").click();
  await waitFor(async () => (await page.locator(".modal .results li").count()) >= 1, "the move answered");
  check((await page.locator(".modal .results li.ok").count()) === 1, `the image moved (${(await page.locator(".modal .results").innerText()).replace(/\s+/g, " ")})`);
  await page.locator(".modal .btn", { hasText: "Close" }).click();
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 2, "...and left this set");
  check((await apiCall(root, "GET", `/api/v2/images?image_set=${otherSet}`)).body.items.length >= 1, "the image is in the other set");

  // ---------------------------------------------------------------------------------------- delete images
  await page.locator(".tile", { hasText: "img-2" }).locator("input[type=checkbox]").check({ force: true });
  await page.locator(".toolbar .btn.danger", { hasText: "Delete" }).click();
  await page.waitForSelector(".modal");
  await page.locator(".modal .btn.danger").click();
  await waitFor(async () => (await page.locator(".modal .results li.ok").count()) === 1, "an image was deleted");
  await page.locator(".modal .btn", { hasText: "Close" }).click();
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 1, "...and is gone from the grid");

  // ---------------------------------------------------------------------------------------- settings and lock
  await page.locator(".toolbar .btn", { hasText: "Settings" }).click();
  await page.waitForSelector(".modal");
  await page.fill('.modal input[maxlength="256"]', name + " renamed");
  await page.fill(".modal textarea", "A set made by the browser test.");
  await page.locator(".modal .check", { hasText: "Lock the image set" }).locator("input").check();
  await page.locator(".modal .btn.primary").click();
  await waitFor(async () => (await page.locator(".toolbar h2").innerText().catch(() => "")) === name + " renamed", "the name changed");
  check((await page.locator(".badge.locked").count()) === 1 && (await page.locator("button", { hasText: "Upload images" }).count()) === 0, "a locked set shows its lock and offers no upload");
  check((await page.locator("p.muted", { hasText: "A set made by the browser test." }).count()) === 1, "the description is shown");
  await page.locator(".toolbar .btn", { hasText: "Settings" }).click();
  await page.locator(".modal .check", { hasText: "Lock the image set" }).locator("input").uncheck();
  await page.locator(".modal .btn.primary").click();
  await waitFor(async () => (await page.locator("button", { hasText: "Upload images" }).count()) === 1, "unlocking brings the upload back");

  // ---------------------------------------------------------------------------------------- delete the set
  await page.locator(".dropdown .trigger", { hasText: "More" }).click();
  await page.locator(".dd-item", { hasText: "Delete image set" }).click();
  await page.waitForSelector(".modal");
  const del = page.locator(".modal .btn.danger");
  check(await del.isDisabled(), "deleting the set needs its name typed");
  await page.fill(".modal input", name + " renamed");
  await del.click();
  await page.waitForURL(`${base}/`);
  setId = 0;
  check((await apiCall(root, "GET", `/api/v2/image-sets/${otherSet}`)).status === 200, "the other set is untouched");
  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  const cleaner = await login(await browser.newContext(), "aubreville", true).catch(() => null);
  for (const s of [setId, otherSet].filter(Boolean)) await cleaner?.evaluate(async (s) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    await fetch(`/api/v2/image-sets/${s}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  }, s);
  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();
}
