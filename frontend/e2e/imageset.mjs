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
  await waitFor(async () => (await page.locator('[data-testid="upload-tile"]').count()) === 0, "finished uploads have turned into ordinary cards");
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
  // the same file again: a dialog offers another name or cancelling
  await page.setInputFiles('input[type="file"]', [files[0]]);
  await page.waitForSelector(".modal input[aria-label='New name']");
  check((await page.locator(".modal").innerText()).includes(path.basename(files[0])), "a name clash opens a dialog naming the file");
  await page.locator(".modal .btn", { hasText: "Cancel upload" }).click();
  await page.waitForTimeout(500);
  check((await page.locator('[data-testid="upload-tile"]').count()) === 0 && (await page.locator(".grid .tile").count()) === 3, "cancelling uploads nothing");
  // ... or a new name: the card appears at once and shows progress
  await page.setInputFiles('input[type="file"]', [files[0]]);
  await page.waitForSelector(".modal input[aria-label='New name']");
  const renamed = `renamed-${Date.now()}.png`;
  await page.fill(".modal input[aria-label='New name']", renamed);
  await page.route("**/api/v2/image-sets/*/images", async (route) => {
    await new Promise((r) => setTimeout(r, 1500)); // slow enough to see the card
    await route.continue().catch(() => {});
  });
  await page.locator(".modal .btn.primary").click();
  await page.waitForSelector('[data-testid="upload-tile"] .ring');
  check((await page.locator('[data-testid="upload-tile"]').innerText()).includes(renamed), "an upload card with a progress ring appears at once");
  await page.unroute("**/api/v2/image-sets/*/images");
  await waitFor(async () => (await page.locator(".grid .tile:not(.upload-tile)", { hasText: renamed }).count()) === 1, "the file is uploaded under the new name");
  const extra = (await apiCall(root, "GET", `/api/v2/images?image_set=${setId}&fields=id,name&limit=100`)).body.items.find((i) => i.name.includes(renamed.replace(".png", "")));
  await apiCall(root, "DELETE", `/api/v2/images/${extra.id}`);
  await page.reload();
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 3, "the extra image is removed again");
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

  // ---------------------------------------------------------------------------------------- search across sets and images
  await page.goto(base);
  await page.waitForSelector(".cards");
  check((await page.locator(".side-item", { hasText: "All image sets" }).count()) === 0, "there is no 'All image sets' entry among the teams");
  await page.fill("input[aria-label=Search]", "IMG-2");
  await page.waitForSelector('[data-testid="image-hits"] .card');
  check((await page.locator('[data-testid="image-hits"] .card', { hasText: "img-2" }).count()) >= 1, "the search finds images (case-insensitive) as well as image sets");
  await page.fill("input[aria-label=Search]", name.slice(0, 12));
  await waitFor(async () => (await page.locator(".cards .card", { hasText: name }).count()) >= 1, "...and still finds image sets");
  await page.goto(`${base}/sets/${setId}`);
  await page.waitForSelector(".tabs");
  // ---------------------------------------------------------------------------------------- filter, sort, select
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 3, "the set page shows its three images");
  await page.fill(".search[placeholder^='Filter']", "img-2");
  await waitFor(async () => (await page.locator(".grid .tile").count()) === 1, "the filter narrows the grid");
  await page.fill(".search[placeholder^='Filter']", "");
  await page.locator(".tile", { hasText: "img-1" }).locator("input[type=checkbox]").check({ force: true });
  await page.locator(".tile", { hasText: "img-2" }).locator("input[type=checkbox]").check({ force: true });
  check((await page.locator(".toolbar strong", { hasText: "2 selected" }).count()) === 1, "two images can be selected");

  // ---------------------------------------------------------------------------------------- registration
  // an automatic registration needs a registration method: the one a worker announces
  await apiCall(root, "POST", "/api/v2/plugins/register", { name: "e2e registration", author: "e2e", package: "e2e", plugin_type: 2 });
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
  // an automatic registration has no points to show
  await page.locator(".reg .btn", { hasText: "Review" }).click();
  await page.waitForSelector(".reg-full .reg-full-actions");
  await page.waitForTimeout(500);
  check((await page.locator(".reg-full .btn", { hasText: "Edit the points" }).count()) === 0 && (await page.locator(".reg-full .btn", { hasText: "Pick points" }).count()) === 0, "reviewing an automatic registration offers no points");
  await page.locator('.reg-full [aria-label="Close"]').click();
  await page.locator(".reg .btn", { hasText: "Add inverse" }).click();
  await waitFor(async () => (await page.locator(".reg").count()) === 2, "Add inverse creates the registration the other way");
  check((await page.locator(".reg-facts").first().innerText()).includes("scale 0.500") || (await page.locator(".reg-facts").nth(1).innerText()).includes("scale 0.500"), "...with the inverse scale");
  await page.locator(".reg").first().locator(".btn.danger").click();
  await waitFor(async () => (await page.locator(".reg").count()) === 1, "a registration can be deleted");
  await page.screenshot({ path: shots ? `${shots}/s3-registration.png` : undefined });

  // ---------------------------------------------------------------------------------------- manual registration, overlay
  otherSet = (await apiCall(root, "POST", "/api/v2/image-sets", { name: `e2e-target-${Date.now()}`, team: 1 })).body.id;
  const setImages = (await apiCall(root, "GET", `/api/v2/images?image_set=${setId}&fields=id,name,width,height&limit=100`)).body.items;
  const [i1, i2, i3] = ["img-1", "img-2", "img-3"].map((n) => setImages.find((i) => i.name.includes(n)));
  // replace the registration of the pair by a manual one with scale 0.5 and a shift (20, 10): target = 0.5 * source + (20, 10)
  // two registration methods are registered: the dialog offers them with the parameters of the chosen one
  const methodA = (await apiCall(root, "POST", "/api/v2/plugins/register", { name: "E2E method A", package: "e2e_a", plugin_type: 2, parameters_schema: [{ name: "alpha", type: "int", label: "Alpha steps", default: 7, min: 1, max: 20 }] })).body;
  const methodB = (await apiCall(root, "POST", "/api/v2/plugins/register", { name: "E2E method B", package: "e2e_b", plugin_type: 2, parameters_schema: [{ name: "style", type: "choice", label: "Style", choices: ["quick", "slow"], default: "quick" }, { name: "sharp", type: "bool", label: "Sharp", default: false }] })).body;
  await page.locator("button", { hasText: "New registration" }).click();
  await page.waitForSelector(".modal");
  await page.waitForSelector('.modal select[aria-label="Registration method"]');
  const methods = await page.locator('.modal select[aria-label="Registration method"] option').allInnerTexts();
  check(methods.length >= 2 && methods.some((m) => m.includes("E2E method A")) && methods.some((m) => m.includes("(default)")), `the registration method can be chosen (${methods.join(" | ")})`);
  await page.selectOption('.modal select[aria-label="Registration method"]', { label: "E2E method B" });
  await page.locator(".modal .btn", { hasText: "Parameters" }).click();
  check((await page.locator('.modal select[aria-label="Style"]').count()) === 1 && (await page.locator('.modal input[aria-label="Sharp"]').count()) === 1 && (await page.locator('.modal input[aria-label="Alpha steps"]').count()) === 0, "the parameters of the chosen method are offered");
  await apiCall(root, "DELETE", `/api/v2/plugins/${methodA.id}`);
  await apiCall(root, "DELETE", `/api/v2/plugins/${methodB.id}`);
  await page.locator('.modal [role=radiogroup][aria-label="Source image"] [role=radio]', { hasText: "img-1" }).click();
  check((await page.locator('.modal [role=radiogroup][aria-label="Source image"] .thumb').count()) >= 2, "images are chosen by their previews");
  const setOptions = await page.locator('.modal select[aria-label="Target image set"] option').allInnerTexts();
  check(setOptions.length >= 2, `the target image set can be chosen (${setOptions.join(" | ")})`);
  await page.locator('.modal [role=radiogroup][aria-label="Target image"] [role=radio]', { hasText: "img-2" }).click();
  await page.locator('.modal [role=radio]', { hasText: "Manual" }).click();
  await page.locator(".modal .btn.primary", { hasText: "Pick points" }).click();
  await page.waitForSelector('[data-testid="reg-viewer-source"] canvas');
  await page.waitForSelector('[data-testid="reg-viewer-target"] canvas');
  await waitFor(() => page.evaluate(() => window.__reg_source?.world.getItemCount() && window.__reg_target?.world.getItemCount()), "both images are shown for picking");
  await page.waitForTimeout(800);
  const box = await page.locator('[data-testid="reg-viewer-source"]').boundingBox();
  check(box.height > 500, `manual registration uses the whole screen (${Math.round(box.height)} px high)`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  check((await page.locator('[data-testid="crosshair-source"]').count()) === 1, "a crosshair follows the pointer in the viewer that takes the next point");
  const spot = (which, x, y) =>
    page.evaluate(([which, x, y]) => {
      const v = window["__reg_" + which];
      const p = v.world.getItemAt(0).imageToViewerElementCoordinates(new window.__osd.Point(x, y));
      const r = v.element.getBoundingClientRect();
      return [r.left + p.x, r.top + p.y];
    }, [which, x, y]);
  const pts = [[0.2, 0.2], [0.8, 0.25], [0.5, 0.8]];
  for (const [fx, fy] of pts) {
    const [sx, sy] = [fx * i1.width, fy * i1.height];
    const [a, b] = await spot("source", sx, sy);
    await page.mouse.click(a, b);
    const [c, d] = await spot("target", sx * 0.5 + 20, sy * 0.5 + 10);
    await page.mouse.click(c, d);
  }
  check((await page.locator(".reg-pairs .chip").count()) === 3, "three point pairs were picked");
  await page.locator(".reg-full .btn.primary", { hasText: "Save registration" }).click();
  await page.waitForSelector('[data-testid="manual-saved"]');
  const saved = await page.locator('[data-testid="manual-saved"]').innerText();
  check((await page.locator(".reg-full h2").innerText()) === "Check the registration", "after picking points the screen asks to check the result");
  const err = Number(/error ([\d.]+)/.exec(saved)?.[1]);
  check(err < 3, `the manual registration is saved with a small error (${saved})`);
  await page.waitForSelector('[data-testid="reg-check"] canvas', { timeout: 8000 }).catch(async (e) => {
    await page.screenshot({ path: "/tmp/shots/reg-check-fail.png" });
    console.log("DEBUG", await page.evaluate(() => JSON.stringify({ el: document.querySelector('[data-testid="reg-check"]')?.getBoundingClientRect(), err: document.querySelector(".reg-check-bar")?.innerText, items: window.__reg_check?.world.getItemCount() })));
    throw e;
  });
  await waitFor(() => page.evaluate(() => window.__reg_check?.world.getItemCount() >= 2), "after saving, the source is laid over the target for checking");
  await waitFor(async () => (await page.locator('[data-testid="check-loading"]').count()) === 0, "...and its loading indicator goes away");
  await page.locator(".reg-full .btn", { hasText: "Edit the points" }).click();
  check((await page.locator(".reg-pairs .chip").count()) === 3, "the points can be edited after the check");
  await page.locator(".reg-full .btn", { hasText: "Back to the overlay" }).click();
  await page.locator(".reg-full .btn", { hasText: "Close" }).click();
  const regs = (await apiCall(root, "GET", `/api/v2/registrations?source_image=${i1.id}&target_image=${i2.id}`)).body.items;
  check(regs.length === 1 && Math.abs(regs[0].transformation_matrix.t_00 - 0.5) < 0.02 && Math.abs(regs[0].transformation_matrix.t_02 - 20) < 8, "the stored matrix has the picked scale and shift");
  await page.locator(".reg", { hasText: "img-1" }).first().locator(".btn", { hasText: "Review" }).click();
  await page.waitForSelector('[data-testid="reg-check"] canvas', { timeout: 8000 }).catch(async (e) => {
    await page.screenshot({ path: "/tmp/shots/review-fail.png" });
    console.log("DEBUG", await page.evaluate(() => JSON.stringify({ html: document.querySelector(".reg-full")?.innerText.slice(0, 400), items: window.__reg_check?.world.getItemCount() })));
    throw e;
  });
  check((await page.locator('[data-testid="manual-saved"]').count()) === 0, "a registration can be reviewed from the list");
  check((await page.locator(".reg-full h2").innerText()) === "Review registration", "the screen of a review is titled as a review, not as manual registration");
  await page.locator(".reg-full .btn", { hasText: "Edit the points" }).click();
  await waitFor(async () => (await page.locator(".reg-pairs .chip").count()) === 3, "a manual registration shows its stored points when reopened");
  await page.locator(".reg-full > header .btn").click();
  // the viewer of img-1 offers img-2 as an overlay, placed through the inverse
  await page.goto(`${base}/images/${i1.id}`);
  await page.waitForSelector('[data-testid="overlay-control"]');
  await page.selectOption("#overlay-pick", String(i2.id));
  await waitFor(() => page.evaluate(() => window.__overlay && window.__viewer.world.getItemCount() >= 2), "the overlay image is added");
  await waitFor(async () => (await page.locator('[data-testid="overlay-loading"]').count()) === 0, "the loading indicator of the overlay goes away when it is drawn");
  const placed = await page.evaluate(() => {
    const v = window.__viewer;
    const top = v.world.getItemAt(v.world.getItemCount() - 1);
    const base = v.world.getItemAt(0);
    const o = top.imageToViewportCoordinates(0, 0);
    const b = base.viewportToImageCoordinates(o); // where the overlay's corner lies in the pixels of the current image
    return [b.x, b.y, top.getOpacity()];
  });
  const mm = regs[0].transformation_matrix;
  const want = [(0 - mm.t_02) / mm.t_00, (0 - mm.t_12) / mm.t_11];
  check(Math.abs(placed[0] - want[0]) < 2 && Math.abs(placed[1] - want[1]) < 2, `the overlay is placed by the inverse registration (${placed.map((v) => v.toFixed(1))} vs ${want.map((v) => v.toFixed(1))})`);
  await page.locator('[data-testid="overlay-control"] input[type=range]').fill("0.8");
  await waitFor(() => page.evaluate(() => Math.abs(window.__overlay && window.__viewer.world.getItemAt(window.__viewer.world.getItemCount() - 1).getOpacity() - 0.8) < 0.01), "the opacity slider works");
  await page.selectOption("#overlay-pick", "");
  await waitFor(() => page.evaluate(() => window.__viewer.world.getItemCount() === 1), "choosing none removes the overlay");
  // an image without registration has no overlay control
  await page.goto(`${base}/images/${i3.id}`);
  await page.waitForSelector(".viewer-bar");
  await page.waitForTimeout(800);
  check((await page.locator('[data-testid="overlay-control"]').count()) === 0, "an image without registrations shows no overlay control");
  await page.goto(`${base}/sets/${setId}`);
  await page.waitForSelector(".tabs");
  await page.locator(".tile", { hasText: "img-1" }).locator("input[type=checkbox]").check({ force: true });
  // ---------------------------------------------------------------------------------------- export
  await page.locator(".toolbar .btn", { hasText: "Export" }).click();
  await page.locator(".modal .btn", { hasText: "New format" }).click();
  await page.waitForSelector('input[aria-label="Format name"]');
  const fname = `e2e ${String(Date.now()).slice(-8)}`;
  await page.fill('input[aria-label="Format name"]', fname);
  check(await page.locator('.modal button.primary', { hasText: "Save format" }).isDisabled(), "a format needs an annotation type");
  await page.locator(".type-pick label").first().click();
  await page.fill('textarea[aria-label="Per annotation"]', "%%imagename;%%type;%%width");
  await page.locator('.modal button.primary', { hasText: "Save format" }).click();
  await page.waitForSelector('select[aria-label="Export format"]');
  check((await page.locator('select[aria-label="Export format"] option:checked').innerText()).includes(fname), "a format made in the editor is offered and chosen");
  await page.locator(".modal .btn.primary", { hasText: "Create export" }).click();
  await waitFor(async () => (await page.locator('[data-testid="exports"] a').count()) === 1, "an export is created and listed");
  check((await page.locator('[data-testid="exports"] a').getAttribute("href")).includes("/download"), "...with a download link");
  await page.locator(".modal .btn", { hasText: "Edit format" }).click();
  await page.waitForSelector('textarea[aria-label="Per annotation"]');
  check((await page.inputValue('textarea[aria-label="Per annotation"]')) === "%%imagename;%%type;%%width", "the editor shows the stored format");
  await page.locator('.modal button.primary', { hasText: "Save format" }).click();
  await page.waitForSelector('select[aria-label="Export format"]');
  await page.locator(".modal .btn", { hasText: "Delete format" }).click();
  await waitFor(async () => (await page.locator('select[aria-label="Export format"] option', { hasText: fname }).count()) === 0, "a format can be deleted");
  await page.locator(".modal .btn", { hasText: "Close" }).last().click();

  // ---------------------------------------------------------------------------------------- move
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
