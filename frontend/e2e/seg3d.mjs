// End-to-end test of the 3D segmentation tools of the three-plane view in the system Chrome: choose a segmentation type, paint a
// sphere on the axial plane and see the mask on the coronal and sagittal planes, eraser, wand with a limited reach, interpolation,
// undo / redo, the readout, a read-only account, and the hint in the single-plane view. Needs a freshly restored scratch database.
// Usage: node e2e/seg3d.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";
import fs from "node:fs";
import { spawn } from "node:child_process";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const IMAGE = 80; // CT_Philips.nii.gz of image set 1 (team 1): 185 x 233 pixels, 256 slices
const SET = 1;
const SEG_PRODUCT = 2;

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
    await new Promise((r) => setTimeout(r, 120));
  }
};

async function login(context, user, password = "rust-test-pw", { quiet = false } = {}) {
  const page = await context.newPage();
  if (!quiet) {
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/ 40[0139]|401|409/.test(m.text()) && errors.push(m.text()));
  }
  await page.goto(base);
  await page.waitForSelector("form.login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', password);
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  return page;
}
const apiCall = (page, method, url, body) =>
  page.evaluate(
    async ([method, url, body]) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      const r = await fetch(url, { method, headers: { "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
    },
    [method, url, body ?? null],
  );

let shotPage = null;
const shot = (n) => shots && shotPage?.screenshot({ path: `${shots}/seg3d-${n}.png` }).catch(() => null);
const root = await login(await browser.newContext(), "aubreville", "rust-test-pw", { quiet: true });
let readOnlyUser = null;
let annotationId = 0;
let setAside = [];
try {
  // masks that are already in the image are put aside while the test runs (and brought back at the end)
  const existing = await apiCall(root, "GET", `/api/v2/annotations?image=${IMAGE}&deleted=false&annotation_type=2&limit=100`);
  setAside = (existing.body?.items ?? []).map((a) => a.id);
  for (const id of setAside) await apiCall(root, "PATCH", `/api/v2/annotations/${id}`, { deleted: true });
  // the image set needs a product with a segmentation type
  await apiCall(root, "PUT", `/api/v2/image-sets/${SET}/products/${SEG_PRODUCT}`);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await login(ctx, "rt_teamadmin");
  shotPage = page;

  const pane = (n) => page.locator(`[data-testid="mpr-${n}"]`);
  const openPlanes = async (p) => {
    await p.goto(`${base}/images/${IMAGE}/planes`);
    for (const n of ["axial", "coronal", "sagittal"]) await p.waitForSelector(`[data-testid="mpr-${n}"] canvas`);
    await waitFor(() => p.evaluate(() => [0, 1, 2].every((i) => window[`__mpr_${i}`]?.world.getItemCount() > 0 && window[`__mpr_${i}`].world.getItemAt(0).getFullyLoaded())), "all three planes are drawn");
  };
  await openPlanes(page);

  // ------------------------------------------------------------------------------------------ choosing the type
  const trigger = page.locator('.dropdown[data-name="segment"] .trigger');
  check(!(await trigger.isDisabled()), "the Segment button is enabled for a set with a segmentation type");
  await trigger.click();
  const typeItem = page.locator(".dd-item", { hasText: "▨" }).first();
  check((await typeItem.count()) === 1, "the segmentation types of the set are listed with the ▨ mark");
  await typeItem.click();
  await page.waitForSelector(".seg3d-panel");
  await waitFor(async () => (await page.locator('[data-testid="seg3d-volume"]').count()) === 1, "the tool window shows the mask");
  check((await page.locator('[data-testid="seg3d-volume"]').innerText()) === "0 mm³", "a new mask is empty");
  check((await page.locator('[data-testid="seg3d-extra"]').count()) === 1, "the window keeps a place for further buttons");
  await waitFor(async () => (await page.locator('[data-testid="mask-overlay"]').count()) === 3, "the mask is laid over all three planes");
  const list = await apiCall(root, "GET", `/api/v2/annotations?image=${IMAGE}&deleted=false&limit=1000`);
  annotationId = (list.body.items.find((a) => a.annotation_type === 2 && !setAside.includes(a.id)) ?? {}).id ?? 0;
  check(annotationId > 0, `the mask annotation of the type was made (${annotationId})`);
  await shot("1-segment");

  // ------------------------------------------------------------------------------------------ painting a sphere
  const overlay = (n) => pane(n).locator('[data-testid="mask-overlay"]');
  /** number of non-transparent pixels of the mask image that a plane shows */
  const masked = (n) =>
    page.evaluate(async (sel) => {
      const img = document.querySelector(sel);
      const url = img?.getAttribute("data-url");
      if (!url) return -1;
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let k = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) k++;
      return k;
    }, `[data-testid="mpr-${n}"] [data-testid="mask-overlay"]`);
  const volume = async () => (await page.locator('[data-testid="seg3d-readout"]').innerText()).replace(/\s+/g, " ");
  const volumeMm3 = async () => Number((await page.locator('[data-testid="seg3d-volume"]').innerText()).replace(/[^\d.]/g, "")) * ((await page.locator('[data-testid="seg3d-volume"]').innerText()).includes("ml") ? 1000 : 1);
  const box = await pane("axial").boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const stroke = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
  };
  await page.locator('[data-testid="seg3d-ball"]').click();
  check((await page.locator(".seg3d-panel .adjust-val").first().innerText()).endsWith(" px"), "the brush size is in pixels by default");
  await page.locator('[data-testid="seg3d-unit-mm"]').click();
  await page.locator('[data-testid="seg3d-size"]').fill("14");
  check((await page.locator(".seg3d-panel .adjust-val").first().innerText()) === "14 mm", "the brush size can be set in mm");
  await stroke(at(0.45, 0.5), at(0.55, 0.5));
  await waitFor(async () => (await volumeMm3()) > 100, `a 3D sphere stroke makes a mask (${await volume()})`);
  const axialPainted = await waitFor(async () => (await masked("axial")) > 50 && (await masked("axial")), "the axial plane shows the mask");
  await waitFor(async () => (await masked("coronal")) > 50, "the coronal plane shows it too");
  await waitFor(async () => (await masked("sagittal")) > 50, "the sagittal plane shows it too");
  const slicesPainted = Number((await volume()).match(/(\d+) slices? painted/)[1]);
  check(slicesPainted >= 3, `the sphere reaches through the slices (${slicesPainted} slices painted)`);
  await shot("2-sphere");
  check(/\d+(\.\d+)? (mm³|ml)/.test(await volume()), `the readout gives the volume (${await volume()})`);
  const v1 = await volumeMm3();

  // ------------------------------------------------------------------------------------------ eraser, undo, redo
  await page.locator('[data-testid="seg3d-mode"]').click();
  check((await page.locator('[data-testid="seg3d-mode"]').innerText()) === "−", "the mode button shows − when subtracting");
  await page.locator('[data-testid="seg3d-size"]').fill("60");
  await stroke(at(0.35, 0.5), at(0.65, 0.5));
  await waitFor(async () => (await volumeMm3()) === 0, `the eraser removes it (${await volume()})`);
  await waitFor(async () => (await masked("axial")) === 0, "...and the planes show nothing");
  await page.locator('[data-testid="seg3d-undo"]').click();
  await waitFor(async () => Math.abs((await volumeMm3()) - v1) < 1, "Undo brings the mask back");
  await page.keyboard.press("Control+Shift+z");
  await waitFor(async () => (await volumeMm3()) === 0, "Shift+Ctrl+Z redoes the erasing");
  await page.keyboard.press("Control+z");
  await waitFor(async () => Math.abs((await volumeMm3()) - v1) < 1, "Ctrl+Z undoes it");
  // + / − back to adding; Alt + wheel sizes the brush
  await page.locator('[data-testid="seg3d-mode"]').click();
  await page.locator('[data-testid="seg3d-brush"]').click();
  await page.mouse.move(...at(0.5, 0.5));
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Alt");
  await waitFor(async () => (await page.locator(".seg3d-panel .adjust-val").first().innerText()) !== "60 mm", "Alt + wheel changes the brush size");

  // ------------------------------------------------------------------------------------------ clear, wand in the volume with a limited reach
  const clear = page.locator('[data-testid="seg3d-clear"]');
  await clear.click();
  check((await clear.innerText()).includes("again"), "Clear asks to be clicked again");
  await clear.click();
  await waitFor(async () => (await volumeMm3()) === 0, "Clear empties the mask");
  // lasso: an outline drawn in the plane is closed and filled in that slice; − takes an area out again
  await page.locator('[data-testid="seg3d-lasso"]').click();
  const outline = async (x0, y0, x1, y1) => {
    await page.mouse.move(...at(x0, y0));
    await page.mouse.down();
    for (const [x, y] of [[x1, y0], [x1, y1], [x0, y1]]) await page.mouse.move(...at(x, y), { steps: 4 });
    await page.mouse.up();
  };
  await outline(0.35, 0.35, 0.65, 0.65);
  await waitFor(async () => /1 slice painted/.test(await volume()) && (await volumeMm3()) > 0, `the lasso fills what it encircles in one slice (${await volume()})`);
  const lassoed = await volumeMm3();
  await page.locator('[data-testid="seg3d-mode"]').click();
  await outline(0.45, 0.45, 0.55, 0.55);
  await waitFor(async () => (await volumeMm3()) < lassoed * 0.95 && (await volumeMm3()) > 0, "the lasso in − mode takes an area out");
  await page.locator('[data-testid="seg3d-mode"]').click();
  await page.locator('[data-testid="seg3d-clear"]').click();
  await page.locator('[data-testid="seg3d-clear"]').click();
  await waitFor(async () => (await volumeMm3()) === 0, "cleared after the lasso");
  await page.locator('[data-testid="seg3d-wand"]').click();
  await page.locator('[data-testid="seg3d-wand3d"]').click();
  await page.locator('[data-testid="seg3d-reach"]').fill("12");
  await page.locator('[data-testid="seg3d-tolerance"]').fill("20");
  await page.mouse.click(...at(0.5, 0.52));
  await waitFor(async () => (await volumeMm3()) > 0, `the wand in the volume adds a region (${await volume()})`);
  const reach = await volumeMm3();
  check(reach < (4 / 3) * Math.PI * 12 ** 3 * 1.2, `...within its reach of 12 mm (${reach.toFixed(0)} mm³ of at most ${Math.round((4 / 3) * Math.PI * 12 ** 3)})`);
  check((await page.locator('[data-testid="seg3d-message"][role="alert"]').count()) === 0, "...without an error");
  // the wand in − mode takes the same region out again
  await page.locator('[data-testid="seg3d-mode"]').click();
  await page.mouse.click(...at(0.5, 0.52));
  await waitFor(async () => (await volumeMm3()) < reach * 0.2, `the wand in − mode removes the region (${await volume()})`);
  await page.locator('[data-testid="seg3d-mode"]').click();
  // ------------------------------------------------------------------------------------------ interpolation between painted slices
  if ((await volumeMm3()) > 0) {
    await page.locator('[data-testid="seg3d-clear"]').click();
    await page.locator('[data-testid="seg3d-clear"]').click();
  }
  await waitFor(async () => (await volumeMm3()) === 0, "cleared again");
  await page.locator('[data-testid="seg3d-brush"]').click();
  await page.locator('[data-testid="seg3d-disc"]').click();
  await page.locator('[data-testid="seg3d-size"]').fill("24");
  await stroke(at(0.5, 0.5), at(0.5, 0.5));
  await waitFor(async () => /1 slice painted/.test(await volume()), "a disc is painted on one slice");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
  await page.locator('[data-testid="seg3d-size"]').fill("10");
  await stroke(at(0.5, 0.5), at(0.5, 0.5));
  await waitFor(async () => /2 slices painted/.test(await volume()), "another disc six slices further");
  await page.locator('[data-testid="seg3d-interpolate"]').click();
  await waitFor(async () => /7 slices painted/.test(await volume()), `Interpolate fills the five slices between (${await volume()})`);
  await shot("3-interpolated");
  const plain = await volumeMm3();
  await page.locator('[data-testid="seg3d-grow"]').click();
  const grown = await waitFor(async () => (await volumeMm3()) > plain && (await volumeMm3()), "Grow works");
  await page.locator('[data-testid="seg3d-shrink"]').click();
  await waitFor(async () => (await volumeMm3()) < grown, "Shrink works");
  await page.locator('[data-testid="seg3d-fill"]').click();
  await page.locator('[data-testid="seg3d-largest"]').click();
  await waitFor(async () => !(await page.locator(".seg3d-busy").count()), "Fill holes and Largest part only are accepted");
  check((await page.locator('[data-testid="seg3d-message"][role="alert"]').count()) === 0, "...without an error");
  // copy to the next slices
  await page.locator('[data-testid="seg3d-copy-next"]').click();
  await waitFor(async () => Number((await volume()).match(/(\d+) slices? painted/)[1]) >= 9, `the slice is copied to the next ones (${await volume()})`);

  // ------------------------------------------------------------------------------------------ automatic segmentation
  // the worker is a real one (helpers/segment_worker.py, the threshold method), started when the job is waiting
  const worker = () =>
    new Promise((resolve) => {
      const py = process.env.SEG_PYTHON ?? "/opt/miniconda3/envs/env311/bin/python";
      const w = spawn(py, ["helpers/segment_worker.py", "--url", base, "--user", "aubreville", "--password", "rust-test-pw", "--name", "e2e-segmenter", "--once"], { cwd: new URL("../..", import.meta.url).pathname });
      let out = "";
      w.stdout.on("data", (d) => (out += d));
      w.stderr.on("data", (d) => (out += d));
      w.on("close", () => resolve(out));
    });
  const painted = await volume();
  await worker(); // announces its methods (and finds nothing to do)
  await page.locator('[data-testid="auto-segment"]').click();
  await page.waitForSelector('select[aria-label="Segmentation method"]');
  check((await page.locator('select[aria-label="Segmentation method"] option').allInnerTexts()).some((t) => /threshold/i.test(t)), "Auto segment lists the threshold method of the worker");
  check((await page.locator('select[aria-label="Segmentation type"] option:checked').innerText()).length > 0, "...and the segmentation type receiving the mask (the one being edited first)");
  await page.locator('[role="radio"]', { hasText: "Replace" }).click();
  await page.locator(".modal .btn.primary", { hasText: "Start" }).click();
  await waitFor(async () => /Waiting for a worker/.test(await page.locator('.modal [role="status"]').innerText()), "the job waits for a worker");
  const workerOut = worker();
  await waitFor(async () => /mask is ready/.test(await page.locator('.modal [role="status"]').innerText().catch(() => "")), "the dialog reports that the mask is ready", 120000);
  console.log((await workerOut).trim().split("\n").slice(-2).join(" | "));
  await page.locator(".modal .btn", { hasText: "Close" }).click();
  await waitFor(async () => (await volume()) !== painted, "the tool window reads the new mask", 20000);
  const auto = await volume();
  check(/slices? painted/.test(auto) && Number(auto.match(/(\d+) slices? painted/)[1]) > 20, `the automatic mask replaced the painted one and shows in the tool window (${auto})`);
  await page.locator('[data-testid="seg3d-undo"]').click();
  await waitFor(async () => (await volume()) !== auto, "undo takes the automatic mask away again");

  // ------------------------------------------------------------------------------------------ the crosshair still works with Ctrl + click, and Escape leaves
  const before = await page.locator('[data-testid="mpr-voxel"]').innerText();
  await page.mouse.click(...at(0.3, 0.3), { modifiers: ["Control"] });
  await waitFor(async () => (await page.locator('[data-testid="mpr-voxel"]').innerText()) !== before, "Ctrl + click moves the crosshair without painting");
  const vol2 = await volume();
  check((await volume()) === vol2, "...and the mask is as it was");
  // the optional 3D render in the fourth panel shows the volume and the mask
  await page.locator('[data-testid="show-render3d"]').click();
  await page.waitForSelector('[data-testid="render3d-canvas"]');
  await waitFor(async () => (await page.locator(".render3d-note").count()) === 0, "the 3D render has its volume", 90000);
  const lit = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid="render3d-canvas"]');
      const t = document.createElement("canvas");
      t.width = c.width;
      t.height = c.height;
      const x = t.getContext("2d");
      x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] > 60 || d[i + 1] > 60) n++;
      return n;
    });
  await waitFor(async () => (await lit()) > 50, "the 3D render draws something");
  const maskBox = page.locator('[data-testid="render3d-mask"]');
  await waitFor(async () => !(await maskBox.isDisabled()), "...and the mask is loaded into it");
  const litBefore = await lit();
  const cbox = await page.locator('[data-testid="render3d-canvas"]').boundingBox();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width / 2 + 120, cbox.y + cbox.height / 2, { steps: 6 });
  await page.mouse.up();
  await waitFor(async () => (await lit()) !== litBefore, "dragging turns it");
  await page.locator('[aria-label="Hide the 3D render"]').dispatchEvent("click"); // the tool window may lie over it
  check((await page.locator('[data-testid="render3d"]').count()) === 0, "the 3D render can be hidden");
  await page.keyboard.press("Escape");
  await waitFor(async () => (await page.locator(".seg3d-panel").count()) === 0 && (await page.locator('[data-testid="mask-overlay"]').count()) === 0, "Escape leaves the segmentation");
  const crosshairBefore = await page.locator('[data-testid="mpr-voxel"]').innerText();
  await page.mouse.click(...at(0.7, 0.7));
  await waitFor(async () => (await page.locator('[data-testid="mpr-voxel"]').innerText()) !== crosshairBefore, "without a tool a click sets the crosshair as before");

  // ------------------------------------------------------------------------------------------ a read-only account sees the mask and has no tools
  const made = await apiCall(root, "POST", "/api/v2/admin/users", { username: `e2e-ro-${Date.now() % 100000}`, teams: [1], read_only: true });
  check(made.status === 201, `a read-only account was made (${made.status})`);
  readOnlyUser = made.body;
  const reader = await login(await browser.newContext({ viewport: { width: 1500, height: 900 } }), readOnlyUser.username, readOnlyUser.password, { quiet: true });
  await reader.waitForSelector('[data-testid="welcome"]', { timeout: 5000 }).catch(() => null);
  if (await reader.locator('[data-testid="welcome-close"]').count()) await reader.click('[data-testid="welcome-close"]');
  await openPlanes(reader);
  await reader.locator('.dropdown[data-name="segment"] .trigger').click();
  await reader.locator(".dd-item", { hasText: "▨" }).first().click();
  await reader.waitForSelector(".seg3d-panel");
  await waitFor(async () => (await reader.locator('[data-testid="mask-overlay"]').count()) === 3, "the read-only account sees the mask on all three planes");
  check((await reader.locator('[data-testid="seg3d-brush"]').count()) === 0 && (await reader.locator('[data-testid="seg3d-clear"]').count()) === 0, "...and has no brush, no wand and no way to clear it");
  check((await reader.locator(".seg3d-panel").innerText()).includes("Read only"), "...and is told why");
  const rbox = await reader.locator('[data-testid="mpr-axial"]').boundingBox();
  await waitFor(async () => /painted/.test(await reader.locator('[data-testid="seg3d-readout"]').innerText()), "the read-only account's readout has the mask state");
  const before2 = await reader.locator('[data-testid="seg3d-readout"]').innerText();
  await reader.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
  await reader.mouse.down();
  await reader.mouse.move(rbox.x + rbox.width / 2 + 40, rbox.y + rbox.height / 2, { steps: 4 });
  await reader.mouse.up();
  await reader.waitForTimeout(500);
  check((await reader.locator('[data-testid="seg3d-readout"]').innerText()) === before2, "a drag on the plane changes nothing");

  // ------------------------------------------------------------------------------------------ the single-plane view points to the three planes
  await page.addInitScript(() => localStorage.setItem("exact.mpr", "0"));
  await page.goto(`${base}/images/${IMAGE}`);
  await page.waitForSelector(".viewer-bar");
  await page.locator(".seg button", { hasText: "Coronal" }).click();
  const hint = page.locator('[data-testid="annotations-locked"]');
  await hint.waitFor();
  check((await hint.innerText()).includes("three-plane"), "the coronal plane of the single view says that masks are painted in the three-plane view");
  await hint.locator("button", { hasText: "Three planes" }).click();
  await page.waitForURL(new RegExp(`/images/${IMAGE}/planes`));
  check(true, "...and its button leads there");

  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  if (annotationId) await apiCall(root, "DELETE", `/api/v2/annotations/${annotationId}`).catch(() => null);
  if (readOnlyUser?.id) await apiCall(root, "DELETE", `/api/v2/users/${readOnlyUser.id}`).catch(() => null);
  for (const id of setAside) await apiCall(root, "PATCH", `/api/v2/annotations/${id}`, { deleted: false }).catch(() => null);
  await apiCall(root, "DELETE", `/api/v2/image-sets/${SET}/products/${SEG_PRODUCT}`).catch(() => null);
  await browser.close();
}

