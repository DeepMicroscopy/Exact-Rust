// End-to-end test of segmentation files linked to a volume, in the system Chrome: drop a .seg.nrrd into an image set, the dialog
// offers the volume its name says (CT_Philips), link it, then the three-plane view draws it read-only: overlays on all planes, the
// segment panel, a segment switched off, the segment under the crosshair. Needs a freshly restored scratch database and the
// reference Python (nibabel) to write the NRRD. Usage: node e2e/linked.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const IMAGE = 80; // CT_Philips.nii.gz of image set 1
const SET = 1;

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

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exact-linked-"));
const file = path.join(dir, `CT_Philips segmentation_${Date.now() % 100000}.seg.nrrd`);
execFileSync(path.join(root, "reference/.venv/bin/python"), ["-c", `import sys; import test_v2_linked as t; open(sys.argv[1], 'wb').write(t.nrrd()[0])`, file], { cwd: path.join(root, "tests/conformance"), env: { ...process.env, EXACT_URL: base } });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/ 40[0139]|401|409/.test(m.text()) && !(/ 404/.test(m.text()) && /\/thumbnail$/.test(m.location().url)) && errors.push(`${m.text()} (${m.location().url})`)); // a card of an image that has just gone shows its placeholder
await page.goto(base);
await page.waitForSelector("form.login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.click("button.primary");
await page.waitForSelector(".cards .card");
const api = (method, url) =>
  page.evaluate(
    async ([method, url]) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      const r = await fetch(url, { method, headers: { "x-csrf-token": csrf } });
      return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
    },
    [method, url],
  );
let fileId = null;
// leftovers of an aborted run
for (const f of (await api("GET", `/api/v2/image-sets/${SET}/linked-volumes`)).body ?? []) await api("DELETE", `/api/v2/linked-volumes/${f.id}`);
for (const i of (await api("GET", `/api/v2/images?image_set=${SET}&fields=id,name&limit=200`)).body?.items ?? []) if (i.name.startsWith("tiny-")) await api("DELETE", `/api/v2/images/${i.id}`);
try {
  await page.goto(`${base}/sets/${SET}`);
  await page.waitForSelector(".tile");
  await page.setInputFiles('input[type="file"]', file);
  await page.waitForSelector('[data-testid="link-seg"]');
  check((await page.locator('[data-testid="link-seg"] .seg-list li').count()) === 2, "the dialog lists the two segments of the file");
  const picked = await page.locator('[data-testid="link-volume"]').inputValue();
  check(picked === String(IMAGE), "the volume the file name says is chosen (CT_Philips)");
  await page.screenshot({ path: shots ? `${shots}/linked-dialog.png` : undefined }).catch(() => null);
  await page.click('[data-testid="link-go"]');
  await page.waitForSelector('[data-testid="link-seg"]', { state: "detached" });
  await page.waitForSelector('[data-testid="seg-tile"]');
  const tile = page.locator('[data-testid="seg-tile"]');
  check(/on CT_Philips\.nii\.gz/.test((await tile.textContent()) ?? ""), "the file is a card in the image grid, on its volume");
  await waitFor(() => tile.locator("img.thumb").evaluate((i) => i.complete && i.naturalWidth > 0), "the card has a picture");
  fileId = (await api("GET", `/api/v2/image-sets/${SET}/linked-volumes`)).body[0].id;
  if (shots) await page.screenshot({ path: `${shots}/linked-card.png` });

  // a click on the card opens the three planes of its volume
  await tile.locator("button.seg-open").click();
  await page.waitForURL(new RegExp(`/images/${IMAGE}/planes`));
  await page.waitForSelector('[data-testid="linked-file"]');
  const overlays = () => page.locator('img[data-testid="mask-overlay"][data-url*="/linked-volumes/"]');
  await waitFor(async () => (await overlays().count()) === 3 && (await page.evaluate(() => [...document.querySelectorAll('img[data-testid="mask-overlay"]')].every((i) => i.complete && i.naturalWidth > 0))), "three overlays, one per plane, are loaded");
  check(true, "the linked file is drawn over all three planes");
  await waitFor(async () => /Ball/.test((await page.locator('[data-testid="linked-here"]').textContent()) ?? ""), "the segment under the crosshair is named");
  check(true, "the panel names the segment under the crosshair (Ball)");
  if (shots) await page.screenshot({ path: `${shots}/linked-planes.png` });

  // the 3D render draws the segments in their colours
  await page.locator('[data-testid="show-render3d"]').click();
  await page.waitForSelector('[data-testid="render3d-canvas"]');
  await waitFor(async () => (await page.locator(".render3d-note").count()) === 0, "the 3D render has its volume", 90000);
  const seg3d = page.locator('[data-testid="render3d-seg"]');
  await waitFor(async () => (await seg3d.count()) === 1 && (await seg3d.isEnabled()) && (await seg3d.isChecked()), "the Segmentation checkbox of the 3D render is on", 60000);
  check((await page.locator('[data-testid="render3d-mask"]').count()) === 0, "no dead Mask checkbox beside it while no annotation mask is chosen");
  const cb = await page.locator('[data-testid="render3d-canvas"]').boundingBox();
  const painted = (box) => page.evaluate(({ x, y, w, h }) => {
    const c = document.querySelector('[data-testid="render3d-canvas"]');
    const r = c.getBoundingClientRect();
    const t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    t.getContext("2d").drawImage(c, 0, 0);
    const d = t.getContext("2d").getImageData(0, 0, t.width, t.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++;
      if (d[i + 2] > 150 && d[i] < 90 && d[i + 1] < 90) blue++;
    }
    return { red, blue };
  }, box);
  if (shots) await page.screenshot({ path: `${shots}/linked-3d-image.png` });
  // the ball lies inside the head: with the image on, the bone is in front of it
  await page.getByRole("checkbox", { name: "Image" }).uncheck();
  await new Promise((r) => setTimeout(r, 1500));
  if (shots) await page.screenshot({ path: `${shots}/linked-3d-noimage.png` });
  const withSeg = await waitFor(async () => { const p = await painted(cb); return p.red > 3 ? p : null; }, "the ball is drawn in red in 3D", 30000);
  check(withSeg.red > 3, `the red ball is in the 3D render (${withSeg.red} px)`);
  if (shots) await page.screenshot({ path: `${shots}/linked-3d.png` });
  await seg3d.uncheck();
  await waitFor(async () => (await painted(cb)).red === 0, "the ball goes when the checkbox is off");
  check(true, "the Segmentation checkbox switches the 3D labels off");
  await seg3d.check();

  await page.getByRole("checkbox", { name: "Ball" }).uncheck();
  await waitFor(async () => (await page.locator('img[data-testid="mask-overlay"][data-url*="hide=0"]').count()) === 3, "all planes reload without the Ball");
  check(true, "a segment switched off in the panel is hidden on every plane");
  await page.getByRole("checkbox", { name: /^Show / }).uncheck();
  await waitFor(async () => (await overlays().count()) === 0, "the overlays go when the file is switched off");
  check(true, "switching the file off removes its overlays");

  // step two: the segments become mask annotations, in new types named after them
  await page.getByRole("checkbox", { name: /^Show / }).check();
  await page.locator('[data-testid="import-open"]').click();
  await page.waitForSelector('[data-testid="import-seg"]');
  check((await page.locator('[data-testid="import-row"]').count()) === 2, "the import dialog lists the two segments");
  // a type of the segment's name is chosen when there is one (an earlier run leaves its types behind: a type used by an annotation, also a
  // deleted one, cannot be deleted), else a new type is offered
  const known = (await api("GET", "/api/v2/annotation-types?fields=id,name&limit=500")).body.items.filter((t) => ["Ball", "Cube"].includes(t.name));
  check((await page.getByLabel("Type for Ball").inputValue()) === (known.find((t) => t.name === "Ball")?.id.toString() ?? "new"), "a segment gets the type of its name, or a new type");
  await page.screenshot({ path: shots ? `${shots}/linked-import.png` : undefined }).catch(() => null);
  await page.locator('[data-testid="import-go"]').click();
  await waitFor(async () => (await page.locator('[data-testid="import-row"] .ok').count()) === 2, "both segments are imported", 60000);
  check(true, "both segments were imported");
  const types = (await api("GET", "/api/v2/annotation-types?fields=id,name&limit=500")).body.items.filter((t) => ["Ball", "Cube"].includes(t.name));
  check(types.length === 2, "the types Ball and Cube exist now");
  const masks = (await api("GET", `/api/v2/annotations?image=${IMAGE}&fields=id,annotation_type,deleted&limit=500`)).body.items.filter((a) => !a.deleted && types.some((t) => t.id === a.annotation_type));
  check(masks.length === 2, "each has a mask annotation in the volume");
  const ball = types.find((t) => t.name === "Ball");
  const vol = (await api("GET", `/api/v2/segmentation/${masks.find((m) => m.annotation_type === ball.id).id}/volume`)).body;
  check(vol.count > 500, `the Ball mask holds its voxels (${vol.count})`);
  // export: the masks of the volume as a Slicer segmentation
  await page.locator(".modal-actions button", { hasText: "Close" }).click();
  await page.locator('[data-testid="dropdown-export-masks"], button:has-text("Export masks")').first().click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByText("3D Slicer segmentation (.seg.nrrd)").click()]);
  check(download.suggestedFilename() === "CT_Philips-segmentation.seg.nrrd", `the export is named after the volume (${download.suggestedFilename()})`);
  const exported = fs.readFileSync(await download.path());
  check(exported.subarray(0, 8).toString() === "NRRD0004" && exported.includes("Segment0_Name:=") && exported.includes("Ball"), "the export is a Slicer segmentation with the segment Ball");
  for (const m of masks) await api("DELETE", `/api/v2/annotations/${m.id}`); // soft delete: the types stay

  // two segmentations of one volume: a click on a card shows that one only, the volume's own page the newest
  const second = path.join(dir, `CT_Philips second_${Date.now() % 100000}.seg.nrrd`);
  execFileSync(path.join(root, "reference/.venv/bin/python"), ["-c", `import sys; import test_v2_linked as t; open(sys.argv[1], 'wb').write(t.nrrd()[0])`, second], { cwd: path.join(root, "tests/conformance"), env: { ...process.env, EXACT_URL: base } });
  await page.goto(`${base}/sets/${SET}`);
  await page.waitForSelector(".tile");
  await page.setInputFiles('input[type="file"]', second);
  await page.waitForSelector('[data-testid="link-seg"]');
  await page.click('[data-testid="link-go"]');
  await page.waitForSelector('[data-testid="link-seg"]', { state: "detached" });
  const both = (await api("GET", `/api/v2/image-sets/${SET}/linked-volumes`)).body.filter((f) => f.image === IMAGE);
  const fileA = both.find((f) => path.basename(file) === f.filename);
  const fileB = both.find((f) => path.basename(second) === f.filename);
  check(!!fileA && !!fileB, "two segmentation files are linked to the volume");
  const drawn = () => page.evaluate(() => [...document.querySelectorAll('img[data-testid="mask-overlay"][data-url*="/linked-volumes/"]')].map((i) => i.getAttribute("data-url").match(/linked-volumes\/(\d+)\//)[1]));
  for (const [open, other, name] of [[fileA, fileB, path.basename(file)], [fileB, fileA, path.basename(second)]]) {
    await page.goto(`${base}/sets/${SET}`);
    await page.locator(".seg-tile", { hasText: name }).locator("button.seg-open").click();
    await page.waitForURL(new RegExp(`/images/${IMAGE}/planes\\?seg=${open.id}`));
    await waitFor(async () => (await drawn()).length === 3, "the opened file is drawn on the three planes");
    check((await drawn()).every((id) => id === String(open.id)), `opening ${name} shows only that file`);
    check((await page.getByRole("checkbox", { name: `Show ${open.name}` }).isChecked()) && !(await page.getByRole("checkbox", { name: `Show ${other.name}` }).isChecked()), "the window has the other file, unticked");
  }
  await page.goto(`${base}/images/${IMAGE}/planes`);
  await page.waitForSelector('[data-testid="linked-toggle"]');
  await page.waitForTimeout(800);
  check((await drawn()).length === 0 && (await page.locator('[data-testid="linked-file"]').count()) === 0, "the volume opened by itself shows no linked file and keeps the window closed");
  await page.locator('[data-testid="linked-toggle"]').click();
  check((await page.locator('[data-testid="linked-file"]').count()) > 0, "the button opens the window");
  await api("DELETE", `/api/v2/linked-volumes/${fileB.id}`);

  // an NRRD that was uploaded as an image (before segmentation files existed): a click offers to convert it; the viewer page does too
  const legacy = () => JSON.parse(execFileSync(path.join(root, "reference/.venv/bin/python"), ["-c", `import json; import test_v2_linked as t; i, n = t.old_nrrd_image(None); print(json.dumps([i, n]))`], { cwd: path.join(root, "tests/conformance"), env: { ...process.env, EXACT_URL: base } }).toString().trim().split("\n").pop());
  const [oldId, oldName] = legacy();
  await page.goto(`${base}/sets/${SET}`);
  const oldTile = page.locator(".tile:not(.seg-tile)", { hasText: oldName });
  await oldTile.waitFor();
  check((await oldTile.locator(".seg-badge").count()) === 1, "an NRRD image is marked as a possible segmentation file");
  await oldTile.locator("a.tile-link").click();
  await page.waitForSelector('[data-testid="convert-seg"]');
  check(page.url().includes(`/sets/${SET}`), "a click on it asks instead of opening a viewer that cannot show it");
  await page.screenshot({ path: shots ? `${shots}/linked-convert.png` : undefined }).catch(() => null);
  await page.click('[data-testid="convert-go"]');
  await page.waitForSelector('[data-testid="link-seg"]');
  check((await page.locator('[data-testid="link-volume"]').inputValue()) === String(IMAGE), "after converting, the link dialog offers the volume of that name");
  await page.click('[data-testid="link-go"]');
  await page.waitForSelector('[data-testid="link-seg"]', { state: "detached" });
  // linking from here goes on to the volume, as a click on the card of an unlinked file does
  await page.waitForURL(new RegExp(`/images/${IMAGE}/planes`));
  await page.goto(`${base}/sets/${SET}`);
  await waitFor(async () => (await page.locator(".tile:not(.seg-tile)", { hasText: oldName }).count()) === 0 && (await page.locator(".seg-tile", { hasText: oldName }).count()) === 1, "the image entry is a segmentation card now");
  check(true, "the old NRRD image is a linked segmentation file now");
  for (const f of (await api("GET", `/api/v2/image-sets/${SET}/linked-volumes`)).body) if (f.filename === oldName) await api("DELETE", `/api/v2/linked-volumes/${f.id}`);
  // the viewer page of such an image asks too, and "Not now" goes back to the image set
  const [oldId2, oldName2] = legacy();
  await page.goto(`${base}/images/${oldId2}`);
  await page.waitForSelector('[data-testid="convert-seg"]');
  await page.getByRole("button", { name: "Not now" }).click();
  await page.waitForURL(new RegExp(`/sets/${SET}$`));
  check(true, "the viewer page of an NRRD image offers the conversion, Not now returns to the set");
  await api("DELETE", `/api/v2/images/${oldId2}`);

  // deleting a volume asks what becomes of its segmentation file: keep it (unlinked) or delete it too
  const tinyName = `tiny-${Date.now() % 100000}`;
  execFileSync(path.join(root, "reference/.venv/bin/python"), ["-c", `import sys, numpy as np, nibabel as nib; import test_v2_linked as t
img = nib.Nifti1Image((np.arange(16**3) % 200).astype(np.int16).reshape(16, 16, 16), np.diag([1.0, 1.0, 1.0, 1.0]))
open(sys.argv[1] + '.nii', 'wb').write(img.to_bytes()); open(sys.argv[1] + ' segmentation_1.seg.nrrd', 'wb').write(t.nrrd(img=img)[0])`, path.join(dir, tinyName)], { cwd: path.join(root, "tests/conformance"), env: { ...process.env, EXACT_URL: base } });
  await page.goto(`${base}/sets/${SET}`);
  await page.waitForSelector(".tile");
  await page.setInputFiles('input[type="file"]', path.join(dir, `${tinyName}.nii`));
  await page.waitForSelector(`.tile:has-text("${tinyName}.nii")`);
  await page.setInputFiles('input[type="file"]', path.join(dir, `${tinyName} segmentation_1.seg.nrrd`));
  await page.waitForSelector('[data-testid="link-seg"]');
  check((await page.locator('[data-testid="link-volume"]').inputValue()) !== "", "the tiny volume is chosen for its file");
  await page.click('[data-testid="link-go"]');
  await page.waitForSelector('[data-testid="link-seg"]', { state: "detached" });
  const tinyCard = page.locator(".tile", { hasText: `${tinyName} segmentation_1` });
  await tinyCard.waitFor();
  const volumeTile = page.locator('.tile:not(.seg-tile)', { hasText: `${tinyName}.nii` });
  const askDelete = async () => {
    await volumeTile.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: "Delete…" }).click();
    await page.waitForSelector('[data-testid="delete-seg-choice"]');
  };
  await askDelete();
  check((await page.getByRole("radio", { name: /Keep it in the image set/ }).isChecked()), "the choice defaults to keeping the file");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await new Promise((r) => setTimeout(r, 3000));
  if (shots) await page.screenshot({ path: `${shots}/linked-delete.png` });
  await waitFor(async () => (await page.locator(".tile", { hasText: `${tinyName}.nii` }).count()) === 0 || (await page.locator('.tile:not(.seg-tile)', { hasText: `${tinyName}.nii` }).count()) === 0, "the volume is gone");
  await page.locator(".modal-actions button", { hasText: "Close" }).click();
  await waitFor(async () => /not linked/.test((await page.locator(".seg-tile", { hasText: tinyName }).textContent().catch(() => "")) ?? ""), "the segmentation file stays, now not linked");
  check(true, "deleting the volume kept its segmentation file, unlinked");
  const left = (await api("GET", `/api/v2/image-sets/${SET}/linked-volumes`)).body.find((f) => f.filename.startsWith(tinyName));
  if (left) await api("DELETE", `/api/v2/linked-volumes/${left.id}`);
} finally {
  if (fileId != null) await api("DELETE", `/api/v2/linked-volumes/${fileId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  await browser.close();
}
check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log("linked: all ok");
