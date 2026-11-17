// End-to-end test: a screening window is shown above the toolbox, so that the lower edge of the window is not hidden by it.
// Makes its own image set. Usage: node e2e/screeningview.mjs [baseUrl]
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
  await page.evaluate(() => localStorage.removeItem("exact.screening"));
  await openImage(page);
  await page.waitForSelector(".toolbox");
  await page.locator('[data-testid="screening-toggle"]').click();
  await page.waitForSelector('[data-testid="screening-start"]');
  await page.locator('[data-testid="screening-w"]').fill("2000");
  await page.locator('[data-testid="screening-h"]').fill("1500");
  await page.locator('[data-testid="screening-overlap"]').fill("0");
  await page.locator('[data-testid="screening-start"]').click();
  await page.waitForSelector('[data-testid="screening-map"]');
  const state = () => page.evaluate(async (id) => {
    const m = await (await fetch(`/api/v2/images/${id}/screening`)).json();
    const t = m.screening_tiles[String(m.current_index)];
    const item = window.__viewer.world.getItemAt(0);
    const r = window.__viewer.canvas.getBoundingClientRect();
    const br = item.imageToViewerElementCoordinates(new window.__osd.Point(t.x_max, t.y_max));
    const tr = item.imageToViewerElementCoordinates(new window.__osd.Point(t.x_min, t.y_min));
    return { bottom: r.top + br.y, top: r.top + tr.y, tool: document.querySelector(".toolbox").getBoundingClientRect().top, idx: m.current_index };
  }, IMAGE);
  for (const [label, key] of [["the first window", null], ["the window below", "s"], ["the window to the right", "d"]]) {
    if (key) await page.keyboard.press(key);
    await page.waitForTimeout(1500);
    const st = await state();
    console.log("  ", label, JSON.stringify(st));
    check(st.bottom <= st.tool + 1, `${label}: its lower edge (${Math.round(st.bottom)}) is above the toolbox (${Math.round(st.tool)})`);
  }
  check(!errors.length, "no page errors: " + errors.join(" / "));
  console.log("screeningview: all ok");
} finally {
  await browser.close();
}
