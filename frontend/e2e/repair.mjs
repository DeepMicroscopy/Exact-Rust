// Browser test of the one-time repair of a damaged image. Run against a server whose IMAGE_PATH is a *scratch copy*
// (never the real images): node e2e/repair.mjs <baseUrl> <imageId> <imageDir>
import { chromium } from "playwright-core";
import fs from "node:fs";

const [base = "http://127.0.0.1:8003", id = "19", dir = "/tmp/exact-repair/exact_1_1"] = process.argv.slice(2);
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const check = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("ok  -", m); };
const files = () => fs.readdirSync(dir).filter((f) => !f.endsWith("_thumbnail.png"));

try {
  await page.goto(base);
  await page.fill('input[autocomplete="username"]', "aubreville");
  await page.fill('input[type="password"]', process.env.EXACT_PW ?? "rust-test-pw");
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  await page.goto(`${base}/images/${id}`);
  await page.waitForSelector(".repair");
  check((await page.locator(".repair").innerText()).includes("damaged"), "banner offers the repair for a damaged file");
  if (shots) await page.screenshot({ path: `${shots}/repair-1-offer.png` });
  const before = files();
  await page.click('button:has-text("Repair file")');
  // the job is short for small files: either progress is visible or the page already reloaded
  await page.waitForSelector(".repair.ok", { timeout: 60000 });
  check((await page.locator(".repair.ok").innerText()).includes("File repaired"), "banner confirms the repair after the reload");
  if (shots) await page.screenshot({ path: `${shots}/repair-2-done.png` });
  const after = files();
  check(after.length === before.length + 1 && after.some((f) => f.includes(".orig.")), "the original is kept as a backup file");
  const meta = await page.evaluate(async (i) => (await fetch(`/api/v2/images/${i}/metadata`)).json(), id);
  check(meta.level_count > 1 && !(meta.issues ?? []).length, `the repaired image has ${meta.level_count} levels and no issues`);
  await page.waitForTimeout(1500);

  await page.click('button:has-text("Undo")');
  await page.waitForSelector(".repair:has-text('damaged')", { timeout: 30000 });
  check(files().length === before.length + 1 && files().some((f) => f.includes(".repaired.")), "undo puts the original back (repaired file kept aside)");
} finally {
  await browser.close();
}
