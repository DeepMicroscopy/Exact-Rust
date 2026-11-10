// End-to-end test of the right-click menu of an annotation type in the viewer: not clickable for now (dashed + hatched, greyed row with a
// tooltip, no selecting) and a permanent colour change. Makes its own image set. Usage: node e2e/typemenu.mjs [baseUrl]
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
  const page = await login(ctx, "aubreville");
  ({ set: SET, image: IMAGE } = await setup(page));
  // one box of the first type in the middle of the image
  const typeId = await page.evaluate(async (img) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const types = (await (await fetch("/api/v2/annotation-types?limit=500")).json()).items.filter((t) => t.product === 1 && t.vector_type === 1);
    const t = types[0];
    await fetch("/api/v2/annotations", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ image: img, annotation_type: t.id, vector: { x1: 1500, y1: 1000, x2: 2500, y2: 2000 } }) });
    return t.id;
  }, IMAGE);
  await openImage(page);
  const row = page.locator('[data-testid="type-row"]').first();
  await row.waitFor();
  check((await row.getAttribute("data-locked")) === "0", "the type is clickable at first");
  const click = async () => {
    const c = await screenOf(page, 2000, 1500);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(300);
    return page.locator(".anno-info, [data-testid=annotation-info], .info-panel").count();
  };
  await row.locator(".type-name").click();
  check(!(await row.locator('input[type="checkbox"]').isChecked()), "a plain click still switches the type off");
  await row.locator(".type-name").click();
  check(await row.locator('input[type="checkbox"]').isChecked(), "and on again");
  // right click on the row: the menu
  await row.click({ button: "right" });
  await page.waitForSelector('[data-testid="type-menu"]');
  check(await row.locator('input[type="checkbox"]').isChecked(), "a right click does not switch the type off");
  await page.keyboard.press("Escape");
  await row.click({ modifiers: ["Control"] });
  check(await row.locator('input[type="checkbox"]').isChecked(), "a Ctrl + click does not switch the type off either");
  await page.keyboard.press("Escape");
  await row.click({ button: "right" });
  await page.locator('[data-testid="type-lock"]').click();
  check((await row.getAttribute("data-locked")) === "1", "the row is marked locked");
  check(/not clickable/i.test((await row.getAttribute("title")) ?? ""), "the tooltip says that the type is currently not clickable");
  const nameColor = await row.locator(".type-name").evaluate((e) => getComputedStyle(e).opacity);
  check(Number(nameColor) < 1, "the text is greyed out");
  // a click on the box does not select it any more: the cursor over it is not a pointer
  const c = await screenOf(page, 2000, 1500);
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(200);
  const cursorLocked = await page.evaluate(() => window.__viewer.canvas.style.cursor);
  console.log("   cursor over the locked box:", cursorLocked);
  check(cursorLocked !== "pointer" && cursorLocked !== "move", "the locked box does not react to the pointer");
  if (shots) await page.screenshot({ path: `${shots}/typemenu-locked.png` });
  // and again clickable
  await row.click({ button: "right" });
  await page.locator('[data-testid="type-lock"]').click();
  check((await row.getAttribute("data-locked")) === "0", "clickable again");
  await page.mouse.move(c.x + 3, c.y + 3);
  await page.waitForTimeout(200);
  const cursorOn = await page.evaluate(() => window.__viewer.canvas.style.cursor);
  check(cursorOn === "pointer", "clickable: the pointer cursor over the box (" + cursorOn + ")");
  // colour
  const before = await page.evaluate(async (t) => (await (await fetch(`/api/v2/annotation-types/${t}`)).json()).color_code, typeId);
  await row.click({ button: "right" });
  const want = before.toLowerCase() === "#e6194b" ? "#4363d8" : "#e6194b";
  await page.locator(`[data-testid="type-color"][aria-label="Colour ${want}"]`).click();
  await waitFor(async () => (await page.evaluate(async (t) => (await (await fetch(`/api/v2/annotation-types/${t}`)).json()).color_code, typeId)).toLowerCase() === want, "the colour was saved on the type");
  await waitFor(async () => (await row.locator(".swatch").evaluate((e) => getComputedStyle(e).backgroundColor)) !== "", "the swatch follows");
  // put it back
  await page.evaluate(async ([t, c]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    await fetch(`/api/v2/annotation-types/${t}`, { method: "PATCH", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ color_code: c }) });
  }, [typeId, before]);
  check(!errors.length, "no page errors: " + errors.join(" / "));
  console.log("typemenu: all ok");
} finally {
  await browser.close();
}
