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
  // ---- a worker account: created with a preset and teams, its permissions changed in a dialog
  const workerName = `e2e-worker-${String(Date.now()).slice(-6)}`;
  await root.fill('input[aria-label="Filter users"]', "");
  await root.locator(".btn", { hasText: "New worker account" }).click();
  await root.fill('.modal input[aria-label="User name"]', workerName);
  check((await root.locator('[data-testid="preset-info"]').innerText()).includes("processing.add_plugin"), "the new-worker dialog says what the preset grants");
  await root.fill('.modal input[aria-label="Filter teams"]', teamName);
  await root.locator('[data-testid="team-pick"] label', { hasText: teamName }).locator("input").check();
  await root.locator(".modal .btn.primary", { hasText: "Create account" }).click();
  await root.waitForSelector('[data-testid="worker-env"]');
  const workerEnv = await root.inputValue('[data-testid="worker-env"]');
  check(workerEnv.includes(`WORKER_USER=${workerName}`) && /WORKER_PASSWORD=\S{20,}/.test(workerEnv), "the account name and password are shown once, as the lines for the env file");
  const workerPw = workerEnv.match(/WORKER_PASSWORD=(\S+)/)[1];
  await root.locator(".modal .btn.primary", { hasText: "Done" }).click();
  const workerPage = await login(workerName, workerPw);
  check((await workerPage.locator(".side-item", { hasText: teamName }).count()) === 1, "the worker can sign in and is a member of the chosen team");
  await root.fill('input[aria-label="Filter users"]', workerName);
  await waitFor(async () => (await root.locator('[data-testid="users"] tbody tr').count()) === 1, "the users list finds the worker");
  check((await root.locator('[data-testid="roles-legend"]').innerText()).includes("Administrator") && (await root.locator('[data-testid="users"] th', { hasText: "Edits profiles" }).count()) === 1, "the Users tab explains the roles");
  const adminBox = root.locator(`input[aria-label="${workerName} is administrator"]`);
  check(!(await adminBox.isChecked()), "a worker account is no administrator");
  await adminBox.click({ force: true });
  await waitFor(() => adminBox.isChecked(), "a superuser can make a user an administrator (the role of the Users tab)...");
  await adminBox.click({ force: true });
  await waitFor(async () => !(await adminBox.isChecked()), "...and take it away again");
  await root.locator(".btn", { hasText: "Permissions" }).click();
  await root.waitForSelector('[data-testid="permissions"]');
  const isOn = (key) => root.locator(`.modal input[data-key="${key}"]`).isChecked();
  check((await isOn("processing.add_plugin")) && (await isOn("processing.change_pluginjob")) && (await isOn("images.change_imageregistration")), "the permissions dialog shows the preset's permissions as ticked");
  await root.locator(".preset", { hasText: "Analysis worker" }).locator(".btn").click();
  check((await isOn("processing.add_pluginresult")) && !(await isOn("images.change_imageregistration")), "another preset replaces the ticks");
  await root.locator('.modal input[data-key="processing.change_pluginjob"]').uncheck();
  await root.locator(".modal .btn.primary", { hasText: "Save" }).click();
  await waitFor(async () => (await root.locator(".modal").count()) === 0, "the permissions are saved");
  await root.locator(".btn", { hasText: "Permissions" }).click();
  await root.waitForSelector('[data-testid="permissions"]');
  check((await isOn("processing.add_pluginresult")) && !(await isOn("processing.change_pluginjob")) && !(await isOn("images.change_imageregistration")), "...and read back as saved");
  await root.locator(".modal .btn", { hasText: "Cancel" }).click();
  check((await again.locator('[data-testid="users"]').count()) === 0, "a team admin has no permission dialogs");
  await root.locator(".btn", { hasText: "Delete" }).click();
  await waitFor(async () => (await root.locator('[data-testid="users"] tbody tr').count()) === 0, "the worker account can be deleted");
  await root.fill('input[aria-label="Filter users"]', "");
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
  // ---- plugins: registered algorithms and what they did
  await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const r = await fetch("/api/v2/plugins/register", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "E2E overview method", package: "e2e_ov", plugin_type: 2, parameters_schema: [{ name: "n", type: "int", default: 3, help: "a number" }] }) });
    if (r.status !== 201) throw new Error("register " + r.status);
  });
  await root.locator(".tabs button", { hasText: "Plugins" }).click();
  await root.waitForSelector('[data-testid="plugins"]');
  await waitFor(async () => (await root.locator('[data-testid="plugins"] tr', { hasText: "E2E overview method" }).count()) === 1, "a registered plugin is listed in the overview");
  const pluginRow = root.locator('[data-testid="plugins"] tr', { hasText: "E2E overview method" });
  check((await pluginRow.innerText()).includes("Registration") && (await pluginRow.innerText()).includes("1 parameters"), "...as a registration plugin with its parameters");
  check((await pluginRow.locator('[data-testid="served-by"]').innerText()).includes("no worker connected"), "...and says that no worker serves it");
  await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    const list = await (await fetch("/api/v2/plugins?fields=id,name&limit=1000")).json();
    for (const p of list.items.filter((x) => x.name === "E2E overview method")) await fetch(`/api/v2/plugins/${p.id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
  });
  // ---- jobs: registrations and image analyses in one list
  await root.evaluate(async () => {
    const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
    // a registration needs a plugin (the overview test above removed its own); this suite must not depend on another one having left one
    await fetch("/api/v2/plugins/register", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ name: "E2E jobs method", package: "e2e_jobs", plugin_type: 2 }) });
    const r = await fetch("/api/v2/images/15/register", { method: "POST", headers: { "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ target_image: 16 }) });
    if (r.status !== 202) throw new Error("register " + r.status);
  });
  await root.locator("a", { hasText: /^Jobs/ }).click();
  await root.waitForSelector('[data-testid="jobs"]');
  await waitFor(async () => (await root.locator('[data-testid="jobs"] tr[data-kind="registration"]').count()) >= 1, "a queued registration shows up in the job list");
  const jobRow = root.locator('[data-testid="jobs"] tr[data-kind="registration"][data-status="queued"]').first();
  check((await jobRow.innerText()).includes("waiting for a worker"), "...as waiting for a worker");
  await root.selectOption('select[aria-label="Kind of job"]', "plugin");
  await waitFor(async () => (await root.locator('[data-testid="jobs"] tr[data-kind="registration"]').count()) === 0, "the kind filter hides the registrations");
  await root.selectOption('select[aria-label="Kind of job"]', "");
  await jobRow.locator(".btn", { hasText: "Cancel" }).click();
  await waitFor(async () => (await root.locator('[data-testid="jobs"] tr[data-kind="registration"][data-status="queued"]').count()) === 0, "a waiting job can be cancelled");
  await root.locator("a", { hasText: "Administration" }).click();
  await root.waitForSelector(".admin");
  // ---- clean up the team
  await root.locator(".tabs button", { hasText: "Teams" }).click();
  await root.locator(".side-item", { hasText: teamName }).click();
  await root.locator(".team-panel .btn", { hasText: "Delete team" }).click();
  await waitFor(async () => (await root.locator(".side-item", { hasText: teamName }).count()) === 0, "a team can be deleted");
  check(errors.length === 0, "no console errors: " + errors.join(" | "));
} finally {
  await browser.close();
}
