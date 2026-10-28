// End-to-end test of the administration screens in the system Chrome: create a team, invite someone, accept the invitation in a
// fresh browser, team members (admin flag, removal), users (active, reset link, random password, delete), delete the team.
// Needs a fresh scratch database. Usage: node e2e/admin.mjs [baseUrl]   (env: CHROME, SHOTS=dir)
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome });
const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const waitFor = async (fn, msg, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 150));
  }
};
async function login(user, pw = "rust-test-pw") {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/401|403|409|404/.test(m.text()) && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pw);
  await page.click("button.primary");
  await page.waitForSelector(".sidebar");
  return page;
}
const teamName = `e2e-team-${Date.now()}`;
const newUser = `e2e_user_${String(Date.now()).slice(-6)}`;
const PW1 = "E2e-Passw0rd-Zq81!";
try {
  const root = await login("aubreville");
  await root.locator("a", { hasText: "Administration" }).click();
  await root.waitForSelector(".admin");
  // ---- team
  await root.locator(".sidebar .btn", { hasText: "New team" }).click();
  await root.fill('.modal input[aria-label="Team name"]', teamName);
  await root.locator(".modal .btn.primary").click();
  await waitFor(async () => (await root.locator(".team-panel h3", { hasText: teamName }).count()) === 1, "a team is created and shown");
  await waitFor(async () => (await root.locator('[data-testid="members"] tr', { hasText: "aubreville" }).count()) === 1, "the creator is a member");
  check(await root.locator('input[aria-label="aubreville is team admin"]').isChecked(), "...and its admin");
  // ---- invite
  await root.locator(".team-panel .btn", { hasText: "Invite someone" }).click();
  await root.fill('input[aria-label="Invitee email"]', "newcomer@example.org");
  await root.fill('input[aria-label="Invitation note"]', "e2e");
  await root.locator(".modal .btn.primary", { hasText: "Create link" }).click();
  await root.waitForSelector('[data-testid="secret"]');
  const link = await root.inputValue('[data-testid="secret"]');
  check(/\/invite\/inv_/.test(link), `an invitation link is shown (${link.slice(0, 50)}…)`);
  await root.locator(".modal .btn.primary", { hasText: "Done" }).click();
  await waitFor(async () => (await root.locator(".team-panel td", { hasText: "newcomer@example.org" }).count()) === 1, "the open invitation is listed");
  // ---- the invited person, in a browser without a session
  const anon = await (await browser.newContext()).newPage();
  anon.on("console", (m) => m.type() === "error" && !/401|403|404/.test(m.text()) && errors.push(m.text()));
  await anon.goto(link);
  await anon.waitForSelector('input[aria-label="Username"]');
  check((await anon.locator("form").innerText()).includes(teamName), "the invitation page names the team");
  check((await anon.inputValue('input[aria-label="Email"]')) === "newcomer@example.org", "...and fills in the email");
  await anon.fill('input[aria-label="Username"]', newUser);
  await anon.fill('input[aria-label="Password"]', PW1);
  await anon.fill('input[aria-label="Repeat the password"]', PW1 + "x");
  await anon.locator("form .btn.primary").click();
  await anon.waitForSelector(".error");
  check((await anon.locator(".error").innerText()).includes("differ"), "different passwords are refused");
  await anon.fill('input[aria-label="Repeat the password"]', PW1);
  await anon.locator("form .btn.primary").click();
  await anon.waitForSelector(".sidebar");
  check((await anon.locator(".topbar").innerText()).includes(newUser), "accepting the invitation signs the new user in");
  await anon.goto(link);
  await anon.waitForSelector(".error");
  check((await anon.locator(".error").innerText()).includes("invalid"), "the link works only once");
  // ---- members
  await root.reload();
  await root.waitForSelector(".admin");
  await root.locator(".side-item", { hasText: teamName }).click();
  await waitFor(async () => (await root.locator('[data-testid="members"] tr', { hasText: newUser }).count()) === 1, "the new user is a member of the team");
  check((await root.locator(".team-panel td", { hasText: "newcomer@example.org" }).count()) === 0, "the used invitation is gone from the list");
  await root.locator(`input[aria-label="${newUser} is team admin"]`).click({ force: true });
  await waitFor(() => root.locator(`input[aria-label="${newUser} is team admin"]`).isChecked(), "a member can be made team admin");
  // ---- users
  await root.locator(".tabs button", { hasText: "Users" }).click();
  await root.fill('input[aria-label="Filter users"]', newUser);
  await waitFor(async () => (await root.locator('[data-testid="users"] tbody tr').count()) === 1, "the users list finds the new user");
  await root.locator(`input[aria-label="${newUser} is active"]`).click({ force: true });
  await waitFor(async () => !(await root.locator(`input[aria-label="${newUser} is active"]`).isChecked()), "a user can be deactivated");
  await root.locator(`input[aria-label="${newUser} is active"]`).click({ force: true });
  await waitFor(() => root.locator(`input[aria-label="${newUser} is active"]`).isChecked(), "...and activated again");
  await root.locator(".btn", { hasText: "Edit" }).click();
  await root.fill('input[aria-label="First name"]', "Newcomer");
  await root.fill('input[aria-label="Email"]', "edited@example.org");
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator(".modal").count()) === 0, "the edit dialog closes after saving");
  await root.locator(".btn", { hasText: "Edit" }).click();
  await waitFor(async () => (await root.inputValue('input[aria-label="Email"]')) === "edited@example.org", "a user's email can be edited (and is read back)");
  await root.locator(".modal .btn", { hasText: "Cancel" }).click();
  await root.locator(".btn", { hasText: "Reset link" }).click();
  await root.waitForSelector('[data-testid="secret"]');
  check(/\/invite\/rst_/.test(await root.inputValue('[data-testid="secret"]')), "a password reset link is shown");
  await root.locator(".modal .btn.primary", { hasText: "Done" }).click();
  await root.locator(".btn", { hasText: "Random password" }).click();
  await root.waitForSelector('[data-testid="secret"]');
  const pw2 = await root.inputValue('[data-testid="secret"]');
  check(pw2.length >= 12, "a random password is shown once");
  await root.locator(".modal .btn.primary", { hasText: "Done" }).click();
  const again = await login(newUser, pw2); // the new password works
  check((await again.locator(".topbar").innerText()).includes(newUser), "the user can sign in with it");
  // the new user is team admin: sees Administration but no Users tab
  await again.locator("a", { hasText: "Administration" }).click();
  await again.waitForSelector(".admin");
  check((await again.locator(".tabs button", { hasText: "Users" }).count()) === 0, "a team admin sees the teams but not the user list");
  await root.locator(".btn", { hasText: "Delete" }).click();
  await waitFor(async () => (await root.locator('[data-testid="users"] tbody tr').count()) === 0, "a user can be deleted");
  // ---- products and annotation types
  await root.locator(".tabs button", { hasText: "Products" }).click();
  await root.locator(".btn", { hasText: "New product" }).click();
  await root.fill('input[aria-label="Product name"]', "E2E product");
  await root.selectOption('select[aria-label="Product team"]', { label: teamName });
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator('[data-testid="product-panel"] h3').count()) === 1 && (await root.locator('[data-testid="product-panel"] h3').innerText()) === "E2E product", "a product can be created and is shown");
  await root.locator(".btn", { hasText: "New annotation type" }).click();
  await root.fill('input[aria-label="Type name"]', "Mitosis");
  await root.selectOption('select[aria-label="Type shape"]', { label: "Fixed size box" });
  check((await root.locator('input[aria-label="Default width"]').count()) === 1 && (await root.locator('input[aria-label="Node count"]').count()) === 0, "a fixed size box asks for its size, not for a point count");
  await root.selectOption('select[aria-label="Type shape"]', { label: "Polygon" });
  check((await root.locator('input[aria-label="Node count"]').count()) === 1 && (await root.locator('input[aria-label="Default width"]').count()) === 0, "a polygon asks for the point count instead");
  await root.selectOption('select[aria-label="Type shape"]', { label: "Fixed size box" });
  await root.fill('input[aria-label="Default width"]', "64");
  await root.fill('input[aria-label="Default height"]', "64");
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitosis" }).count()) === 1, "an annotation type can be added");
  check((await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitosis" }).innerText()).includes("Fixed size box"), "...with its shape");
  await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitosis" }).locator(".btn", { hasText: "Edit" }).click();
  await root.fill('input[aria-label="Type name"]', "Mitotic figure");
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitotic figure" }).count()) === 1, "an annotation type can be renamed");
  await root.locator('input[aria-label="Mitotic figure is active"]').click({ force: true });
  await waitFor(async () => !(await root.locator('input[aria-label="Mitotic figure is active"]').isChecked()), "an annotation type can be deactivated");
  // a second product starts with the types of the first
  await root.locator(".btn", { hasText: "New product" }).click();
  await root.fill('input[aria-label="Product name"]', "E2E copy");
  await root.selectOption('select[aria-label="Product team"]', { label: teamName });
  await root.selectOption('select[aria-label="Copy types from"]', { label: `E2E product (${teamName})` });
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator('[data-testid="product-panel"] h3').count()) === 1 && (await root.locator('[data-testid="product-panel"] h3').innerText()) === "E2E copy", "the new product is shown");
  await waitFor(async () => (await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitotic figure" }).count()) === 1, "a new product can copy the types of another");
  await root.locator(".btn", { hasText: "Delete product" }).click();
  await waitFor(async () => (await root.locator(".side-item", { hasText: "E2E copy" }).count()) === 0, "a product can be deleted");
  await root.locator(".side-item", { hasText: "E2E product" }).click();
  await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitotic figure" }).locator(".btn", { hasText: "Delete" }).click();
  await waitFor(async () => (await root.locator('[data-testid="types"] tbody tr', { hasText: "Mitotic figure" }).count()) === 0, "an annotation type can be deleted");
  await root.locator(".btn", { hasText: "Delete product" }).click();
  await waitFor(async () => (await root.locator(".side-item", { hasText: "E2E product" }).count()) === 0, "...and the product with it");
  // ---- clean up the team
  await root.locator(".tabs button", { hasText: "Teams" }).click();
  await root.locator(".side-item", { hasText: teamName }).click();
  await root.locator(".team-panel .btn", { hasText: "Delete team" }).click();
  await waitFor(async () => (await root.locator(".side-item", { hasText: teamName }).count()) === 0, "a team can be deleted");
  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  await browser.close();
}
