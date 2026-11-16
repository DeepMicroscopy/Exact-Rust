// End-to-end test of the labels of the whole image (global annotation types): the rows under the annotation types in the side panel set and unset them, also with the
// keyboard, and on an image with frames they are labels of the frame shown. Needs a restored scratch database.
// Usage: node e2e/globals.mjs [baseUrl]   (env: CHROME, SHOTS=dir for screenshots)
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FRAMED = 6; // an image with 13 frames, in image set 1
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const waitFor = async (fn, msg, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 120));
  }
};

const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/401|409|404/.test(m.text()) && errors.push(m.text()));
await page.goto(base);
await page.waitForSelector("form.login");
await page.fill('input[autocomplete="username"]', "aubreville");
await page.fill('input[type="password"]', "rust-test-pw");
await page.click("button.primary");
await page.waitForSelector(".cards .card");

/** An API call as the logged-in administrator. */
const api = (method, path, body) =>
  page.evaluate(
    async ([method, path, body]) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      const r = await fetch(path, { method, headers: { "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, json: text ? JSON.parse(text) : null };
    },
    [method, path, body],
  );

const name = `e2e-label-${Date.now()}`;
const type = (await api("POST", "/api/v2/annotation-types", { name, vector_type: 7, product: 1, color_code: "#d9480f" })).json;
check(type?.id, "a global annotation type exists");
const labelsOf = async (image) => (await api("GET", `/api/v2/annotations?image=${image}&annotation_type=${type.id}&limit=100`)).json.items;
const chip = () => page.locator('.viewer-side [data-testid="label-chip"]', { hasText: name });
let set = null;
let framedSetAddedProduct = false;
try {
  // a single image: the label has no vector, as before
  set = (await api("POST", "/api/v2/image-sets", { name: `e2e-labels-${Date.now()}`, team: 1 })).json;
  await api("PUT", `/api/v2/image-sets/${set.id}/products/1`);
  const image = await page.evaluate(async (setId) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#b08fb0";
    g.fillRect(0, 0, 1200, 900);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const fd = new FormData();
    fd.append("file", blob, `e2e-labels-${Date.now()}.png`);
    return (await (await fetch(`/api/v2/image-sets/${setId}/images`, { method: "POST", headers: { "x-csrf-token": csrf }, body: fd })).json()).items[0].id;
  }, set.id);
  await page.goto(`${base}/images/${image}`);
  await page.waitForSelector('[data-testid="global-labels"]');
  check((await chip().count()) === 1, "the label is offered in the side panel");
  check((await chip().getAttribute("data-set")) === "0", "it is not set");
  await chip().click();
  await waitFor(async () => (await labelsOf(image)).some((a) => !a.deleted), "the label is stored");
  const stored = (await labelsOf(image)).find((a) => !a.deleted);
  check(stored.vector === null, "on a single image the label has no vector");
  check((await chip().getAttribute("data-set")) === "1", "the chip shows it set");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/globals-single.png` });
  await chip().click();
  await waitFor(async () => (await labelsOf(image)).every((a) => a.deleted), "a second click removes it");
  check((await chip().getAttribute("data-set")) === "0", "the chip shows it not set");
  // the keyboard does the same (Shift + the number of the label among the global types of the set)
  const globals = (await api("GET", "/api/v2/annotation-types?limit=500")).json.items
    .filter((t) => t.vector_type === 7 && t.product === 1)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  const n = globals.findIndex((t) => t.id === type.id) + 1;
  await page.locator(".osd").click({ position: { x: 300, y: 300 } });
  await page.keyboard.press(`Shift+Digit${n}`);
  await waitFor(async () => (await chip().getAttribute("data-set")) === "1", "Shift + digit sets the label, and the row follows");
  await page.keyboard.press(`Shift+Digit${n}`);
  await waitFor(async () => (await chip().getAttribute("data-set")) === "0", "and unsets it");

  // an image with frames: the label is one of the frame shown
  const s1 = (await api("GET", "/api/v2/image-sets/1")).json;
  if (!(s1.product_set ?? []).includes(1)) {
    await api("PUT", "/api/v2/image-sets/1/products/1");
    framedSetAddedProduct = true;
  }
  await page.goto(`${base}/images/${FRAMED}?frame=2`);
  await page.waitForSelector('[data-testid="global-labels"]');
  check(/Frame 3/.test(await page.locator(".gl-frame").innerText()), "the list says which frame it is for");
  await chip().click();
  await waitFor(async () => (await labelsOf(FRAMED)).some((a) => !a.deleted), "the label of frame 3 is stored");
  check(JSON.stringify((await labelsOf(FRAMED)).find((a) => !a.deleted).vector) === '{"frame":3}', "it names its frame, and nothing else");
  // moving through the frames (keys and slider, no reload): the list follows
  await page.locator(".osd").click({ position: { x: 300, y: 300 } });
  await page.keyboard.press("Shift+E");
  await waitFor(async () => /Frame 4/.test(await page.locator(".gl-frame").innerText()), "Shift + E moves to frame 4 and the list says so");
  check((await chip().getAttribute("data-set")) === "0", "frame 4 does not have the label of frame 3 (moved with the keyboard)");
  await page.keyboard.press("Shift+Q");
  await waitFor(async () => /Frame 3/.test(await page.locator(".gl-frame").innerText()) && (await chip().getAttribute("data-set")) === "1", "and back on frame 3 the label is set again");
  await page.goto(`${base}/images/${FRAMED}?frame=5`);
  await page.waitForSelector('[data-testid="global-labels"]');
  check((await chip().getAttribute("data-set")) === "0", "frame 6 does not have the label of frame 3");
  await chip().click();
  await waitFor(async () => (await labelsOf(FRAMED)).filter((a) => !a.deleted).length === 2, "frame 6 gets its own");
  await page.goto(`${base}/images/${FRAMED}?frame=2`);
  await page.waitForSelector('[data-testid="global-labels"]');
  check((await chip().getAttribute("data-set")) === "1", "back on frame 3 the label is still set");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/globals-framed.png` });
  await chip().click();
  await waitFor(async () => (await labelsOf(FRAMED)).filter((a) => !a.deleted).length === 1, "unsetting removes the label of this frame only");
  check(JSON.stringify((await labelsOf(FRAMED)).find((a) => !a.deleted).vector) === '{"frame":6}', "the label of frame 6 stays");
  check(errors.length === 0, "no page errors: " + errors.join(" | "));
} finally {
  // everything this test made goes again: the labels of the type (wherever they are), the image set, the product link, the type
  const left = (await api("GET", `/api/v2/annotations?annotation_type=${type.id}&limit=1000`)).json?.items ?? [];
  for (const a of left) await api("DELETE", `/api/v2/annotations/${a.id}?hard=true`);
  if (set) await api("DELETE", `/api/v2/image-sets/${set.id}`);
  if (framedSetAddedProduct) await api("DELETE", "/api/v2/image-sets/1/products/1");
  await api("DELETE", `/api/v2/annotation-types/${type.id}`);
  await browser.close();
}
console.log("done");
