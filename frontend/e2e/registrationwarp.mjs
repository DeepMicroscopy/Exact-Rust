// A registration that bends (a warp grid in the registration's file) is drawn through that grid over the current image.
// Needs a pair: FROM=<id of the registered image> TO=<id of the image to look at> [OUT=file.png] node e2e/registrationwarp.mjs [baseUrl]
// Prints whether the warped overlay canvas was used and saves a screenshot of the view with the overlay at full opacity.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { FROM, TO, OUT, VIEW } = process.env; // VIEW=x,y,width: the part of the viewport (image width = 1) to look at
if (!FROM || !TO) {
  console.log("skipped: FROM=<registered image> TO=<current image> is not set");
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(base);
await page.waitForSelector("form.login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.click("button.primary");
await page.waitForSelector(".cards .card");
await page.goto(`${base}/images/${TO}`);
await page.waitForSelector("#overlay-pick");
await page.selectOption("#overlay-pick", FROM);
await page.locator('input[aria-label="Overlay opacity"]').fill(process.env.OPACITY ?? "1");
const warped = await page
  .waitForSelector('[data-testid="warped-overlay"]', { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
await page.waitForSelector('[data-testid="overlay-loading"]', { state: "detached", timeout: 60000 }).catch(() => {});
if (VIEW) {
  const [x, y, w] = VIEW.split(",").map(Number);
  await page.evaluate(([x, y, w]) => window.__viewer.viewport.fitBounds(new window.__osd.Rect(x, y, w, w * 0.5), true), [x, y, w]);
  await page.waitForTimeout(500);
}
await page.waitForTimeout(2500);
console.log(warped ? "ok  - the overlay is drawn through the warp grid" : "ok  - the overlay is placed by the matrix (no warp)");
if (OUT) await page.screenshot({ path: OUT });
await browser.close();
