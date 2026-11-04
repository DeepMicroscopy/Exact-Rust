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
// volumes open in the three-plane view by default; the checks of the single-plane view ask for it
await page.addInitScript(() => localStorage.getItem("exact.mpr") === null && localStorage.setItem("exact.mpr", "0"));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
// the anonymous /auth/me probe on the login screen legitimately answers 401
page.on("console", (m) => m.type() === "error" && !/ 40[01]/.test(m.text()) && errors.push(m.text())); // the unknown-image check provokes a 400
const waitFor = async (fn, msg, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 150));
  }
};
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

  await page.locator(".side-item").first().click();
  await page.locator(".btn", { hasText: "Statistics" }).click();
  await page.waitForSelector('[data-testid="statistics"]');
  check((await page.locator('[data-testid="statistics"]').innerText()).includes("on disk"), "team statistics show storage, file types and annotations");
  await page.locator(".modal .btn.primary", { hasText: "Done" }).click();
  await page.locator(".side-item").first().click();
  await page.locator(".cards .card").first().click();
  await page.waitForSelector(".grid .tile");
  check((await page.locator(".grid .tile").count()) > 0, "image set lists images");
  await page.waitForTimeout(1200);
  await shot("3-set");

  await page.locator(".grid .tile").first().click();
  await waitPainted("first image of the set renders tiles");
  await shot("4-viewer");

  // old navigation (a personal setting, off by default): a click on the background zooms in, Shift + click out, a drag moves the slide
  {
    // the first image of the set is small: it could not be zoomed in any further than it is shown, so the limit is lifted for the test
    await page.evaluate(() => { window.__viewer.viewport.maxZoomLevel = 20; });
    const zoomRaw = () => page.evaluate(() => window.__viewer.viewport.getZoom());
    /** the zoom once the animation has settled */
    const zoomNow = async () => {
      let a = await zoomRaw();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(250);
        const b = await zoomRaw();
        if (Math.abs(b / a - 1) < 1e-4) return b;
        a = b;
      }
      return a;
    };
    /** the Preferences page is where the navigation is chosen; back in the viewer the view is the same as before */
    const setNav = async (mode) => {
      await page.goto(base + "/preferences");
      await page.locator(`[data-testid="nav-${mode}"]`).click();
      await waitFor(async () => (await page.locator(`[data-testid="nav-${mode}"]`).getAttribute("aria-checked")) === "true", `the ${mode} navigation is selected on the Preferences page`);
      await page.goBack();
      await page.waitForSelector(".openseadragon-canvas");
      await page.waitForTimeout(1500);
      await page.evaluate(() => { window.__viewer.viewport.maxZoomLevel = 20; });
    };
    const centre = () => page.evaluate(() => { const c = window.__viewer.viewport.getCenter(); return [c.x, c.y]; });
    const corner = await page.evaluate(() => { const p = window.__viewer.viewport.imageToViewerElementCoordinates(new window.__osd.Point(8, 8)); const r = window.__viewer.canvas.getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }).catch(() => null);
    if (!corner) check(false, "the viewer exposes OpenSeadragon for the navigation test");
    else {
      const [cx, cy] = corner;
      const z0 = await zoomNow();
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(300);
      check(Math.abs((await zoomNow()) / z0 - 1) < 0.01, "by default a click on the background does not zoom");
      await setNav("mouse");
      const saved = await page.evaluate(async () => (await (await fetch("/api/v2/me/preferences")).json()).legacy_navigation);
      check(saved === true, "...and saved with the account");
      const zOn = await zoomNow();
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(900);
      const z1 = await zoomNow();
      check(Math.abs(z1 / zOn - 2) < 0.05, `old navigation: a click on the background zooms in (x${(z1 / zOn).toFixed(2)}, before the switch ${zOn.toFixed(3)} / ${z0.toFixed(3)})`);
      await page.keyboard.down("Shift");
      await page.mouse.click(cx, cy);
      await page.keyboard.up("Shift");
      await page.waitForTimeout(900);
      check(Math.abs((await zoomNow()) / z1 - 0.5) < 0.05, "...and Shift + click zooms out");
      const c0 = await centre();
      await page.mouse.move(cx + 60, cy + 60);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy + 100, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(900);
      const c1 = await centre();
      check(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) > 1e-4 && (await page.locator(".openseadragon-canvas").count()) > 0, "...and a drag on the background moves the slide (no selection frame)");
      await setNav("touch");
      
    }
  }

  // the overview (navigator): a button on it hides it, the viewer bar brings it back
  {
    const shown = () => page.evaluate(() => { const n = document.querySelector(".openseadragon-container .navigator"); return !!n && getComputedStyle(n).display !== "none"; });
    await waitFor(shown, "the overview is shown by default");
    await page.locator('[data-testid="overview-hide"]').click();
    await waitFor(async () => !(await shown()), "the button on the overview hides it");
    check((await page.locator('[data-testid="overview-toggle"]').getAttribute("aria-pressed")) === "false", "...and the viewer bar shows that it is hidden");
    await page.reload();
    await page.waitForSelector(".openseadragon-canvas");
    check(!(await shown()), "...it stays hidden after a reload");
    await page.locator('[data-testid="overview-toggle"]').click();
    await waitFor(shown, "the viewer bar button shows it again");
  }

  // the user menu and the Preferences page
  {
    const viewerUrl = page.url();
    await page.goto(base + "/");
    await page.waitForSelector('[data-testid="user-menu"]');
    check((await page.locator('[data-testid="menu-preferences"]').count()) === 0, "the user menu is closed at first");
    await page.locator('[data-testid="user-menu"]').click();
    const items = await page.locator('.user-pop [role="menuitem"]').allInnerTexts();
    check(items.join("|") === "Preferences|User statistics|Sign out", `the user menu offers Preferences, User statistics, Sign out (${items.join("|")})`);
    await page.locator('[data-testid="menu-user-statistics"]').click();
    await page.waitForSelector('[data-testid="user-statistics"]');
    check((await page.locator('[data-testid="user-statistics"] .day-bars span').count()) === 30, "the user statistics show the last 30 days");
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="user-menu"]').click();
    await page.locator('[data-testid="menu-preferences"]').click();
    await page.waitForSelector('[data-testid="preferences"]');
    const mail = await page.locator('[data-testid="pref-email"]').inputValue();
    await page.locator('[data-testid="pref-email"]').fill("prefs-test@example.org");
    await page.locator('[data-testid="pref-email"]').press("Enter");
    await waitFor(async () => (await page.evaluate(async () => (await (await fetch("/api/v2/me/account")).json()).email)) === "prefs-test@example.org", "the email address is changed on the Preferences page");
    await page.locator('[data-testid="pref-email"]').fill(mail);
    await page.locator('[data-testid="pref-email"]').press("Enter");
    await waitFor(async () => (await page.evaluate(async () => (await (await fetch("/api/v2/me/account")).json()).email)) === mail, "...and restored");
    await page.locator('[data-testid="pref-pw-current"]').fill("not the password");
    await page.locator('[data-testid="pref-pw-new"]').fill("Some-new-Pass-phrase-77");
    await page.locator('[data-testid="pref-pw-again"]').fill("Some-new-Pass-phrase-77");
    await page.locator('[data-testid="pref-pw-save"]').click();
    await page.waitForSelector('[data-testid="preferences"] .col [role="alert"]');
    check(true, "a wrong current password is refused");
    check((await page.locator('[data-testid="passkey-list"]').count()) === 1, "the passkeys are listed");
    check((await page.locator('[data-testid="nav-touch"]').getAttribute("aria-checked")) === "true" && (await page.locator('[data-testid="nav-mouse"]').getAttribute("aria-checked")) === "false", "the slide navigation is trackpad / tablet by default");
    check((await page.locator(".nav-demo").count()) === 2, "each navigation comes with an animation");
    await page.goto(viewerUrl);
    await page.waitForSelector(".openseadragon-canvas");
    await page.waitForTimeout(1500);
  }

  // keyboard: the list of keys, the search field, Preferences, the overview
  {
    const viewerUrl = page.url();
    check((await page.locator('[data-testid="overview-toggle"]').getAttribute("aria-pressed")) === "true", "the overview is shown before the H key");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("h");
    await waitFor(async () => (await page.locator('[data-testid="overview-toggle"]').getAttribute("aria-pressed")) === "false", "H hides the overview");
    await page.keyboard.press("h");
    await waitFor(async () => (await page.locator('[data-testid="overview-toggle"]').getAttribute("aria-pressed")) === "true", "...and shows it again");
    await page.keyboard.press("Shift+Slash");
    await page.waitForSelector('[data-testid="keyboard-view"]');
    await page.locator('[data-testid="kb-de"]').click();
    await page.locator('[data-testid="kb-layer-ctrl"]').click();
    check((await page.locator('[data-testid="kb-key-KeyY"]').getAttribute("data-action")) === "Undo", "the keyboard view puts Undo on the key labelled Z of a German keyboard (Y position)");
    await page.locator('[data-testid="kb-en"]').click();
    check((await page.locator('[data-testid="kb-key-KeyZ"]').getAttribute("data-action")) === "Undo", "...and on Z of an English one");
    await page.locator('[data-testid="kb-layer-none"]').click();
    check((await page.locator('[data-testid="kb-key-Comma"]').getAttribute("data-action")) === "Brush −", "the brush size is on the comma key");
    await page.locator('[data-testid="help-tab-list"]').click();
    const first = await page.locator('[data-testid="shortcut-help"] h3').first().innerText();
    check(/Viewer/.test(first), `? lists the keys of the viewer first (${first})`);
    await page.keyboard.press("Escape");
    await page.goto(base + "/");
    await page.waitForSelector(".search");
    await page.keyboard.press("/");
    check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search"), "/ goes to the search field");
    await page.keyboard.type("zz");
    await page.keyboard.press("Escape");
    check((await page.locator(".search").inputValue()) === "", "Esc inside the search field clears it");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+f");
    check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search"), "Ctrl + F goes to the search field as well (not the browser's)");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("p");
    await page.waitForSelector('[data-testid="preferences"]');
    check(true, "G then P opens the preferences");
    await page.goto(viewerUrl);
    await page.waitForSelector(".openseadragon-canvas");
    await page.waitForTimeout(1500);
  }

  // screenshot of the view, screening mode, no text selection
  {
    check((await page.evaluate(() => getComputedStyle(document.querySelector(".viewer-shell")).userSelect)) === "none", "the viewer does not let the browser select text");
    const [shot] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="screenshot"]').click()]);
    const file = await shot.path();
    const png = fs.readFileSync(file);
    check(png.length > 1000 && png.subarray(1, 4).toString() === "PNG" && /_screenshot\.png$/.test(shot.suggestedFilename()), `the camera button downloads the view as a PNG (${shot.suggestedFilename()}, ${png.length} bytes)`);

    await page.locator('[data-testid="screening-toggle"]').click();
    await page.waitForSelector('[data-testid="screening-panel"]');
    await page.waitForSelector('[data-testid="screening-start"], [data-testid="screening-map"]');
    if (await page.locator('[data-testid="screening-map"]').count()) {
      // left from an earlier run: its settings are shown
      await page.locator('[data-testid="screening-panel"] .btn', { hasText: "Settings" }).click();
      await page.waitForSelector('[data-testid="screening-start"]');
    } else check((await page.locator('[data-testid="screening-overlap"]').inputValue()) === "20", "the screening overlap is 20 % unless changed");
    const dims = await page.evaluate(() => { const i = window.__viewer.world.getItemAt(0).getContentSize(); return [i.x, i.y]; });
    await page.locator('[data-testid="screening-w"]').fill(String(Math.max(16, Math.round(dims[0] / 2))));
    await page.locator('[data-testid="screening-h"]').fill(String(Math.max(16, Math.round(dims[1] / 2))));
    await page.locator('[data-testid="screening-overlap"]').fill("50");
    const count = Number(/^(\d[\d,]*) windows/.exec(await page.locator('[data-testid="screening-count"]').innerText())?.[1].replace(/,/g, ""));
    check(count >= 4 && count <= 25, `the window count follows size and overlap (${count})`);
    await page.locator('[data-testid="screening-start"]').click();
    await page.waitForSelector('[data-testid="screening-map"]', { timeout: 8000 }).catch(async (e) => { throw new Error("screening did not start: " + (await page.locator('[data-testid="screening-panel"]').innerText())); });
    const prog0 = await page.locator('[data-testid="screening-progress"]').innerText();
    const centre = () => page.evaluate(() => { const c = window.__viewer.viewport.getCenter(); return [c.x, c.y]; });
    await page.waitForTimeout(900);
    const c0 = await centre();
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("d");
    await page.waitForTimeout(900);
    const c1 = await centre();
    check(c1[0] > c0[0] + 1e-4, "D steps to the window on the right");
    const prog1 = await page.locator('[data-testid="screening-progress"]').innerText();
    check(prog1 !== prog0, `...and counts the window that was left as screened (${prog0} -> ${prog1})`);
    await page.keyboard.press("j");
    await page.waitForTimeout(900);
    const c2 = await centre();
    check(c2[0] < c1[0] - 1e-4 && (await page.locator('[data-testid="screening-progress"]').innerText()) === prog1, "J steps back without counting");
    await page.keyboard.press("s");
    await page.waitForTimeout(300);
    check((await page.locator('[data-testid="screening-panel"]').count()) === 1, "the letters step through the slide while the panel is open");
    await page.locator('[data-testid="screening-toggle"]').click();
    check((await page.locator('[data-testid="screening-panel"]').count()) === 0, "the panel closes");
    await page.waitForTimeout(800); // closing stores the progress
    const stored = await page.evaluate(async () => { const r = await (await fetch(location.pathname.replace("/images/", "/api/v2/images/") + "/screening")).json(); return r ? [{ cur: r.current_index, screened: Object.values(r.screening_tiles).filter((t) => t.Screened).length }] : []; });
    check(stored.length === 1 && stored[0].screened >= 1, `the progress is stored with the account (${JSON.stringify(stored)})`);
  }

  // image adjustments: a movable window behind an icon at the right of the top bar
  const tileFilter = () => page.evaluate(() => window.__viewer.drawer.canvas.style.filter);
  const overlayFilters = () => page.evaluate(() => [...document.querySelectorAll(".openseadragon-canvas canvas")].filter((c) => c !== window.__viewer.drawer.canvas).map((c) => c.style.filter).join(""));
  check((await page.locator(".float-panel").count()) === 0, "the adjustments window is hidden at first");
  await page.locator(".adjust-btn").click();
  await page.waitForSelector(".float-panel");
  check((await page.locator(".float-panel input[type=range]").count()) === 5, "it offers brightness, contrast, gamma, saturation and hue");
  const bar = await page.locator(".viewer-bar").boundingBox();
  const btn = await page.locator(".adjust-btn").boundingBox();
  check(btn.x > bar.x + bar.width / 2, "the icon sits in the right half of the top bar");
  await page.locator(".adjust-row", { hasText: "Brightness" }).locator("input").fill("150");
  await page.locator(".adjust-row", { hasText: "Contrast" }).locator("input").fill("120");
  check((await tileFilter()) === "brightness(1.5) contrast(1.2)", `the drawn tiles get the filter (${await tileFilter()})`);
  check((await overlayFilters()) === "", "...the annotation layer on top does not");
  check((await page.locator(".adjust-dot").count()) === 1, "the icon shows that something is changed");
  await page.locator(".adjust-row", { hasText: "Gamma" }).locator("input").fill("1.5");
  check(/^url\(["']?#exact-gamma/.test(await tileFilter()) && (await page.locator("filter#exact-gamma feFuncG").getAttribute("exponent")).startsWith("0.66"), "gamma goes through the SVG filter");
  await page.locator(".float-panel .check", { hasText: "Invert" }).locator("input").check();
  check((await tileFilter()).endsWith("invert(1)"), "invert is applied");
  const before = await page.locator(".float-panel").boundingBox();
  const head = await page.locator(".float-head").boundingBox();
  await page.mouse.move(head.x + 90, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x - 150, head.y + head.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const after = await page.locator(".float-panel").boundingBox();
  check(Math.abs(after.x - (before.x - 240)) < 3 && Math.abs(after.y - (before.y + 40)) < 3, `the window moves by its title (${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)})`);
  check((await tileFilter()).length > 0, "...and the adjustments stay while it moves");
  await page.reload();
  await page.waitForSelector(".openseadragon-canvas canvas", { state: "attached" });
  await waitPainted("the image paints again after a reload");
  check((await tileFilter()).includes("brightness(1.5)"), "the adjustments are remembered");
  check((await page.locator(".float-panel").count()) === 0, "...the window starts closed");
  await page.locator(".adjust-btn").click();
  await page.waitForSelector(".float-panel");
  const back = await page.locator(".float-panel").boundingBox();
  check(Math.abs(back.x - after.x) < 3 && Math.abs(back.y - after.y) < 3, "...and where it was put");
  await page.locator(".float-panel .btn", { hasText: "Reset" }).click();
  check((await tileFilter()) === "" && (await page.locator(".adjust-dot").count()) === 0, "Reset takes everything back");
  await page.locator(".float-panel input[type=range]").first().focus();
  await page.keyboard.press("Escape");
  check((await page.locator(".float-panel").count()) === 0, "Escape closes the window");
  await page.evaluate(() => localStorage.removeItem("exact.adjust.pos"));

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

  // stepping through the volume never shows an empty or half-loaded slice: some plane is always fully visible
  await page.evaluate(() => {
    const w = window.__viewer.world;
    window.__minVisible = 1;
    const tick = () => {
      const items = [...Array(w.getItemCount()).keys()].map((i) => w.getItemAt(i));
      const el = window.__viewer.canvas;
      const best = Math.max(0, ...items.filter((it) => it.getFullyLoaded() || window.__coverage(it, el.clientWidth, el.clientHeight) >= 0.97).map((it) => it.getOpacity()));
      window.__minVisible = Math.min(window.__minVisible, best);
      window.__poll = requestAnimationFrame(tick);
    };
    tick();
  });
  const slow = async (route) => { await new Promise((r) => setTimeout(r, 250)); await route.continue().catch(() => {}); };
  await page.route(/\/tile/, slow); // tiles arrive late, as over a slow connection
  const cur = Number((await page.locator(".zslider input").inputValue()) || 40);
  for (const d of [1, 2, 3, 4, 5, 6]) {
    await page.locator(".zslider input").fill(String(cur + d));
    await page.waitForTimeout(120);
  }
  check((await page.locator('[data-testid="plane-busy"]').count()) === 1, "a progress indicator shows while the next slice loads");
  await page.waitForTimeout(1500);
  const minVisible = await page.evaluate(() => { cancelAnimationFrame(window.__poll); return window.__minVisible; });
  await page.unroute(/\/tile/, slow);
  check(minVisible > 0.99, `volume: while stepping, a slice covering the view is always shown (min opacity ${minVisible})`);

  // three planes of a volume, linked by a crosshair
  await page.evaluate(() => localStorage.setItem("exact.mpr", "1"));
  await page.goto(`${base}/images/80`);
  await page.waitForSelector('[data-testid="mpr"]');
  check(new URL(page.url()).pathname === "/images/80/planes", "a volume opens in the three-plane view");
  for (const p of ["axial", "coronal", "sagittal"]) await page.waitForSelector(`[data-testid="mpr-${p}"] canvas`);
  await waitFor(() => page.evaluate(() => [0, 1, 2].every((i) => window[`__mpr_${i}`]?.world.getItemCount() > 0 && window[`__mpr_${i}`].world.getItemAt(0).getFullyLoaded())), "all three planes are drawn");
  const voxelText = async () => (await page.locator('[data-testid="mpr-voxel"]').innerText()).match(/x (\d+)\/(\d+) · y (\d+)\/(\d+) · z (\d+)\/(\d+)/).slice(1).map(Number);
  const [x0, nx, y0, ny, z0, nz] = await voxelText();
  check(x0 === Math.floor(nx / 2) + 1 && y0 === Math.floor(ny / 2) + 1 && z0 === Math.floor(nz / 2) + 1, `the crosshair starts in the middle of the volume (${x0}, ${y0}, ${z0} of ${nx} x ${ny} x ${nz})`);
  const axial = await page.locator('[data-testid="mpr-axial"]').boundingBox();
  await page.mouse.click(axial.x + axial.width * 0.3, axial.y + axial.height * 0.4);
  await page.waitForTimeout(400);
  const [x1, , y1, , z1] = await voxelText();
  check(z1 === z0 && (x1 !== x0 || y1 !== y0), `a click in the axial plane moves the crosshair in it and keeps its slice (${x0},${y0},${z0} -> ${x1},${y1},${z1})`);
  check((await page.locator('[data-testid="mpr-coronal"] .mpr-label').innerText()).includes(`${y1} /`) && (await page.locator('[data-testid="mpr-sagittal"] .mpr-label').innerText()).includes(`${x1} /`), "...and the coronal and sagittal planes show the slices through it");
  await page.waitForTimeout(600);
  await shot("6-three-planes");
  const sag = await page.locator('[data-testid="mpr-sagittal"]').boundingBox();
  await page.mouse.move(sag.x + sag.width / 2, sag.y + sag.height / 2);
  // by default the wheel zooms, as everywhere in EXACT; Shift + wheel steps through the slices
  const zoomOf = () => page.evaluate(() => window.__mpr_2.viewport.getZoom());
  const zoom0 = await zoomOf();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(700);
  const [xz, , , , zz] = await voxelText();
  check((await zoomOf()) > zoom0 && xz === x1 && zz === z1, "the mouse wheel zooms the plane under it and keeps the slices");
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(400);
  const [xs, , , , zs] = await voxelText();
  check(xs === x1 + 1 && zs === z1, `Shift + wheel steps through the slices (x ${x1} -> ${xs})`);
  await page.click('[data-testid="wheel-mode"]');
  check((await page.locator('[data-testid="wheel-mode"]').innerText()).includes("slices"), "the top bar offers the wheel for the slices");
  await page.mouse.move(sag.x + sag.width / 2, sag.y + sag.height / 2);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const [x2, , , , z2] = await voxelText();
  check(x2 === x1 && z2 === z1, `in "slices" mode the mouse wheel steps through the slices of the plane under it (x ${xs} -> ${x2})`);
  const shot3 = new URL(page.url());
  check(["vx", "vy", "vz"].every((k) => shot3.searchParams.has(k)), "the address bar carries the crosshair");
  await page.goto(page.url());
  await page.waitForSelector('[data-testid="mpr-voxel"]');
  await waitFor(async () => { try { return (await voxelText()).join() === [x2, nx, y1, ny, z1, nz].join(); } catch { return false; } }, "a link restores the crosshair position");
  await page.locator(".btn", { hasText: "Single plane" }).click();
  await page.waitForSelector(".zslider");
  check(new URL(page.url()).pathname === "/images/80", "the button leads to one plane at a time, which then stays the choice");
  await page.goto(`${base}/images/80`);
  await page.waitForSelector(".zslider");
  check(new URL(page.url()).pathname === "/images/80", "...also when the volume is opened again");
  await page.locator(".btn", { hasText: "Three planes" }).click();
  await page.waitForSelector('[data-testid="mpr"]');
  await page.evaluate(() => localStorage.setItem("exact.mpr", "0"));

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

  // annotations belong to the frame they were drawn on (multi frame types: to all of them)
  const api2 = (method, url, body) => page.evaluate(async ([method, url, body]) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch(url, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return r.status === 204 ? null : await r.json();
  }, [method, url, body]);
  const zimg = await api2("GET", "/api/v2/images/57?fields=id,image_set");
  const zset = await api2("GET", `/api/v2/image-sets/${zimg.image_set}?fields=id,product_set`);
  const ztypes = (await api2("GET", "/api/v2/annotation-types?fields=id,name,vector_type,product,multi_frame&limit=1000")).items.filter((t) => zset.product_set.includes(t.product) && t.vector_type === 1);
  const boxType = ztypes.find((t) => !t.multi_frame);
  const made = [];
  for (const [frame, x] of [[2, 100], [5, 300], [null, 500]]) made.push(await api2("POST", "/api/v2/annotations", { image: 57, annotation_type: boxType.id, vector: { x1: x, y1: 100, x2: x + 80, y2: 180, ...(frame ? { frame } : {}) }, unique_identifier: crypto.randomUUID?.() ?? `${Date.now()}-${x}` }));
  await page.goto(`${base}/images/57?frame=1`);
  await page.waitForSelector(".zslider input");
  const shown = () => page.evaluate(() => window.__editor.host.shapes().map((s) => s.id));
  await page.waitForTimeout(2500);
  await waitFor(async () => (await shown()).includes(made[0].id), "an annotation is shown on its frame");
  check(!(await shown()).includes(made[1].id) && (await shown()).includes(made[2].id), "...not on other frames, but one without a frame is shown everywhere");
  await page.locator(".zslider input").fill("4");
  await waitFor(async () => (await shown()).includes(made[1].id), "stepping to frame 5 shows the annotation of frame 5");
  check(!(await shown()).includes(made[0].id), "...and hides the one of frame 2");
  // an annotation drawn here gets the frame
  await page.locator(".type-dd .trigger").click();
  await page.locator(".dd-item", { hasText: boxType.name }).first().click();
  const [d1, d2] = await page.evaluate(() => { const v = window.__viewer; const it = v.world.getItemAt(0); const r = v.canvas.getBoundingClientRect(); const f = (x, y) => { const p = it.imageToViewerElementCoordinates(new window.__osd.Point(x, y)); return [r.left + p.x, r.top + p.y]; }; return [f(700, 300), f(780, 380)]; });
  await page.mouse.move(d1[0], d1[1]);
  await page.mouse.down();
  await page.mouse.move(d2[0], d2[1], { steps: 6 });
  await page.mouse.up();
  let drawn = null;
  await waitFor(async () => { drawn = (await api2("GET", "/api/v2/annotations?image=57&deleted=false&fields=id,vector&limit=1000")).items.find((a) => a.vector && Math.abs(a.vector.x1 - 700) < 15); return !!drawn; }, "an annotation was drawn");
  check(drawn.vector.frame === 5, `an annotation drawn on frame 5 carries frame ${drawn.vector.frame}`);
  // editing keeps the frame
  await page.keyboard.press("c");
  const c0 = await page.evaluate(() => { const v = window.__viewer; const it = v.world.getItemAt(0); const r = v.canvas.getBoundingClientRect(); const p = it.imageToViewerElementCoordinates(new window.__osd.Point(740, 340)); return [r.left + p.x, r.top + p.y]; });
  await page.mouse.click(c0[0], c0[1]);
  await page.mouse.move(c0[0], c0[1]);
  await page.mouse.down();
  await page.mouse.move(c0[0] + 30, c0[1] + 20, { steps: 5 });
  await page.mouse.up();
  await waitFor(async () => { const a = (await api2("GET", `/api/v2/annotations/${drawn.id}?fields=id,vector`)); return a.vector.x1 > drawn.vector.x1 + 1; }, "the annotation was moved");
  check((await api2("GET", `/api/v2/annotations/${drawn.id}?fields=id,vector`)).vector.frame === 5, "moving an annotation keeps its frame");
  for (const a of [...made, drawn]) await api2("DELETE", `/api/v2/annotations/${a.id}?hard=true`);
  await page.goto(`${base}/images/57`);
  await page.waitForSelector(".zslider input");
  await page.locator(".zslider input").fill("1");
  await page.waitForTimeout(1200);

  // the address bar follows the view, and the link opens the same view
  await page.waitForTimeout(600);
  const shared = new URL(page.url());
  check(["xmin", "ymin", "xmax", "ymax", "frame"].every((k) => shared.searchParams.has(k)) && !shared.searchParams.has("zoom"), `the address bar carries the view (${shared.search})`);
  const sharedView = await page.evaluate(() => { const v = window.__viewer.viewport; const it = window.__viewer.world.getItemAt(0); return { z: it.viewportToImageZoom(v.getZoom(true)), c: it.viewportToImageCoordinates(v.getCenter(true)) }; });
  await page.goto(page.url());
  await page.waitForSelector(".viewer-host, .osd, canvas");
  await waitPainted("the shared link renders");
  await page.waitForTimeout(800);
  const reopened = await page.evaluate(() => { const v = window.__viewer.viewport; const it = window.__viewer.world.getItemAt(0); return { z: it.viewportToImageZoom(v.getZoom(true)), c: it.viewportToImageCoordinates(v.getCenter(true)) }; });
  check(Math.abs(reopened.z / sharedView.z - 1) < 0.01 && Math.abs(reopened.c.x - sharedView.c.x) < 3 && Math.abs(reopened.c.y - sharedView.c.y) < 3, `the link restores zoom and position (${sharedView.z.toFixed(3)} -> ${reopened.z.toFixed(3)})`);

  // a link of the old EXACT opens the same region
  await page.goto(`${base}/annotations/57/?frame=3&xmin=100&ymin=80&xmax=420&ymax=300`);
  await waitPainted("an old EXACT link renders");
  await page.waitForTimeout(800);
  check(new URL(page.url()).pathname === "/images/57", `an old link is redirected to the viewer (${new URL(page.url()).pathname})`);
  const oldView = await page.evaluate(() => { const v = window.__viewer.viewport; const it = window.__viewer.world.getItemAt(0); const r = it.viewportToImageRectangle(v.getBounds(true)); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  check(oldView.x < 105 && oldView.x + oldView.w > 415 && oldView.y < 85 && oldView.y + oldView.h > 295 && oldView.w < 800, `the old link's region is shown (${Math.round(oldView.x)},${Math.round(oldView.y)} ${Math.round(oldView.w)}x${Math.round(oldView.h)})`);
  check((await page.locator(".zslider-current").innerText()).includes("4 /"), "...at the frame of the link");

  // track pad: a two-finger swipe moves, a pinch (Ctrl + wheel) zooms about the fingers, a mouse wheel step still zooms
  const wheel = (init) => page.evaluate((i) => { const c = window.__viewer.canvas; const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...i })); }, init);
  const viewNow = () => page.evaluate(() => { const v = window.__viewer.viewport; return { z: v.getZoom(true), c: v.getCenter(true) }; });
  const g0 = await viewNow();
  await wheel({ deltaX: 40, deltaY: 12.5, deltaMode: 0 });
  const g1 = await viewNow();
  check(Math.abs(g1.z - g0.z) < 1e-9 && g1.c.x > g0.c.x && g1.c.y > g0.c.y, "a two-finger swipe moves the image without zooming");
  await wheel({ deltaY: -8, ctrlKey: true, deltaMode: 0 });
  const g2 = await viewNow();
  check(g2.z > g1.z * 1.05, "a pinch outwards zooms in");
  await page.waitForTimeout(800);
  await wheel({ deltaY: 100, deltaMode: 0 });
  await page.waitForTimeout(600);
  const g3 = await viewNow();
  check(g3.z < g2.z, "a mouse wheel step still zooms");
  await page.evaluate(() => { const v = window.__viewer.viewport; v.zoomTo(v.getHomeZoom() * 3, undefined, true); v.panTo(new window.__osd.Point(0.3, 0.2 * v.getHomeBounds().height), true); });

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
  check((await page.locator('[data-testid="opening"]').count()) === 0, "...and no spinner that says it is opening");
  errors.length = known; // the 404 is expected

  // an image that is slow to open (a big slide on slow storage): a spinner over the empty canvas until the first tiles are drawn
  await page.route("**/api/v2/images/82/1/*/tile", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto(`${base}/images/82`);
  await page.waitForSelector('[data-testid="opening"]', { timeout: 5000 });
  check((await page.locator('[data-testid="opening"]').innerText()).includes("Opening"), "a slow image shows a spinner while it opens");
  await page.waitForSelector('[data-testid="opening"]', { state: "detached", timeout: 30000 });
  await waitFor(async () => (await sample()) > 20, "...which goes away when the image is on the canvas");
  await page.unroute("**/api/v2/images/82/1/*/tile");
  await openImage(82);
  await waitFor(async () => (await page.locator('[data-testid="opening"]').count()) === 0, "an image that opens quickly leaves no spinner behind");

  // a phone: no page is wider than the screen, the top bar folds into a menu, teams are a drop-down, jobs are cards
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, what] of [["/", "the image sets"], ["/sets/1", "an image set"], ["/jobs", "the jobs list"], ["/admin", "the administration"]]) {
    await page.goto(base + path);
    await page.waitForSelector(".topbar");
    await page.waitForTimeout(700);
    const [wide, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    check(wide <= inner, `phone: no horizontal scroll on ${what} (${wide} of ${inner} px)`);
  }
  await page.goto(base + "/");
  await page.waitForSelector(".team-select");
  check((await page.locator(".team-select").isVisible()) && !(await page.locator(".teams-aside").isVisible()), "phone: the teams are a drop-down, not a list");
  check((await page.locator(".topnav").isVisible()) === false, "phone: the sign-out and administration entries are folded away...");
  await page.locator(".nav-toggle").click();
  await page.locator('[data-testid="user-menu"]').click();
  check(await page.locator('[data-testid="menu-sign-out"]').isVisible(), "...and shown by the menu button (in the user menu)");
  await page.setViewportSize({ width: 1400, height: 850 });
  check((await page.locator(".nav-toggle").isVisible()) === false && (await page.locator('[data-testid="user-menu"]').isVisible()), "a wide screen shows them in the top bar as before");

  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  await browser.close();
}
