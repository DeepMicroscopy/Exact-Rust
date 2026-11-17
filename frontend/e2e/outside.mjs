// End-to-end test of the preference "Allow annotations outside the image": a box dragged from beyond the top-left corner is held at the edge
// (off) or keeps its negative coordinates (on). Makes its own image set. Usage: node e2e/outside.mjs [baseUrl]
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
  const setPref = (v) => page.evaluate(async (v) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    return (await fetch("/api/v2/me/preferences", { method: "PUT", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ allow_outside: v }) })).json();
  }, v);
  const drawBox = async () => {
    await openImage(page);
    await page.keyboard.press("1");
    // zoom out so that the area around the image is on screen
    const [a, b] = [await screenOf(page, -250, 1500), await screenOf(page, 700, 1900)];
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await waitFor(async () => (await annotations(page)).length > 0, "the box was saved");
    const all = await annotations(page);
    return all[all.length - 1].vector;
  };
  check((await setPref(false)).allow_outside === false, "preference off");
  const held = await drawBox();
  console.log("   vector with the preference off:", JSON.stringify(held));
  check(held.x1 === 0 && held.y1 >= 1490 && held.y1 <= 1510, "off: a box dragged from outside is held at the edge");
  await page.evaluate(async () => { const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token; for (const a of (await (await fetch(location.pathname.replace("/images/", "/api/v2/annotations?deleted=false&image="))).json()).items ?? []) await fetch(`/api/v2/annotations/${a.id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); });
  check((await setPref(true)).allow_outside === true, "preference on");
  await page.reload();
  const freed = await drawBox();
  console.log("   vector with the preference on:", JSON.stringify(freed));
  check(freed.x1 < -200 && freed.x1 > -300, "on: the box keeps its negative coordinates");
  // moving an existing box out of the image
  await page.keyboard.press("Escape");
  const [i0, i1] = [await screenOf(page, 600, 1500), await screenOf(page, 900, 1700)];
  await page.keyboard.press("1");
  await page.mouse.move(i0.x, i0.y);
  await page.mouse.down();
  await page.mouse.move(i1.x, i1.y, { steps: 8 });
  await page.mouse.up();
  await waitFor(async () => (await annotations(page)).length === 2, "a second box was saved");
  const inside = (await annotations(page)).find((a) => a.vector.x1 >= 590);
  check(!!inside, "the second box lies inside the image: " + JSON.stringify(inside?.vector));
  await page.keyboard.press("c"); // select mode
  const mid = await screenOf(page, 750, 1600);
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(300);
  const dest = await screenOf(page, 750 - 1200, 1600 - 100);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move((mid.x + dest.x) / 2, (mid.y + dest.y) / 2, { steps: 8 });
  await page.mouse.move(dest.x, dest.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const moved = (await annotations(page)).find((a) => a.id === inside.id);
  console.log("   vector of the moved box:", JSON.stringify(moved.vector), "screen to", Math.round(dest.x), Math.round(dest.y));
  check(moved.vector.x1 < -300, "on: a box can be moved out of the image (x1 " + moved.vector.x1 + ")");
  check(!errors.length, "no page errors: " + errors.join(" / "));
  await setPref(false);
  await page.evaluate(async (set) => { const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token; await fetch(`/api/v2/image-sets/${set}`, { method: "DELETE", headers: { "x-csrf-token": csrf } }); }, SET);
  console.log("done");
} finally {
  await browser.close();
}
