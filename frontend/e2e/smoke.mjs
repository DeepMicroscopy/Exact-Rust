// End-to-end smoke test in the system Chrome against a running server (default http://127.0.0.1:8002).
// Usage: node e2e/smoke.mjs [baseUrl]   (env: CHROME, EXACT_USER, EXACT_PW, SHOTS=dir for screenshots)
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const user = process.env.EXACT_USER ?? "rt_member";
const pw = process.env.EXACT_PW ?? "rust-test-pw";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// the anonymous /auth/me probe on the login screen legitimately answers 401
page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(m.text()));
const shot = (n) => shots && page.screenshot({ path: `${shots}/${n}.png` });
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};

async function openImage(id) {
  await page.goto(`${base}/images/${id}`);
  await page.waitForSelector(".openseadragon-canvas canvas", { state: "attached" });
}

const sample = () =>
  page.evaluate(() => {
    // the drawing canvas of the viewer is the first canvas under the OSD canvas element (the annotation overlay follows)
    const c = [...document.querySelectorAll(".openseadragon-canvas canvas")].find((x) => x.height > 10);
    if (!c) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n;
  });

// waits (up to 30 s) until the viewer has painted a reasonable amount of image
async function waitPainted(msg) {
  let painted = 0;
  for (let t = 0; t < 60 && painted <= 20; t++) {
    await page.waitForTimeout(500);
    painted = await sample();
  }
  await page.waitForTimeout(800);
  painted = await sample();
  check(painted > 20, `${msg} (${painted} bright samples)`);
}

try {
  await page.goto(base);
  await page.waitForSelector("form.login");
  await shot("1-login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pw);
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  check((await page.locator(".cards .card").count()) > 0, "index lists image sets");
  await page.waitForTimeout(800);
  await shot("2-index");

  await page.locator(".cards .card").first().click();
  await page.waitForSelector(".grid .tile");
  check((await page.locator(".grid .tile").count()) > 0, "image set lists images");
  await page.waitForTimeout(1200);
  await shot("3-set");

  await page.locator(".grid .tile").first().click();
  await waitPainted("first image of the set renders tiles");
  await shot("4-viewer");

  // volume (NIfTI): the three MPR planes and the frame slider
  await openImage(82);
  await waitPainted("NIfTI axial renders");
  for (const plane of ["Coronal", "Sagittal"]) {
    await page.click(`.seg button:has-text("${plane}")`);
    await page.waitForTimeout(500);
    await waitPainted(`NIfTI ${plane.toLowerCase()} renders`);
  }
  await shot("5-volume");
  check((await page.locator('.zslider:not(.blend) input[type="range"]').count()) === 1, "volume: vertical slider without blending on the right");
  check((await page.locator(".viewer-foot").count()) === 0, "volume: no bottom slider");
  await page.locator(".zslider input").fill("40");
  await page.waitForTimeout(600);
  await waitPainted("volume slice 41 renders");
  const volOpacities = await page.evaluate(() => { const w = window.__viewer.world; return [...Array(w.getItemCount()).keys()].map((i) => w.getItemAt(i).getOpacity()).filter((o) => o > 0.01); });
  check(volOpacities.length === 1 && volOpacities[0] === 1, "volume: exactly one slice visible (no blending)");

  // multi-series OME-TIFF z-stack (microscopy): vertical slider on the right with real positions, planes are cross-faded
  await openImage(57);
  await waitPainted("z-stack renders");
  check((await page.locator(".zslider.blend").count()) === 1 && (await page.locator(".viewer-foot").count()) === 0, "z-stack: vertical slider on the right, nothing at the bottom");
  const ends = await page.locator(".zslider-end").allInnerTexts();
  check(ends.length === 2 && ends[0].includes("+1.5 µm") && ends[1].includes("−6.0 µm"), `z-stack: slider ends show the real positions (${ends.join(" / ")})`);
  await page.locator(".zslider input").fill("5");
  await page.waitForTimeout(700);
  check((await page.locator(".zslider-current").innerText()).includes("6 / 16"), "z-stack: current plane follows the slider");
  await page.locator(".zslider input").fill("5.5");
  await page.waitForTimeout(1500);
  const blended = await page.evaluate(() => { const w = window.__viewer.world; return [...Array(w.getItemCount()).keys()].map((i) => w.getItemAt(i).getOpacity()).filter((o) => o > 0.01).sort(); });
  check(blended.length === 2 && Math.abs(blended[0] - 0.5) < 0.02 && blended[1] === 1, `z-stack: at 5.5 two planes are cross-faded (opacities ${blended.join(", ")})`);
  await waitPainted("z-stack blended view renders");
  await shot("5b-zstack");
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(900);
  const afterKey = await page.locator(".zslider-current").innerText();
  check(afterKey.includes("7 / 16") || afterKey.includes("8 / 16"), `z-stack: Page Up steps to the next plane (${afterKey.replace(/\n/g, " ")})`);

  // jumping along the stack keeps the zoom and position (a jump beyond the preloaded planes must not reset the view)
  await page.evaluate(() => { const v = window.__viewer.viewport; v.zoomTo(v.getHomeZoom() * 3, undefined, true); v.panTo(new window.__osd.Point(0.3, 0.2 * v.getHomeBounds().height), true); });
  await page.waitForTimeout(400);
  const view0 = await page.evaluate(() => { const v = window.__viewer.viewport; return { z: v.getZoom(true), c: v.getCenter(true) }; });
  await page.locator(".zslider input").fill("14");
  await page.waitForTimeout(1500);
  await page.locator(".zslider input").fill("1");
  await page.waitForTimeout(1500);
  const view1 = await page.evaluate(() => { const v = window.__viewer.viewport; return { z: v.getZoom(true), c: v.getCenter(true) }; });
  check(Math.abs(view1.z - view0.z) < 1e-6 && Math.abs(view1.c.x - view0.c.x) < 1e-6 && Math.abs(view1.c.y - view0.c.y) < 1e-6,
    `z-stack: zoom and position are kept when jumping along the stack (${view0.z.toFixed(3)} -> ${view1.z.toFixed(3)})`);

  // video: horizontal slider at the bottom, no vertical one
  await openImage(69);
  await waitPainted("video renders");
  check((await page.locator(".zslider").count()) === 0 && (await page.locator(".viewer-foot input").count()) === 1, "movie: horizontal slider at the bottom only");
  await page.locator(".viewer-foot input").fill("100");
  await page.waitForTimeout(500);
  await waitPainted("video frame 101 renders");
  check((await page.locator(".viewer-foot").innerText()).includes("101 / 215"), "movie: frame label follows the slider");
  await shot("6-video");
  // play / pause on the left of the slider, right click chooses the speed
  check((await page.locator(".viewer-foot .play-btn").count()) === 1, "movie: a play button sits next to the frame slider");
  const f0 = await page.locator(".viewer-foot .time-current").innerText();
  await page.locator(".viewer-foot .play-btn").click();
  await page.waitForTimeout(1200);
  const f1 = await page.locator(".viewer-foot .time-current").innerText();
  check(f1 !== f0, `movie: playing advances the frames (${f0.replace(/\s+/g, " ")} -> ${f1.replace(/\s+/g, " ")})`);
  check((await page.locator(".viewer-foot .play-btn").getAttribute("aria-label")) === "Pause", "movie: the button becomes Pause while playing");
  await page.locator(".viewer-foot .play-btn").click();
  const p1 = await page.locator(".viewer-foot .time-current").innerText();
  await page.waitForTimeout(600);
  check((await page.locator(".viewer-foot .time-current").innerText()) === p1, "movie: pausing stops at the current frame");
  await page.locator(".viewer-foot .play-btn").click({ button: "right" });
  await page.waitForSelector(".fps-menu");
  const items = await page.locator(".fps-menu button[role=menuitemradio]").allInnerTexts();
  check(items.some((t) => t.includes("Movie's own")) && items.some((t) => t.trim().startsWith("24")), `movie: right click offers the movie's own speed and presets (${items.length} entries)`);
  await page.locator(".fps-menu button", { hasText: /^1\s*$/ }).first().click();
  check((await page.locator(".viewer-foot .play-btn").getAttribute("title")).includes("1 frames per second"), "movie: a chosen speed is in use");

  // an image that does not exist: nothing of the image shown before may stay on the canvas
  const known = errors.length;
  await page.evaluate(() => {
    history.pushState({}, "", "/images/99999999");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForSelector('[data-testid="viewer-error"]');
  check((await page.locator(".osd.osd-hidden").count()) === 1 && (await page.evaluate(() => window.__viewer.world.getItemCount())) === 0, "an unknown image shows an error, not the image seen before");
  check((await page.locator('[data-testid="viewer-error"]').innerText()).includes("99999999"), "...which names the image");
  errors.length = known; // the 404 is expected
  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  await browser.close();
}
