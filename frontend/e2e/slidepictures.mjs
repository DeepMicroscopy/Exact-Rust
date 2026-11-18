// The label and macro photo stored in a slide file (SVS, NDPI, MRXS, CZI, ...) are shown from the viewer's top bar.
// Needs a slide that has them: IMAGE=<id of such an image> node e2e/slidepictures.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  console.log("skipped: IMAGE=<id of a slide with a label> is not set");
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(base);
await page.waitForSelector("form.login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.click("button.primary");
await page.waitForSelector(".cards .card");
await page.goto(`${base}/images/${IMAGE}`);
await page.waitForSelector('[data-testid="slide-pictures"]');
check(true, "the viewer offers the slide's label");
await page.click('[data-testid="slide-pictures"]');
await page.waitForSelector('[data-testid="slide-picture"] img');
await page.waitForFunction(() => document.querySelector('[data-testid="slide-picture"] img')?.naturalWidth > 0);
check(true, "the first picture loads");
const tabs = await page.locator('[role="tab"]').allInnerTexts();
check(tabs.length >= 2, `there is a tab for each picture (${tabs.join(", ")})`);
await page.locator('[role="tab"]').nth(1).click();
await page.waitForFunction(() => document.querySelector('[data-testid="slide-picture"] img')?.naturalWidth > 0);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/slide-pictures.png` });
check(true, "another picture can be chosen");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="slide-picture"]', { state: "detached" });
check(true, "Escape closes it");
await browser.close();
