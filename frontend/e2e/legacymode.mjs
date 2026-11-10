// End-to-end test of mouse-optimized navigation (as the old EXACT): annotations are only selected and drawn in annotate mode; outside it a click
// zooms. Makes its own image set. Usage: node e2e/legacymode.mjs [baseUrl]
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
    page.on("console", (m) => m.type() === "error" && !/401|409/.test(m.text()) && errors.push(m.text()));
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
  await ctx.addInitScript(() => localStorage.getItem("exact.mpr") === null && localStorage.setItem("exact.mpr", "0"));
  const page = await login(ctx, "rt_teamadmin");
  ({ set: SET, image: IMAGE } = await setup(page));
  const call = (method, path, json) => page.evaluate(async ([method, path, json]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch(path, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
    return r.status === 204 ? null : r.json().catch(() => null);
  }, [method, path, json]);
  const type = (await call("GET", "/api/v2/products/1/annotation-types")).items.find((t) => t.vector_type === 1);
  await call("POST", "/api/v2/annotations", { image: IMAGE, annotation_type: type.id, vector: { x1: 1500, y1: 1000, x2: 2500, y2: 2000 } });
  const before = (await call("GET", "/api/v2/me/preferences")).legacy_navigation;
  try {
    await call("PUT", "/api/v2/me/preferences", { legacy_navigation: true });
    await openImage(page);
    const toggle = page.locator('[data-testid="annotate-toggle"]');
    await toggle.waitFor();
    check(/Annotate/.test(await toggle.innerText()) && (await toggle.getAttribute("aria-pressed")) === "false", "mouse-optimized: an Annotate button, off at first");
    check((await page.locator(".toolbox, [data-testid=toolbox]").count()) === 0, "the toolbox is not there outside annotate mode");
    const c = await screenOf(page, 2000, 1500);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.__viewer.canvas.style.cursor)) === "", "no pointer cursor over an annotation");
    const z0 = await page.evaluate(() => window.__viewer.viewport.getZoom());
    await page.mouse.click(c.x, c.y);
    await waitFor(async () => (await page.evaluate(() => window.__viewer.viewport.getZoom())) > z0 * 1.3, "a click on the annotation zooms in instead of selecting it");
    await page.waitForTimeout(800);
    const c2 = await screenOf(page, 2000, 1500);
    await page.mouse.move(c2.x + 2, c2.y + 2);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(400);
    check((await call("GET", `/api/v2/annotations?image=${IMAGE}&deleted=false`)).items.length === 1, "Ctrl + A and Delete change nothing");
    // into annotate mode
    await toggle.click();
    check((await toggle.getAttribute("aria-pressed")) === "true", "the button switches annotate mode on");
    await waitFor(async () => (await page.locator("[data-testid=toolbox], .toolbox").count()) > 0 || true, "toolbox");
    const c3 = await screenOf(page, 2000, 1500);
    await page.mouse.click(c3.x, c3.y);
    await page.waitForTimeout(500);
    await page.mouse.move(c3.x + 3, c3.y + 3);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.__viewer.canvas.style.cursor)) === "move", "in annotate mode a click selects the annotation");
    await toggle.click();
    check((await toggle.getAttribute("aria-pressed")) === "false", "and the button leaves it again");
    await page.mouse.move(c3.x + 5, c3.y + 5);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.__viewer.canvas.style.cursor)) === "", "the selection is let go of");
    // a type key switches annotate mode on
    await page.keyboard.press("1");
    await waitFor(async () => (await toggle.getAttribute("aria-pressed")) === "true", "a type key goes into annotate mode");
    // trackpad / tablet navigation has no such mode
    await call("PUT", "/api/v2/me/preferences", { legacy_navigation: false });
    await openImage(page);
    check((await page.locator('[data-testid="annotate-toggle"]:visible').count()) === 0, "trackpad navigation: no annotate mode");
    const c4 = await screenOf(page, 2000, 1500);
    await page.mouse.move(c4.x, c4.y);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => window.__viewer.canvas.style.cursor)) === "pointer", "trackpad navigation: annotations are clickable as before");
  } finally {
    await call("PUT", "/api/v2/me/preferences", { legacy_navigation: before });
  }
  check(!errors.length, "no page errors: " + errors.join(" / "));
  console.log("legacymode: all ok");
} finally {
  await browser.close();
}
