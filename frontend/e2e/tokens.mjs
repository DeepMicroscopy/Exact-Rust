// End-to-end test of the access tokens: made in Preferences (shown once), used as a Bearer token, revoked; and the administrator's view of
// another account's tokens. Usage: node e2e/tokens.mjs [baseUrl]
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
async function login(context, user) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/401|403|404|409/.test(m.text()) && errors.push(m.text()));
  await page.goto(base);
  await page.waitForSelector("form.login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', "rust-test-pw");
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  return page;
}
const withToken = (page, token) => page.evaluate(async (t) => (await fetch("/api/v2/auth/me", { credentials: "omit", headers: { Authorization: `Bearer ${t}` } })).status, token);

try {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await login(ctx, "rt_member");
  await page.goto(`${base}/preferences`);
  await page.waitForSelector('[data-testid="token-list"]');
  const name = `e2e-${Date.now()}`;
  await page.fill('[data-testid="token-name"]', name);
  await page.selectOption('[data-testid="token-expiry"]', "30");
  await page.click('[data-testid="token-create"]');
  const secret = await page.locator('[data-testid="secret"]').inputValue();
  check(/^pat_[A-Za-z0-9]{12}\.[A-Za-z0-9]{43}$/.test(secret), "the new token is shown once in a dialog: " + secret.slice(0, 8) + "…");
  if (shots) await page.screenshot({ path: `${shots}/token-secret.png` });
  await page.click(".modal-actions .btn.primary");
  const row = page.locator('[data-testid="token-row"]', { hasText: name });
  await row.waitFor();
  check(!(await row.innerText()).includes(secret.split(".")[1]), "the list never shows the secret");
  check(/expires/.test(await row.innerText()) && /all teams/.test(await row.innerText()), "the row says when it expires and which teams");
  if (shots) await page.screenshot({ path: `${shots}/token-list.png`, fullPage: true });
  check((await withToken(page, secret)) === 200, "the token authenticates the API without a cookie");
  // revoke (asks first), then it is refused and the row says so
  page.once("dialog", (d) => void d.accept());
  await row.locator('[data-testid="token-revoke"]').click();
  await page.locator('[data-testid="token-row"][data-active="false"]', { hasText: name }).waitFor();
  check((await withToken(page, secret)) !== 200, "a revoked token is refused");
  check(/revoked/.test(await page.locator('[data-testid="token-row"]', { hasText: name }).innerText()), "the row says revoked");
  await page.locator('[data-testid="token-row"]', { hasText: name }).locator('[data-testid="token-revoke"]').click(); // removes
  await page.waitForFunction((n) => ![...document.querySelectorAll('[data-testid="token-row"]')].some((r) => r.textContent.includes(n)), name);
  check(true, "removing an inactive token takes it off the list");

  // a token limited to jobs: the interface says so and the server holds it to it
  const ln = `${name}-jobs`;
  await page.fill('[data-testid="token-name"]', ln);
  await page.selectOption('[data-testid="token-access"]', "some");
  check((await page.locator('[data-testid="token-create"]').isDisabled()) === false, "a limited token starts with queue jobs ticked");
  await page.uncheck('[data-testid="token-ability-jobs"]');
  check(await page.locator('[data-testid="token-create"]').isDisabled(), "a token that may do nothing but look must be made as read only: no abilities, no Create");
  await page.check('[data-testid="token-ability-jobs"]');
  await page.click('[data-testid="token-create"]');
  const jsecret = await page.locator('[data-testid="secret"]').inputValue();
  await page.click(".modal-actions .btn.primary");
  const jrow = page.locator('[data-testid="token-row"]', { hasText: ln });
  await jrow.waitFor();
  check(/looks, queue jobs/.test(await jrow.innerText()), "the list says what the token may do: " + (await jrow.innerText()).split("·")[1]);
  const post = (t, path, body) => page.evaluate(async ([t, path, body]) => (await fetch(path, { method: "POST", credentials: "omit", headers: { Authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status, [t, path, body]);
  check((await post(jsecret, "/api/v2/annotations", { image: 2, annotation_type: 1, vector: { x1: 1, y1: 1, x2: 5, y2: 5 } })) === 403, "the jobs token cannot annotate");
  check((await post(jsecret, "/api/v2/me/tokens", { name: "child" })) === 403, "nor make tokens");
  if (shots) await page.screenshot({ path: `${shots}/token-scoped.png`, fullPage: true });
  page.once("dialog", (d) => void d.accept());
  await jrow.locator('[data-testid="token-revoke"]').click();
  await page.locator('[data-testid="token-row"][data-active="false"]', { hasText: ln }).waitFor();
  await page.locator('[data-testid="token-row"]', { hasText: ln }).locator('[data-testid="token-revoke"]').click();

  // administrator: sees and revokes the tokens of another account
  const mk = await page.evaluate(async (n) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    return (await (await fetch("/api/v2/me/tokens", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ name: n + "-admin" }) })).json());
  }, name);
  const adm = await login(await browser.newContext({ viewport: { width: 1300, height: 900 } }), "aubreville");
  await adm.goto(`${base}/admin`);
  await adm.locator('[role="tab"]', { hasText: "Users" }).click();
  await adm.locator("tr", { hasText: "rt_member" }).first().locator('[data-testid="user-tokens"]').click();
  const arow = adm.locator('[data-testid="user-token-list"] [data-testid="token-row"]', { hasText: name + "-admin" });
  await arow.waitFor();
  if (shots) await adm.screenshot({ path: `${shots}/token-admin.png` });
  check(!(await arow.innerText()).includes(mk.token.split(".")[1]), "the administrator sees the token but not its secret");
  adm.once("dialog", (d) => void d.accept());
  await arow.locator('[data-testid="token-revoke"]').click();
  await adm.locator('[data-testid="user-token-list"] [data-testid="token-row"][data-active="false"]', { hasText: name + "-admin" }).waitFor();
  check((await withToken(page, mk.token)) !== 200, "a token revoked by the administrator stops working");
  await page.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    for (let i = 0; i < 2; i++) await fetch(`/api/v2/me/tokens/${id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  }, mk.id);
  // not offered to people who are not administrators
  await page.goto(`${base}/admin`);
  check((await page.locator('[data-testid="user-tokens"]').count()) === 0, "no Tokens button for a member");
  check(!errors.length, "no page errors: " + errors.join(" / "));
  console.log("done");
} finally {
  await browser.close();
}
