// The unique identifier of an annotation, typed into the search of the start page, finds it: "Annotation in IMAGE (imageset, team)" with a preview.
// Needs an annotation: ANNOTATION=<unique identifier> node e2e/annotationsearch.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UID = process.env.ANNOTATION;
if (!UID) {
  console.log("skipped: ANNOTATION=<unique identifier> is not set");
  process.exit(0);
}
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(base);
await page.waitForSelector("form.login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.click("button.primary");
await page.waitForSelector(".cards .card");
await page.fill('input[aria-label="Search"]', UID.toUpperCase());
await page.waitForSelector('[data-testid="annotation-hits"] .card');
const text = await page.locator('[data-testid="annotation-hits"] .card').first().innerText();
check(/Annotation in .+/.test(text) && /imageset .+, team .+/.test(text), `the hit names image, imageset and team (${text.replace(/\n/g, " | ")})`);
await page.waitForFunction(() => document.querySelector('[data-testid="annotation-preview"]')?.naturalWidth > 0);
check(true, "the preview loads");
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/annotation-search.png` });
await page.fill('input[aria-label="Search"]', "00000000-0000-4000-8000-000000000000");
await page.waitForSelector('[data-testid="annotation-hits"]', { state: "detached" });
check(true, "an unknown identifier finds nothing");
await page.fill('input[aria-label="Search"]', UID);
await page.click('[data-testid="annotation-hits"] .card');
await page.waitForURL(/\/images\/\d+\?region=/);
check(true, "the hit opens the image at the annotation (" + page.url().replace(base, "") + ")");
await browser.close();
