// Captures the screenshots of README.md and the documentation (docs/assets/screenshots) from a running server on the
// scratch database (scripts/run-e2e.sh serve). Usage: node e2e/screenshots.mjs [outDir]   (env: CHROME, EXACT_URL)
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.EXACT_URL ?? "http://127.0.0.1:8002";
const out = process.argv[2] ?? "../docs/assets/screenshots";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const settle = async (ms = 1500) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
};
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("shot", name);
};
const viewer = async (id, extra = 2500) => {
  await page.goto(`${base}/images/${id}`);
  await page.waitForSelector(".openseadragon-canvas canvas", { state: "attached" });
  await settle(extra);
};

await page.goto(base);
await settle(500);
await shot("login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.keyboard.press("Enter");
await page.waitForURL((u) => !/login/.test(u.pathname), { timeout: 10000 }).catch(() => {});
await settle();
await shot("home");
await page.goto(`${base}/sets/1`);
await settle();
await shot("imageset");
await viewer(34);
await shot("viewer");
await page.goto(`${base}/images/90/planes`);
await settle(4000);
await shot("planes");
await browser.close();
