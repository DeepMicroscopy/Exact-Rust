// End-to-end test of the annotation tools in the system Chrome: draw, select, move, resize, polygon editing, undo / redo,
// one-click mode, shortcuts, touch (tablet) and the phone layout. Needs a freshly restored scratch database.
// Usage: node e2e/annotate.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
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
  // ---------------------------------------------------------------------------------------- desktop: mouse and keyboard
  const desktop = await browser.newContext({ viewport: { width: 1400, height: 850 } });
  await desktop.addInitScript(() => localStorage.getItem("exact.mpr") === null && localStorage.setItem("exact.mpr", "0")); // volumes open in one plane here: the tools are there
  // a polygon type for product 1, created by the superuser (the toolbox offers the types of the set's products)
  const root = await login(await browser.newContext(), "aubreville", { quiet: true }); // may answer 400: the type exists from an earlier run
  await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch("/api/v2/annotation-types", {
      method: "POST",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e polygon", vector_type: 5, color_code: "#22aa44", product: 1, sort_order: 9 }),
    });
    if (!r.ok && !(await r.text()).includes("exists")) throw new Error("cannot create the polygon type");
    const m = await fetch("/api/v2/annotation-types", {
      method: "POST",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e mask", vector_type: 8, color_code: "#ff2a8a", product: 1, sort_order: 10 }),
    });
    if (!m.ok && !(await m.text()).includes("exists")) throw new Error("cannot create the mask type");
  });
  const admin = await login(desktop, "rt_teamadmin");
  ({ set: SET, image: IMAGE } = await setup(admin));
  await openImage(admin);
  const before = (await annotations(admin)).length;
  await admin.locator(".type-dd .trigger").click();
  const chips = await admin.locator(".type-dd .dd-item").allInnerTexts();
  check(chips.length >= 4 && chips.some((c) => c.includes("e2e polygon")) && chips.some((c) => c.includes("2.25mm")), `the type drop-down offers the types of the set (${chips.join(" | ").replace(/\n/g, " ")})`);
  check((await admin.locator(".type-dd .dd-item kbd").allInnerTexts()).join("") === "1234", "...with their digit keys");
  await admin.keyboard.press("Escape");
  check((await admin.locator(".type-dd .dd-pop").count()) === 0, "Escape closes the drop-down");
  check((await admin.locator(".toolbox").boundingBox()).height < 80, "the tool bar is a single row");

  // an Apple Pencil is tracked twice by OpenSeadragon (hovering and touching have different ids): the stroke must still follow the pen
  await admin.keyboard.press("1");
  const [pa, pb] = [await screenOf(admin, 800, 900), await screenOf(admin, 1800, 1700)];
  const penBefore = (await annotations(admin)).length;
  await admin.evaluate(({ a, b }) => {
    const el = document.querySelector(".openseadragon-canvas");
    const fire = (type, id, x, y, buttons, pressure) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, buttons, pressure, button: type === "pointerdown" || type === "pointerup" ? 0 : -1 }));
    fire("pointerover", 5, a.x, a.y, 0, 0);
    fire("pointerenter", 5, a.x, a.y, 0, 0);
    for (let i = 0; i < 3; i++) fire("pointermove", 5, a.x + i, a.y + i, 0, 0);
    fire("pointerdown", 7, a.x, a.y, 1, 0.5);
    for (let i = 1; i <= 10; i++) fire("pointermove", 7, a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10, 1, 0.5);
    fire("pointerup", 7, b.x, b.y, 0, 0);
  }, { a: pa, b: pb });
  await waitFor(async () => (await annotations(admin)).length === penBefore + 1, "a pen stroke creates a box...");
  const penBox = (await annotations(admin)).sort((x, y) => y.id - x.id)[0].vector;
  check(penBox.x2 - penBox.x1 > 700 && penBox.y2 - penBox.y1 > 500, `...as large as the stroke, not stuck at its start (${penBox.x2 - penBox.x1} x ${penBox.y2 - penBox.y1} px)`);
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).length === penBefore, "...and undo removes it again");
  await admin.keyboard.press("Escape");
  // a pen is set down on the point it means and rests there: OpenSeadragon calls a press of over 300 ms no click, the polygon must take it
  await pickType(admin, "e2e polygon");
  const penPoly = [await screenOf(admin, 800, 900), await screenOf(admin, 1400, 950), await screenOf(admin, 1350, 1500), await screenOf(admin, 850, 1450)];
  const penCdp = await admin.context().newCDPSession(admin);
  for (const q of penPoly) {
    const e = { x: q.x, y: q.y, pointerType: "pen", button: "left" };
    await penCdp.send("Input.dispatchMouseEvent", { ...e, type: "mouseMoved", buttons: 0 });
    await penCdp.send("Input.dispatchMouseEvent", { ...e, type: "mousePressed", buttons: 1, clickCount: 1, force: 0.5 });
    await admin.waitForTimeout(600);
    await penCdp.send("Input.dispatchMouseEvent", { ...e, type: "mouseReleased", buttons: 0, clickCount: 1 });
    await admin.waitForTimeout(200);
  }
  check((await admin.evaluate(() => window.__editor.draftPoints)) === 4, "slow pen taps (600 ms) place the four polygon points");
  await admin.locator(".toolbox .btn", { hasText: "Finish" }).first().click();
  await waitFor(async () => (await annotations(admin)).length === penBefore + 1, "...and Finish saves the polygon");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).length === penBefore, "...(undone again)");
  await openImage(admin); // forget that a pen was seen: the checks below start without one

  // draw a bounding box with key 1 and a drag
  await admin.keyboard.press("1");
  check((await admin.locator(".toolbox .seg button.active, .toolbox .annotate-btn.active .annotate-label").getAttribute("aria-label")) === "Annotate with", "digit 1 enters the draw tool");
  check((await admin.locator(".toolbox .hint").first().innerText()).includes("Drag to draw a box"), "hint tells how to draw the box");
  const [a, b] = [await screenOf(admin, 800, 900), await screenOf(admin, 1300, 1300)];
  await admin.mouse.move(a.x, a.y);
  await admin.mouse.down();
  await admin.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await admin.mouse.move(b.x, b.y, { steps: 5 });
  await admin.mouse.up();
  let list = await waitFor(async () => ((await annotations(admin)).length === before + 1 ? await annotations(admin) : null), "the box was saved");
  const box = list.at(-1);
  check(Math.abs(box.vector.x1 - 800) < 12 && Math.abs(box.vector.y2 - 1300) < 12 && box.verified_by_user === false, `box drawn by drag (${JSON.stringify(box.vector)}); writing does not verify it`);
  await admin.screenshot({ path: shots ? `${shots}/a1-drawn.png` : undefined });

  // click selects it; a handle resizes, the body moves
  await admin.keyboard.press("c");
  check((await admin.locator(".toolbox .seg button.active, .toolbox .annotate-btn.active .annotate-label").getAttribute("aria-label")) === "Select", "C returns to the select tool");
  // the tools are exclusive: select, select several, annotate
  const on = () => admin.locator('.toolbox [aria-pressed="true"][aria-label="Select"], .toolbox [aria-pressed="true"][aria-label="Select several"], .toolbox [aria-pressed="true"][aria-label="Annotate with"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check(JSON.stringify(await on()) === '["Select"]', "only Select is on after C");
  check((await admin.locator('.toolbox [aria-label="Select several"]').count()) === 0, "no separate Select several tool with a mouse: a frame drawn in Select selects");
  await admin.keyboard.press("c");
  check(JSON.stringify(await on()) === '["Annotate with"]', "C turns annotating on");
  await admin.locator('.toolbox .annotate-label').click();
  check(JSON.stringify(await on()) === '["Select"]', "clicking Annotate with while annotating goes back to Select");
  await admin.keyboard.press("c");
  await admin.keyboard.press("c");
  check(JSON.stringify(await on()) === '["Select"]', "C twice toggles annotating off again");
  // pen: hovering is detected, and once a pen was used fingers no longer draw
  check((await admin.locator(".pen-only").count()) === 0, "no pen switch before a pen was seen");
  const hoverAt = await screenOf(admin, 1000, 1100);
  await admin.evaluate(({ x, y }) => window.__viewer.canvas.dispatchEvent(new PointerEvent("pointermove", { pointerType: "pen", pressure: 0, buttons: 0, clientX: x, clientY: y, bubbles: true })), hoverAt);
  await waitFor(() => admin.evaluate(() => window.__editor.penAt !== null), "a hovering pen is detected");
  check((await admin.locator(".pen-only").innerText()).includes("Pen only"), "the pen switch appears once a pen was seen");
  await admin.evaluate(({ x, y }) => window.__viewer.canvas.dispatchEvent(new PointerEvent("pointermove", { pointerType: "pen", pressure: 0.5, buttons: 1, clientX: x, clientY: y, bubbles: true })), hoverAt);
  check(await admin.evaluate(() => window.__editor.penAt === null), "a pen that touches is no longer hovering");
  await admin.evaluate(({ x, y }) => window.__viewer.canvas.dispatchEvent(new PointerEvent("pointermove", { pointerType: "pen", pressure: 0, buttons: 0, clientX: x, clientY: y, bubbles: true })), hoverAt);
  await admin.evaluate(() => window.__viewer.canvas.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "pen" })));
  check(await admin.evaluate(() => window.__editor.penAt === null), "a pen leaving the screen ends the hover");
  await admin.locator(".pen-only").click();
  check((await admin.locator(".pen-only").innerText()).includes("Pen + touch"), "the pen switch can let fingers draw too");
  await admin.locator(".pen-only").click();
  const inside = await screenOf(admin, 1000, 1100);
  await admin.mouse.click(inside.x, inside.y);
  await waitFor(() => admin.evaluate((id) => window.__editor.selectedId === id, box.id), "clicking the box selects it");
  check((await admin.locator(".toolbox .selection").count()) === 1 && (await admin.locator(".toolbox .selection .btn.danger").count()) === 1, "the toolbox shows the tools of a selected annotation");
  const area0 = (box.vector.x2 - box.vector.x1) * (box.vector.y2 - box.vector.y1);
  check((await admin.locator(".toolbox .measure").innerText()) === `${area0.toLocaleString("en-US")} px²`, `the selected box shows its area (${area0.toLocaleString("en-US")} px², the image has no resolution)`);
  const se = await screenOf(admin, box.vector.x2, box.vector.y2);
  const to = await screenOf(admin, box.vector.x2 + 200, box.vector.y2 + 100);
  await admin.mouse.move(se.x, se.y);
  await admin.mouse.down();
  await admin.mouse.move(to.x, to.y, { steps: 8 });
  await admin.mouse.up();
  let cur = await waitFor(async () => ((await annotations(admin)).find((x) => x.id === box.id).vector.x2 > box.vector.x2 + 150 ? (await annotations(admin)).find((x) => x.id === box.id) : null), "resize saved");
  const area1 = (cur.vector.x2 - cur.vector.x1) * (cur.vector.y2 - cur.vector.y1);
  await waitFor(async () => (await admin.locator(".toolbox .measure").innerText()) === `${area1.toLocaleString("en-US")} px²`, "the area follows the resize");
  check(cur.vector.x1 === box.vector.x1 && Math.abs(cur.vector.x2 - (box.vector.x2 + 200)) < 12, "dragging the south-east handle resized the box and left the opposite corner alone");
  const body = await screenOf(admin, (cur.vector.x1 + cur.vector.x2) / 2, (cur.vector.y1 + cur.vector.y2) / 2);
  const body2 = await screenOf(admin, (cur.vector.x1 + cur.vector.x2) / 2 + 150, (cur.vector.y1 + cur.vector.y2) / 2 - 80);
  await admin.mouse.move(body.x, body.y);
  await admin.mouse.down();
  await admin.mouse.move(body2.x, body2.y, { steps: 8 });
  await admin.mouse.up();
  const moved = await waitFor(async () => ((await annotations(admin)).find((x) => x.id === box.id).vector.x1 > cur.vector.x1 + 100 ? (await annotations(admin)).find((x) => x.id === box.id) : null), "move saved");
  check(moved.vector.x2 - moved.vector.x1 === cur.vector.x2 - cur.vector.x1 && moved.vector.y1 < cur.vector.y1 - 50, "dragging the body moved the box without changing its size");
  await admin.screenshot({ path: shots ? `${shots}/a2-selected.png` : undefined });

  // a drag that starts away from the selection pans instead of editing (zoomed in: at home the whole image is in view)
  await admin.evaluate(() => window.__viewer.viewport.zoomBy(2, undefined, true));
  await admin.waitForTimeout(400);
  const emptySpot = await screenOf(admin, 2600, 1900);
  const emptySpot2 = await screenOf(admin, 2450, 1800);
  const center0 = await admin.evaluate(() => window.__viewer.viewport.getCenter(true).x);
  // a plain drag on empty space draws a selection frame (and does not move the image)
  await admin.mouse.move(emptySpot.x, emptySpot.y);
  await admin.mouse.down();
  await admin.mouse.move(emptySpot2.x, emptySpot2.y, { steps: 5 });
  check(await admin.evaluate(() => window.__editor.session?.kind === "marquee"), "a plain drag on empty space draws a selection frame");
  await admin.mouse.up();
  await admin.waitForTimeout(400);
  check(Math.abs((await admin.evaluate(() => window.__viewer.viewport.getCenter(true).x)) - center0) < 1e-6, "...and the image stays where it is");
  // Space + drag moves the image
  await admin.keyboard.down("Space");
  await admin.mouse.move(emptySpot.x, emptySpot.y);
  await admin.mouse.down();
  await admin.mouse.move(emptySpot2.x, emptySpot2.y, { steps: 5 });
  await admin.mouse.up();
  await admin.keyboard.up("Space");
  await admin.waitForTimeout(600);
  check(Math.abs((await admin.evaluate(() => window.__viewer.viewport.getCenter(true).x)) - center0) > 0.001, "Space + drag pans");
  check(JSON.stringify((await annotations(admin)).find((x) => x.id === box.id).vector) === JSON.stringify(moved.vector), "...and does not touch the annotation");
  await admin.evaluate(() => window.__viewer.viewport.goHome(true));
  await admin.waitForTimeout(400);

  // the frame on empty space deselected the box: select it again
  const mv = moved.vector;
  const mvc = await screenOf(admin, (mv.x1 + mv.x2) / 2, (mv.y1 + mv.y2) / 2);
  await admin.mouse.click(mvc.x, mvc.y);
  await waitFor(() => admin.evaluate((id) => window.__editor.selectedId === id, box.id), "a click selects the box again");
  // there is no verification in the tools for now
  check((await admin.locator(".toolbox .btn", { hasText: /Verif/ }).count()) === 0, "the tool bar has no verify button");
  // Delete removes; Ctrl+Z restores; Ctrl+Shift+Z deletes again
  await admin.keyboard.press("Delete");
  await waitFor(async () => !(await annotations(admin)).some((x) => x.id === box.id), "Delete removed the annotation");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).some((x) => x.id === box.id), "Ctrl+Z brought it back");
  await admin.keyboard.press("Control+Shift+z");
  await waitFor(async () => !(await annotations(admin)).some((x) => x.id === box.id), "Ctrl+Shift+Z deleted it again");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).some((x) => x.id === box.id), "undo again");

  // undo of the edits: the move, then the resize
  await admin.keyboard.press("Control+z");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => JSON.stringify((await annotations(admin)).find((x) => x.id === box.id).vector) === JSON.stringify(box.vector), "undoing move and resize restores the drawn box");

  // ---------------------------------------------------------------------------------------- one-click mode
  await openImage(admin);
  const n0 = (await annotations(admin)).length;
  await admin.keyboard.press("2"); // the 2.25 mm fixed-size type
  check((await admin.locator(".toolbox .hint").first().innerText()).includes("Click to place a box"), "fixed-size type: click to place");
  for (const [x, y] of [[300, 300], [600, 300], [900, 300]]) {
    const p = await screenOf(admin, x, y);
    await admin.mouse.click(p.x, p.y);
    await admin.waitForTimeout(350);
  }
  list = await waitFor(async () => ((await annotations(admin)).length === n0 + 3 ? await annotations(admin) : null), "three clicks, three annotations");
  const sizes = new Set(list.slice(-3).map((x) => `${x.vector.x2 - x.vector.x1}x${x.vector.y2 - x.vector.y1}`));
  check(sizes.size === 1, `all three have the type's size (${[...sizes]})`);
  const dp = await screenOf(admin, 1200, 300);
  await admin.mouse.click(dp.x, dp.y);
  await admin.mouse.click(dp.x, dp.y); // an immediate second click at the same spot is one click (debounce)
  await admin.waitForTimeout(800);
  check((await annotations(admin)).length === n0 + 4, "a double click places one annotation");
  // one-click mode for the variable-size bounding box type
  await admin.keyboard.press("1");
  await admin.keyboard.press("a");
  check(await admin.locator(".toolbox .toggle input").isChecked(), "A switches one-click mode on");
  const op = await screenOf(admin, 1500, 600);
  await admin.mouse.click(op.x, op.y);
  await waitFor(async () => (await annotations(admin)).length === n0 + 5, "one-click mode places a box with a click for a drag type");
  await admin.keyboard.press("a");
  await admin.keyboard.press("Escape");
  check((await admin.locator(".toolbox .seg button.active, .toolbox .annotate-btn.active .annotate-label").getAttribute("aria-label")) === "Select", "Escape leaves the draw tool");

  // ---------------------------------------------------------------------------------------- several annotations at once
  const typeBox = box.annotation_type;
  const msPre = new Set((await annotations(admin)).map((a) => a.id));
  const msCreated = [];
  for (const x of [300, 700, 1100]) {
    msCreated.push(await admin.evaluate(async ([image, type, x]) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      const r = await fetch("/api/v2/annotations", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ image, annotation_type: type, vector: { x1: x, y1: 1000, x2: x + 200, y2: 1150 }, unique_identifier: crypto.randomUUID() }) });
      return await r.json();
    }, [IMAGE, typeBox, x]));
  }
  await openImage(admin);
  const inRegion = async () => (await annotations(admin)).filter((a) => a.vector && a.vector.x2 >= 200 && a.vector.x1 <= 1400 && a.vector.y2 >= 950 && a.vector.y1 <= 1250);
  const msExpected = (await inRegion()).length;
  check(msExpected >= 3, `three boxes are in the frame to be drawn (${msExpected})`);
  const msF1 = await screenOf(admin, 200, 950);
  const msF2 = await screenOf(admin, 1400, 1250);
  await admin.mouse.move(msF1.x, msF1.y);
  await admin.mouse.down();
  await admin.mouse.move(msF2.x, msF2.y, { steps: 8 });
  await admin.mouse.up();
  await waitFor(async () => (await admin.locator('[data-testid="group-count"]').count()) === 1, "a plain drag in the select tool draws a frame that selects several annotations");
  check((await admin.locator('[data-testid="group-count"]').innerText()) === `${msExpected} selected`, `...all that touch the frame (${msExpected} selected)`);
  // moving one moves all
  const msBefore = new Map((await inRegion()).map((a) => [a.id, a.vector]));
  const ms0 = await screenOf(admin, 400, 1075);
  const ms1 = await screenOf(admin, 400, 1075 + 100);
  await admin.mouse.move(ms0.x, ms0.y);
  await admin.mouse.down();
  await admin.mouse.move(ms1.x, ms1.y, { steps: 8 });
  await admin.mouse.up();
  await waitFor(async () => (await annotations(admin)).filter((a) => msBefore.has(a.id) && a.vector.y1 > msBefore.get(a.id).y1 + 60).length === msExpected, "dragging one of the selected annotations moves all of them");
  const msAfter = new Map((await annotations(admin)).filter((a) => msBefore.has(a.id)).map((a) => [a.id, a.vector]));
  check([...msBefore].every(([id, v]) => msAfter.get(id).x2 - msAfter.get(id).x1 === v.x2 - v.x1 && msAfter.get(id).y1 - v.y1 === msAfter.get([...msBefore.keys()][0]).y1 - [...msBefore.values()][0].y1), "...by the same shift, keeping their sizes");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).filter((a) => msBefore.has(a.id) && a.vector.y1 === msBefore.get(a.id).y1).length === msExpected, "one Undo takes the whole move back");
  // copy, paste: the same number again, selected
  const msTotal = (await annotations(admin)).length;
  await admin.keyboard.press("Control+c");
  await admin.keyboard.press("Control+v");
  await waitFor(async () => (await annotations(admin)).length === msTotal + msExpected, "Ctrl+C, Ctrl+V pastes copies");
  await waitFor(async () => (await admin.locator('[data-testid="group-count"]').count()) === 1 && (await admin.locator('[data-testid="group-count"]').innerText()) === `${msExpected} selected`, "...and selects the pasted ones");
  await admin.keyboard.press("Delete");
  await waitFor(async () => (await annotations(admin)).length === msTotal, "Delete removes all selected");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).length === msTotal + msExpected, "...and one Undo brings them all back");
  // single clicks: Shift+click adds, Escape clears
  await admin.keyboard.press("Escape");
  const msA1 = await screenOf(admin, 400, 1075);
  const msA2 = await screenOf(admin, 800, 1075);
  await admin.mouse.click(msA1.x, msA1.y);
  await admin.keyboard.down("Shift");
  await admin.mouse.click(msA2.x, msA2.y);
  await admin.keyboard.up("Shift");
  await waitFor(async () => (await admin.locator('[data-testid="group-count"]').count()) === 1 && (await admin.locator('[data-testid="group-count"]').innerText()) === "2 selected", "Shift+click adds an annotation to the selection");
  await admin.keyboard.down("Shift");
  await admin.mouse.click(msA2.x, msA2.y);
  await admin.keyboard.up("Shift");
  await waitFor(async () => (await admin.locator('[data-testid="group-count"]').count()) === 0, "Shift+click on a selected one takes it out (one left is a plain selection)");
  await admin.keyboard.press("Escape");
  // copy into a registered image: the annotation lands where the registration puts it
  const second = await setup(admin);
  const reg = await admin.evaluate(async ([source, target]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch("/api/v2/registrations/manual", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ source_image: source, target_image: target, points: [{ source: [0, 0], target: [100, 50] }, { source: [1000, 0], target: [600, 50] }] }) });
    return r.status;
  }, [IMAGE, second.image]);
  check(reg === 201, "a registration (scale 0.5, shift 100/50) to a second image exists");
  await admin.mouse.click(msA1.x, msA1.y);
  await admin.keyboard.press("Control+c");
  await admin.evaluate((id) => {
    history.pushState({}, "", `/images/${id}`); // no reload: the clipboard lives in the page
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, second.image);
  await waitFor(() => admin.evaluate(() => window.__viewer?.world.getItemCount() > 0), "the second image is open");
  await admin.waitForTimeout(1200);
  await admin.keyboard.press("Control+v");
  const pasted = await waitFor(async () => {
    const l = await admin.evaluate(async (id) => (await (await fetch(`/api/v2/annotations?image=${id}&deleted=false`)).json()).items, second.image);
    return l.length === 1 ? l[0] : null;
  }, "pasting into the registered image creates the annotation there");
  check(Math.abs(pasted.vector.x1 - 250) <= 2 && Math.abs(pasted.vector.y1 - 550) <= 2 && Math.abs(pasted.vector.x2 - 350) <= 2 && Math.abs(pasted.vector.y2 - 625) <= 2, `...at the position the registration gives (${JSON.stringify(pasted.vector)})`);
  await openImage(admin);
  for (const c of (await annotations(admin)).filter((a) => !msPre.has(a.id))) await admin.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    await fetch(`/api/v2/annotations/${id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  }, c.id);
  await openImage(admin);

  // ---------------------------------------------------------------------------------------- segmentation masks
  await openImage(admin);
  await pickType(admin, "e2e mask");
  await admin.waitForSelector('[data-testid="seg-tools"]');
  check((await admin.locator(".type-dd .trigger").innerText()).includes("e2e mask"), "a segmentation type is offered with a mark and starts the mask tools");
  const maskAnn = async () => (await annotations(admin)).find((a) => a.vector && a.vector.tile_size === 256);
  const tileInfo = (id, tx, ty) =>
    admin.evaluate(async ([id, tx, ty]) => {
      const r = await fetch(`/api/v2/segmentation/${id}/tiles/0/${tx}/${ty}?frame=0`);
      if (r.status !== 200) return { status: r.status, set: 0 };
      const bmp = await createImageBitmap(await r.blob());
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, 256, 256).data;
      let set = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 127) set++;
      return { status: 200, set };
    }, [id, tx, ty]);
  await waitFor(maskAnn, "choosing the type creates the mask annotation");
  await waitFor(() => admin.evaluate(() => !!window.__masks?.editable), "its layer is ready to paint");
  await admin.waitForTimeout(500);
  const m0 = await screenOf(admin, 300, 400);
  const m1 = await screenOf(admin, 480, 400);
  await admin.mouse.move(m0.x, m0.y);
  await admin.mouse.down();
  await admin.mouse.move(m1.x, m1.y, { steps: 10 });
  await admin.mouse.up();
  const mask = await maskAnn();
  const painted = await waitFor(async () => {
    const t = await tileInfo(mask.id, 1, 1);
    return t.status === 200 && t.set > 100 ? t : null;
  }, "the stroke is saved as a tile of the mask");
  check(painted.set > 1000, `...a round brush of 24 px along 180 px (${painted.set} pixels)`);
  // undo removes the stroke from the server, redo brings it back
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await tileInfo(mask.id, 1, 1)).status === 204, "Undo takes the stroke back");
  await admin.keyboard.press("Control+Shift+z");
  await waitFor(async () => (await tileInfo(mask.id, 1, 1)).status === 200, "Redo paints it again");
  // eraser
  await admin.locator('[data-testid="seg-tools"] button[aria-label="Eraser"]').click();
  const e0 = await screenOf(admin, 300, 400);
  const e1 = await screenOf(admin, 400, 400);
  await admin.mouse.move(e0.x, e0.y);
  await admin.mouse.down();
  await admin.mouse.move(e1.x, e1.y, { steps: 8 });
  await admin.mouse.up();
  await waitFor(async () => {
    const t = await tileInfo(mask.id, 1, 1);
    return t.status === 200 && t.set < painted.set - 500;
  }, "the eraser removes part of the mask");
  // magic wand on the gradient image: a connected area of similar colour
  await admin.locator('[data-testid="seg-tools"] button[aria-label="Wand"]').click();
  await admin.locator('input[aria-label="Wand tolerance"]').fill("100");
  const wp = await screenOf(admin, 3200, 2000);
  await admin.mouse.click(wp.x, wp.y);
  await waitFor(async () => {
    let n = 0;
    for (const [tx, ty] of [[12, 7], [12, 8], [13, 7], [13, 8], [11, 7], [11, 8]]) n += (await tileInfo(mask.id, tx, ty)).set;
    return n > 500;
  }, "the magic wand fills an area around the click", 30000);
  // a reload shows the mask again
  await openImage(admin);
  await waitFor(() => admin.evaluate(() => (window.__masks?.layers.size ?? 0) === 1 && [...window.__masks.layers.values()].some((l) => l.tiles.size > 0)), "after a reload the mask is loaded for the visible part");
  await admin.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    await fetch(`/api/v2/annotations/${id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  }, mask.id);
  await openImage(admin);

  // ---------------------------------------------------------------------------------------- polygon
  await openImage(admin);
  await pickType(admin, "e2e polygon");
  check((await admin.locator(".toolbox .hint").first().innerText()).includes("Click to add points"), "polygon type: click to add points");
  const corners = [[2000, 1200], [2600, 1200], [2600, 1800], [2000, 1800]]; // the toolbox covers the lower edge of the image
  for (const [x, y] of corners) {
    const p = await screenOf(admin, x, y);
    await admin.mouse.click(p.x, p.y);
    await admin.waitForTimeout(200);
  }
  check((await admin.locator(".toolbox .btn", { hasText: "Finish" }).count()) === 1, `Finish shows while a polygon is in progress (draft points: ${await admin.evaluate(() => window.__editor.draftPoints)}, tool ${await admin.evaluate(() => JSON.stringify(window.__editor.tool))})`);
  await admin.keyboard.press("Enter");
  const poly = await waitFor(async () => (await annotations(admin)).find((x) => x.vector?.x4 != null && x.annotation_type !== 1), "polygon saved with four vertices");
  check(poly.vector.x3 === Math.round(poly.vector.x3) && Math.abs(poly.vector.x1 - 2000) < 12 && Math.abs(poly.vector.y1 - 1200) < 12, `polygon created (${JSON.stringify(poly.vector)})`);
  await admin.keyboard.press("c");
  const inPoly = await screenOf(admin, 2300, 1500);
  await admin.mouse.click(inPoly.x, inPoly.y);
  await waitFor(() => admin.evaluate((id) => window.__editor.selectedId === id, poly.id), "clicking inside the polygon selects it");
  check((await admin.locator(".toolbox .measure").innerText()) === "360,000 px²", "a selected polygon shows its area (600 x 600 px)");
  // drag the dot between vertices 1 and 2: a new vertex appears
  const mid = await screenOf(admin, 2300, 1200);
  const mid2 = await screenOf(admin, 2300, 1000);
  await admin.mouse.move(mid.x, mid.y);
  await admin.mouse.down();
  await admin.mouse.move(mid2.x, mid2.y, { steps: 6 });
  await admin.mouse.up();
  const five = await waitFor(async () => (await annotations(admin)).find((x) => x.id === poly.id && x.vector.x5 != null), "dragging a midpoint added a fifth vertex");
  check(Math.abs(five.vector.y2 - 1000) < 15, `the new vertex sits where it was dropped (${five.vector.x2},${five.vector.y2})`);
  // click the new vertex and remove it with Delete
  const nv = await screenOf(admin, five.vector.x2, five.vector.y2);
  await admin.mouse.click(nv.x, nv.y);
  await waitFor(() => admin.evaluate(() => window.__editor.selectedVertex === 1), "clicking a vertex selects it");
  check((await admin.locator(".toolbox .btn", { hasText: "Remove vertex" }).count()) === 1, "toolbox offers to remove the vertex");
  await admin.keyboard.press("Delete");
  await waitFor(async () => (await annotations(admin)).find((x) => x.id === poly.id && x.vector.x5 == null), "Delete removed the vertex, not the polygon");
  await admin.screenshot({ path: shots ? `${shots}/a3-polygon.png` : undefined });

  // ---------------------------------------------------------------------------------------- polygon operations
  const polyNow = async () => (await annotations(admin)).find((x) => x.id === poly.id);
  const xs = (v) => Object.keys(v).filter((k) => /^x\d+$/.test(k)).map((k) => v[k]);
  const ys = (v) => Object.keys(v).filter((k) => /^y\d+$/.test(k)).map((k) => v[k]);
  const pStart = await polyNow();
  check(Math.max(...xs(pStart.vector)) === 2600, "the polygon is selected again for reshaping");

  // add area: Shift + drag paints onto the polygon (the brush ring is 18 screen pixels)
  const bFrom = await screenOf(admin, 2500, 1500);
  const bTo = await screenOf(admin, 2900, 1500);
  await admin.keyboard.down("Shift");
  await admin.mouse.move(bFrom.x, bFrom.y);
  await admin.mouse.down();
  await admin.mouse.move(bTo.x, bTo.y, { steps: 10 });
  await admin.mouse.up();
  await admin.keyboard.up("Shift");
  const grown = await waitFor(async () => { const v = (await polyNow()).vector; return Math.max(...xs(v)) > 2750 ? v : null; }, "Shift+drag added area to the polygon");
  check(Math.max(...xs(grown)) > 2750 && Math.min(...xs(grown)) === 2000, `Shift+drag painted the polygon out to x=${Math.max(...xs(grown))} (${xs(grown).length} vertices)`);
  await admin.screenshot({ path: shots ? `${shots}/a6-brush.png` : undefined });

  // erase: Alt + drag down through the polygon paints a band away; the polygon falls into two pieces
  const countBefore = (await annotations(admin)).length;
  const eFrom = await screenOf(admin, 2750, 1000);
  const eTo = await screenOf(admin, 2750, 2000);
  await admin.keyboard.down("Alt");
  await admin.mouse.move(eFrom.x, eFrom.y);
  await admin.mouse.down();
  await admin.mouse.move(eTo.x, eTo.y, { steps: 10 });
  await admin.mouse.up();
  await admin.keyboard.up("Alt");
  const eroded = await waitFor(async () => { const v = (await polyNow()).vector; return Math.max(...xs(v)) < 2750 ? v : null; }, "Alt+drag erased a band from the polygon");
  check(Math.max(...xs(eroded)) < 2750, `Alt+drag erased a band: the polygon ends at x=${Math.max(...xs(eroded))}`);
  await waitFor(async () => (await annotations(admin)).length === countBefore + 1, "the right piece became an annotation of its own");
  await admin.keyboard.press("Control+z");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => JSON.stringify((await polyNow()).vector) === JSON.stringify(pStart.vector), "two undos restore the polygon");

  // scissors (S): draw an area covering the upper right corner
  await admin.keyboard.press("s");
  check((await admin.locator(".toolbox .hint", { hasText: "cut away" }).count()) === 1, "S starts the scissors");
  for (const [x, y] of [[2400, 1100], [2700, 1100], [2700, 1350], [2400, 1350]]) {
    const p = await screenOf(admin, x, y);
    await admin.mouse.click(p.x, p.y);
    await admin.waitForTimeout(150);
  }
  await admin.keyboard.press("Enter");
  const cut = await waitFor(async () => { const v = (await polyNow()).vector; return xs(v).length > 4 ? v : null; }, "scissors cut a notch out of the polygon");
  check(xs(cut).length >= 6 && Math.max(...xs(cut)) === 2600, `scissors: the polygon has a notch now (${xs(cut).length} vertices)`);
  await admin.keyboard.press("Control+z");
  await waitFor(async () => JSON.stringify((await polyNow()).vector) === JSON.stringify(pStart.vector), "undo restores the polygon after the scissors");

  // knife (D): a line through the polygon makes two polygons
  const before2 = (await annotations(admin)).length;
  await admin.keyboard.press("d");
  for (const [x, y] of [[2300, 1000], [2300, 2000]]) {
    const p = await screenOf(admin, x, y);
    await admin.mouse.click(p.x, p.y);
    await admin.waitForTimeout(150);
  }
  await admin.keyboard.press("Enter");
  await waitFor(async () => (await annotations(admin)).length === before2 + 1, "the knife made a second polygon");
  const pieces = (await annotations(admin)).filter((x) => x.annotation_type === poly.annotation_type && x.vector.x3 != null && Math.min(...xs(x.vector)) >= 2000 && Math.max(...xs(x.vector)) <= 2600 && Math.min(...ys(x.vector)) >= 1200 && Math.max(...ys(x.vector)) <= 1800);
  check(pieces.some((h) => Math.max(...xs(h.vector)) <= 2302) && pieces.some((h) => Math.min(...xs(h.vector)) >= 2298), "the polygon was split at the line into a left and a right polygon");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).length === before2 && JSON.stringify((await polyNow()).vector) === JSON.stringify(pStart.vector), "one undo takes the split back completely");
  await admin.screenshot({ path: shots ? `${shots}/a7-ops.png` : undefined });

  // the Reshape menu switches the brush on and off (the way for touch screens, which have no Shift / Alt)
  await admin.locator(".reshape-dd .trigger").click();
  await admin.locator(".reshape-dd .dd-item", { hasText: "Add area" }).click();
  check((await admin.evaluate(() => window.__editor.brushMode)) === "add" && (await admin.locator(".brush-size input").count()) === 1, "Reshape > Add area switches the brush on, with its size slider");
  await admin.locator(".reshape-dd .trigger").click();
  await admin.locator(".reshape-dd .dd-item", { hasText: "Add area" }).click();
  check((await admin.evaluate(() => window.__editor.brushMode)) === "off", "...and picking it again switches it off");

  // many types: a drop-down with a filter
  await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    for (let i = 1; i <= 8; i++)
      await fetch("/api/v2/annotation-types", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ name: `e2e extra ${i}`, vector_type: 1, color_code: "#3366cc", product: 1, sort_order: 20 + i }) });
  });
  await openImage(admin);
  await admin.locator(".type-dd .trigger").click();
  check((await admin.locator(".type-dd .dd-item").count()) >= 12 && (await admin.locator(".type-dd .dd-filter").count()) === 1, "with many types the drop-down has a filter field");
  await admin.fill(".type-dd .dd-filter", "extra 5");
  check((await admin.locator(".type-dd .dd-item").count()) === 1, "typing narrows the list");
  await admin.keyboard.press("Enter");
  check((await admin.locator(".type-dd .trigger").innerText()).includes("e2e extra 5") && (await admin.locator(".toolbox .seg button.active, .toolbox .annotate-btn.active .annotate-label").getAttribute("aria-label")) === "Annotate with", "Enter picks the first match and starts drawing with it");

  // shortcuts: keyboard focus in a text field does not trigger tools; Y hides annotations
  await admin.keyboard.press("y");
  check((await admin.locator(".toolbox .btn", { hasText: "Show" }).count()) === 1, "Y hides the annotations");
  await admin.keyboard.press("y");

  // ---------------------------------------------------------------------------------------- right-click menu
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");
  const boxNow = (await annotations(admin)).find((x) => x.id === box.id);
  const boxC = await screenOf(admin, (boxNow.vector.x1 + boxNow.vector.x2) / 2, (boxNow.vector.y1 + boxNow.vector.y2) / 2);
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.waitForSelector(".ctx");
  const menuText = (await admin.locator(".ctx > button").allInnerTexts()).join("|").replace(/\s+/g, " ");
  check(menuText === "Info…|Change class ▸|Crop to new image…|Delete annotation…", `right click on an annotation opens its menu: info, change class, crop, delete (${menuText})`);
  check(await admin.evaluate((id) => window.__editor.selectedId === id, box.id), "...and selects it");
  // info
  await admin.locator(".ctx > button", { hasText: "Info" }).click();
  await admin.waitForSelector(".modal");
  await admin.waitForFunction(() => !document.querySelector(".modal dl.info")?.textContent.includes("…"), null, { timeout: 8000 }).catch(() => null);
  const infoText = await admin.locator(".modal dl.info").innerText();
  check(infoText.includes("rt_teamadmin") && infoText.includes("Created by") && !infoText.includes("Verified") && infoText.includes("Bounding box") && infoText.includes("px²"), `Info shows who created it, when, its type and area (${infoText.replace(/\s+/g, " ")})`);
  await admin.keyboard.press("Escape");
  check((await admin.locator(".modal").count()) === 0, "Escape closes the dialog");
  // change class within compatible shapes
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Change class" }).click();
  const classes = await admin.locator(".ctx-sub .dd-item").allInnerTexts();
  check(classes.some((c) => c.includes("Annotation")) && classes.some((c) => c.includes("2.25mm")) && !classes.some((c) => c.includes("e2e polygon")), `Change class offers the compatible types only (${classes.join(" | ").replace(/\n/g, " ")})`);
  await admin.locator(".ctx-sub .dd-item", { hasText: "2.25mm" }).click();
  // bounding box -> fixed-size box changes the size: the user is asked
  await admin.waitForSelector(".modal");
  check((await admin.locator(".modal").innerText()).includes("fixed size") && (await admin.locator(".modal").innerText()).includes("500 × 400 px"), "changing to a fixed-size type asks whether to resize");
  check((await admin.locator(".ctx").count()) === 0, "the menu closes after the choice");
  await admin.locator(".modal .btn", { hasText: "Keep the class" }).click();
  await admin.waitForTimeout(500);
  check((await annotations(admin)).find((x) => x.id === box.id).annotation_type === boxNow.annotation_type, "\"Keep the class\" leaves the annotation alone");
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Change class" }).click();
  await admin.locator(".ctx-sub .dd-item", { hasText: "2.25mm" }).click();
  await admin.locator(".modal .btn.primary").click();
  const resized = await waitFor(async () => { const a = (await annotations(admin)).find((x) => x.id === box.id); return a.annotation_type !== boxNow.annotation_type ? a : null; }, "the class changed after confirming");
  const [cx0, cy0] = [(boxNow.vector.x1 + boxNow.vector.x2) / 2, (boxNow.vector.y1 + boxNow.vector.y2) / 2];
  check(resized.vector.x2 - resized.vector.x1 === 2 && Math.abs((resized.vector.x1 + resized.vector.x2) / 2 - cx0) <= 1 && Math.abs((resized.vector.y1 + resized.vector.y2) / 2 - cy0) <= 1, `...and resized it around its centre (${JSON.stringify(resized.vector)})`);
  await admin.keyboard.press("Control+z");
  await waitFor(async () => { const a = (await annotations(admin)).find((x) => x.id === box.id); return a.annotation_type === boxNow.annotation_type && JSON.stringify(a.vector) === JSON.stringify(boxNow.vector); }, "undo restores the class and the size");
  // a polygon has no other class to change to
  const polyNow2 = (await annotations(admin)).find((x) => x.id === poly.id);
  const pc = await screenOf(admin, 2300, 1500);
  await admin.mouse.click(pc.x, pc.y, { button: "right" });
  await admin.waitForSelector(".ctx");
  check(await admin.locator(".ctx > button", { hasText: "Change class" }).isDisabled(), "a polygon with only one polygon type cannot change class");
  await admin.keyboard.press("Escape");
  check((await admin.locator(".ctx").count()) === 0, "Escape closes the menu");
  void polyNow2;
  // crop to a new image set
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Crop to new image" }).click();
  await admin.waitForSelector(".modal");
  check((await admin.locator(".modal").innerText()).includes(`${boxNow.vector.x2 - boxNow.vector.x1} × ${boxNow.vector.y2 - boxNow.vector.y1} px`), "the crop dialog names the region");
  await waitFor(async () => (await admin.locator(".modal select").first().locator("option").count()) >= 2, "the dialog loaded the image sets");
  const opts = await admin.locator(".modal select").first().locator("option").allInnerTexts();
  check(opts.some((o) => o.includes("New image set")) && opts.length >= 2, `the dialog offers the image sets and a new one (${opts.length} options)`);
  await admin.locator(".modal select").first().selectOption({ label: "＋ New image set…" });
  await admin.fill('.modal input[maxlength="256"]', `e2e-crops-${Date.now()}`);
  await admin.locator(".modal .btn.primary").click();
  await admin.waitForSelector(".toast.ok");
  const crops = await admin.evaluate(async (w) => (await (await fetch(`/api/v2/images?name__contains=_w${w}_h&limit=200`)).json()).items, boxNow.vector.x2 - boxNow.vector.x1);
  const mine = crops.find((c) => c.crop_source === IMAGE && c.crop_x === boxNow.vector.x1 && c.crop_y === boxNow.vector.y1);
  check(mine && mine.width === boxNow.vector.x2 - boxNow.vector.x1 && mine.height === boxNow.vector.y2 - boxNow.vector.y1 && mine.image_set !== SET, "the crop is a new image in a new image set, with the size of the annotation");
  const cropSet = mine.image_set;
  // the crop knows where it comes from: the top bar says so and leads back to the original
  const tab = await desktop.newPage();
  await tab.goto(`${base}/images/${mine.id}`);
  await tab.waitForSelector(".origin");
  const originText = await tab.locator(".origin").innerText();
  check(originText.includes("Crop of") && originText.includes(`(${boxNow.vector.x1}, ${boxNow.vector.y1})`) && originText.includes("Show in original"), `a crop shows where it comes from (${originText.replace(/\s+/g, " ")})`);
  await tab.waitForFunction(() => window.__viewer?.world.getItemCount() > 0);
  await tab.waitForTimeout(800);
  const pos = await tab.evaluate(() => { const v = window.__viewer; const r = v.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.4 }; });
  await tab.mouse.move(pos.x, pos.y);
  await tab.waitForTimeout(300);
  check((await tab.locator(".cursor-pos").innerText()).includes("original"), `the pointer position is also given in the original's coordinates (${(await tab.locator(".cursor-pos").innerText()).replace(/\s+/g, " ")})`);
  await tab.locator(".origin .btn", { hasText: "Show in original" }).click();
  await tab.waitForURL(`**/images/${IMAGE}?region=*`);
  await tab.waitForFunction(() => window.__viewer?.world.getItemCount() > 0);
  await tab.waitForTimeout(1500);
  const zoomed = await tab.evaluate(() => window.__viewer.viewport.getZoom(true) > window.__viewer.viewport.getHomeZoom() * 1.5);
  check(zoomed, "\"Show in original\" opens the original zoomed to the cropped region");
  await tab.close();
  // the same crop again into the same set is refused, with a way to open the existing one
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Crop to new image" }).click();
  await admin.waitForSelector(".modal");
  await admin.locator(".modal select").first().selectOption({ value: String(cropSet) });
  await admin.locator(".modal .btn.primary").click();
  await admin.waitForSelector(".modal .error");
  check((await admin.locator(".modal .error").innerText()).includes("before") && (await admin.locator(".modal .error .btn", { hasText: "Open it" }).count()) === 1, "cropping the same region into the same set again says so and offers the existing image");
  await admin.keyboard.press("Escape");
  await admin.evaluate(async (set) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    await fetch(`/api/v2/image-sets/${set}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  }, cropSet);
  // delete with confirmation
  const before3 = (await annotations(admin)).length;
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Delete annotation" }).click();
  await admin.waitForSelector(".modal");
  await admin.locator(".modal .btn", { hasText: "Cancel" }).click();
  check((await annotations(admin)).length === before3, "Cancel keeps the annotation");
  await admin.mouse.click(boxC.x, boxC.y, { button: "right" });
  await admin.locator(".ctx > button", { hasText: "Delete annotation" }).click();
  await admin.locator(".modal .btn.danger").click();
  await waitFor(async () => (await annotations(admin)).length === before3 - 1, "confirming deleted the annotation");
  await admin.keyboard.press("Control+z");
  await waitFor(async () => (await annotations(admin)).length === before3, "Ctrl+Z brings it back");

  // the type list on the left folds away (and stays folded)
  check((await admin.locator(".viewer-side .type-row").count()) > 0, "the type list shows the types");
  await admin.locator(".viewer-side .fold").click();
  check((await admin.locator(".viewer-side .type-row").count()) === 0, "a click on its title folds it away");
  await admin.reload();
  await admin.waitForSelector(".viewer-side .fold");
  check((await admin.locator(".viewer-side .type-row").count()) === 0, "...and it stays folded after a reload");
  await admin.locator(".viewer-side .fold").click();

  // ---------------------------------------------------------------------------------------- tablet: touch
  const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });
  await tablet.addInitScript(() => localStorage.getItem("exact.mpr") === null && localStorage.setItem("exact.mpr", "0")); // volumes open in one plane here: the tools are there
  const tp = await login(tablet, "rt_teamadmin");
  await openImage(tp);
  const nt = (await annotations(tp)).length;
  await pickType(tp, "2.25mm", true);
  const t1 = await screenOf(tp, 1700, 1500);
  await tp.touchscreen.tap(t1.x, t1.y);
  await waitFor(async () => (await annotations(tp)).length === nt + 1, "a tap places a fixed-size annotation on a touch screen");
  await tp.locator(".toolbox .seg button[aria-label=Select]").tap();
  const created = (await annotations(tp)).at(-1);
  const tc = await screenOf(tp, (created.vector.x1 + created.vector.x2) / 2, (created.vector.y1 + created.vector.y2) / 2);
  await tp.touchscreen.tap(tc.x, tc.y);
  await waitFor(() => tp.evaluate((id) => window.__editor.selectedId === id, created.id), "a tap selects it");
  check((await tp.locator(".toolbox .btn").first().boundingBox()).height >= 36, "tool buttons are large enough for fingers");
  // a long press opens the annotation menu
  const cdp = await tp.context().newCDPSession(tp);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tc.x, y: tc.y }] });
  await tp.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await tp.waitForSelector(".ctx", { timeout: 3000 });
  check(true, "a long press on a touch screen opens the annotation menu");
  await tp.keyboard.press("Escape");
  await tp.screenshot({ path: shots ? `${shots}/a4-tablet.png` : undefined });

  // ---------------------------------------------------------------------------------------- phone: viewing first
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  await phone.addInitScript(() => localStorage.getItem("exact.mpr") === null && localStorage.setItem("exact.mpr", "0")); // volumes open in one plane here: the tools are there
  const pp = await login(phone, "rt_member");
  await openImage(pp);
  check(!(await pp.locator(".viewer-side").isVisible()), "phone: the type list is closed until asked for");
  check(!(await pp.locator(".toolbox").count()), "phone: the tools are closed until asked for");
  await pp.locator(".tools-toggle").tap();
  check(await pp.locator(".toolbox").isVisible(), "phone: the tools open with the pencil button");
  await pp.locator(".tools-toggle").tap();
  await pp.locator(".side-toggle").tap();
  check(await pp.locator(".viewer-side").isVisible(), "phone: the type list opens");
  check((await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), "phone: no horizontal page scroll");
  await pp.screenshot({ path: shots ? `${shots}/a5-phone.png` : undefined });

  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  if (SET) {
    const cleaner = await login(await browser.newContext(), "rt_teamadmin", { quiet: true }).catch(() => null);
    await cleaner?.evaluate(async (set) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      await fetch(`/api/v2/image-sets/${set}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
    }, SET);
  }
  await browser.close();
}
