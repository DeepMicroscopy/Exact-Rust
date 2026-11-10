// End-to-end test: deleting an annotation type lists what it is still tied to; deleted annotations go for good after a warning.
// Makes its own image set and type. Usage: node e2e/deletetype.mjs [baseUrl]
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
let IMAGE = 0; // an image uploaded for the test into a new image set of team 1 (product 1: bounding box, 2.25 mm and 3 mm fixed-size types)
let SET = 0;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};

async function login(context, user, { quiet = false } = {}) {
  const page = await context.newPage();
  if (!quiet) {
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/401|404|409/.test(m.text()) && errors.push(m.text()));
  }
  await page.goto(base);
  await page.waitForSelector("form.login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', "rust-test-pw");
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  return page;
}

const annotations = (page) => page.evaluate(async (id) => (await (await fetch(`/api/v2/annotations?image=${id}&deleted=false&limit=1000`)).json()).items, IMAGE);

/** A fresh 4000 x 3000 image in a new image set of team 1 with product 1, so that no earlier annotations are in the way. */
async function setup(page) {
  return page.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const h = { "x-csrf-token": csrf };
    const set = await (await fetch("/api/v2/image-sets", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ name: `e2e-${Date.now()}`, team: 1 }) })).json();
    await fetch(`/api/v2/image-sets/${set.id}/products/1`, { method: "PUT", headers: h });
    const c = document.createElement("canvas");
    c.width = 4000;
    c.height = 3000;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 4000, 3000);
    grad.addColorStop(0, "#5a4a7a");
    grad.addColorStop(1, "#c9a27a");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4000, 3000);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.5)`;
      g.beginPath();
      g.arc((i * 733) % 4000, (i * 457) % 3000, 20 + (i % 40), 0, 7);
      g.fill();
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const fd = new FormData();
    fd.append("file", blob, `e2e-${Date.now()}.png`);
    const up = await (await fetch(`/api/v2/image-sets/${set.id}/images`, { method: "POST", headers: h, body: fd })).json();
    return { set: set.id, image: up.items[0].id };
  });
}
/** Picks a type in the drop-down of the tools (click, or tap on touch screens). */
async function pickType(page, name, touch = false) {
  const act = (l) => (touch ? l.tap() : l.click());
  await act(page.locator(".type-dd .trigger"));
  await act(page.locator(".type-dd .dd-item", { hasText: name }).first());
}
const waitFor = async (fn, msg, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 120));
  }
};

/** Screen position of an image pixel. */
const screenOf = (page, x, y) =>
  page.evaluate(([x, y]) => {
    const v = window.__viewer;
    const item = v.world.getItemAt(0);
    const p = item.imageToViewerElementCoordinates(new window.__osd.Point(x, y));
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [x, y]);

async function openImage(page) {
  await page.goto(`${base}/images/${IMAGE}`);
  await page.waitForSelector(".viewer-body .osd");
  await waitFor(() => page.evaluate(() => window.__viewer?.world.getItemCount() > 0), "viewer opened the image");
  await page.waitForTimeout(1200);
}


try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  const page = await login(ctx, "aubreville");
  ({ set: SET, image: IMAGE } = await setup(page));
  const api = (method, path, json) => page.evaluate(async ([method, path, json]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch(path, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }, [method, path, json]);
  const name = `e2e-del-${Date.now()}`;
  const t = (await api("POST", "/api/v2/annotation-types", { name, vector_type: 1, product: 1, color_code: "#33aa55" })).body;
  const mk = async () => (await api("POST", "/api/v2/annotations", { image: IMAGE, annotation_type: t.id, vector: { x1: 10, y1: 10, x2: 50, y2: 50 } })).body.id;
  const live = await mk();
  const gone = await mk();
  await api("DELETE", `/api/v2/annotations/${gone}`);
  await page.goto(`${base}/admin`);
  await page.locator(".tabs button", { hasText: "Products" }).click();
  await page.locator(".tree-leaf", { hasText: /./ }).first().waitFor();
  const openDialog = async () => {
    // the product of the type
    const leaves = page.locator(".tree-leaf");
    for (let i = 0; i < (await leaves.count()); i++) {
      await leaves.nth(i).click();
      if ((await page.locator("tr", { hasText: name }).count()) > 0) break;
    }
    await page.locator("tr", { hasText: name }).locator('[data-testid="type-delete"]').click();
    await page.waitForSelector('[data-testid="delete-type"]');
    await waitFor(async () => (await page.locator('[data-testid="delete-type-places"]').count()) === 1, "the dialog lists the places");
  };
  await openDialog();
  const text = await page.locator('[data-testid="delete-type"]').innerText();
  check(/1 annotation/.test(text) && /1 deleted annotation/.test(text), "the dialog counts the annotations and the deleted ones: " + text.replace(/\n/g, " | ").slice(0, 200));
  check((await page.locator('[data-testid="delete-type-places"] a').count()) === 1, "it names the image with a link");
  check((await page.locator('[data-testid="delete-type-go"]').count()) === 0, "a live annotation blocks the deletion: no delete button");
  await page.locator(".modal .btn", { hasText: "Close" }).click();
  await api("DELETE", `/api/v2/annotations/${live}`);
  await page.reload();
  await page.locator(".tabs button", { hasText: "Products" }).click();
  await page.locator(".tree-leaf").first().waitFor();
  await openDialog();
  check((await page.locator('[data-testid="delete-type-warning"]').count()) === 1, "with only deleted annotations a warning about the consequences is shown");
  check(await page.locator('[data-testid="delete-type-go"]').isDisabled(), "the delete button waits for the confirmation");
  await page.locator('[data-testid="delete-type-ack"]').check();
  if (shots) await page.screenshot({ path: `${shots}/delete-type.png` });
  await page.locator('[data-testid="delete-type-go"]').click();
  await waitFor(async () => (await api("GET", `/api/v2/annotation-types/${t.id}`)).status === 404, "the type is gone");
  check((await api("GET", `/api/v2/annotations/${gone}`)).status === 404, "and the deleted annotation with it");
  check(!errors.length, "no page errors: " + errors.join(" / "));
  console.log("deletetype: all ok");
} finally {
  await browser.close();
}
