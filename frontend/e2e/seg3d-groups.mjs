// End-to-end test of groups and the eyes in the segmentation list of the three-plane view: two types of one group exclude each other,
// the other masks that are switched on are drawn striped, painting over one takes its voxels (the striped mask follows), undo gives them back.
// Usage: node e2e/seg3d-groups.mjs [baseUrl]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://127.0.0.1:8002";
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IMAGE = 80, SET = 1, PRODUCT = 2;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  -", msg);
};
const waitFor = async (fn, msg, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("FAILED (timeout): " + msg);
    await new Promise((r) => setTimeout(r, 120));
  }
};
const login = async (context, user) => {
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector("form.login");
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', "rust-test-pw");
  await page.click("button.primary");
  await page.waitForSelector(".cards .card");
  return page;
};
const apiCall = (page, method, url, body) =>
  page.evaluate(
    async ([method, url, body]) => {
      const csrf = (await (await fetch("/api/v2/auth/me")).json()).csrf_token;
      const r = await fetch(url, { method, headers: { "x-csrf-token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
    },
    [method, url, body ?? null],
  );

const root = await login(await browser.newContext(), "aubreville");
const made = { types: [], masks: [] };
try {
  await apiCall(root, "PUT", `/api/v2/image-sets/${SET}/products/${PRODUCT}`);
  // the types stay between runs (a type that annotations ever used cannot be deleted): found by name
  const have = Object.fromEntries(((await apiCall(root, "GET", `/api/v2/products/${PRODUCT}/annotation-types`)).body.items).map((t) => [t.name, t.id]));
  for (const [name, color] of [["e2e-liver", "#cc3333"], ["e2e-spleen", "#3366cc"]]) {
    const body = { name, vector_type: 8, product: PRODUCT, color_code: color, seg_group: "organs" };
    const r = have[name] ? await apiCall(root, "PATCH", `/api/v2/annotation-types/${have[name]}`, { seg_group: "organs" }) : await apiCall(root, "POST", "/api/v2/annotation-types", body);
    check(r.status === 200 || r.status === 201, `type ${name} is in the group "organs"`);
    made.types.push(r.body.id);
  }
  const [tA, tB] = made.types;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem("exact.seg3d.view", "full"));
  const page = await login(ctx, "rt_teamadmin");
  await page.goto(`${base}/images/${IMAGE}/planes`);
  for (const n of ["axial", "coronal", "sagittal"]) await page.waitForSelector(`[data-testid="mpr-${n}"] canvas`);

  await page.waitForSelector('.dropdown[data-name="segment"] .trigger');
  const trigger = page.locator('.dropdown[data-name="segment"] .trigger');
  const openList = async () => {
    if ((await page.locator(".dd-pop").count()) === 0) await trigger.click();
    await page.waitForSelector(".dd-pop");
  };
  const row = (t) => page.locator(`.dd-row[data-id="${t}"]`);
  const pickType = async (t) => {
    await openList();
    await row(t).locator(".dd-item").click();
  };
  await openList();
  check((await page.locator('[data-testid="dd-group"]').count()) >= 1, "the Segment list shows the group as a heading");
  for (const t of made.types) check((await row(t).evaluate((el) => el.classList.contains("in-group"))) === true, `...with type ${t} in it`);
  check((await page.locator('[data-testid="seg-classes"]').count()) === 0, "there is no separate list any more");
  await trigger.click(); // closes it again

  await pickType(tA);
  await page.waitForSelector(".seg3d-panel");
  check((await page.locator('[data-testid="seg3d-exclusive"]').innerText()).includes("spleen"), "the tool window says which masks are exclusive with the one painted");
  await waitFor(async () => (await page.locator('[data-testid="mask-overlay"]').count()) === 3, "the mask of A is on all three planes");
  const maskId = async (t) => ((await apiCall(root, "GET", `/api/v2/annotations?image=${IMAGE}&deleted=false&annotation_type=${t}&limit=5`)).body.items[0] ?? {}).id;
  const count = async (t) => (await apiCall(root, "GET", `/api/v2/segmentation/${await maskId(t)}/volume`)).body.count;
  const box = await page.locator('[data-testid="mpr-axial"]').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const stroke = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
  };
  await stroke(at(0.4, 0.5), at(0.5, 0.5));
  await waitFor(async () => (await count(tA)) > 50, "painting A makes a mask");
  const nA = await count(tA);

  // B: switch to it, the eye of A shows A's mask striped next to it
  await pickType(tB);
  await waitFor(async () => (await maskId(tB)) != null, "the mask of B is made");
  check((await page.locator('[data-testid="mask-overlay"][data-striped="1"]').count()) === 0, "no striped mask while no eye is switched on");
  await openList();
  await row(tA).locator('[data-testid="dd-eye"]').click();
  check((await page.locator(".dd-pop").count()) === 1, "a click on an eye keeps the list open");
  await trigger.click();
  await waitFor(async () => (await page.locator('[data-testid="mask-overlay"][data-striped="1"]').count()) === 3, "the eye shows A striped on all three planes");
  check((await page.locator('[data-testid="mask-overlay"][data-striped="0"]').count()) === 3 || (await page.locator('[data-testid="mask-overlay"]:not([data-striped="1"])').count()) === 3, "the mask being painted stays solid");

  // painting B over half of A takes the voxels of A
  await stroke(at(0.47, 0.5), at(0.6, 0.5));
  await waitFor(async () => (await count(tB)) > 50, "painting B makes a mask");
  await waitFor(async () => (await count(tA)) < nA, `A lost voxels to B (${nA} -> ${await count(tA)})`);
  const nA2 = await count(tA);
  const nB = await count(tB);
  // undo gives them back
  await page.locator('[data-testid="seg3d-undo"]').click();
  await waitFor(async () => (await count(tA)) === nA, "undo of B gives the voxels back to A");
  await page.locator('[data-testid="seg3d-redo"]').click();
  await waitFor(async () => (await count(tA)) === nA2 && (await count(tB)) === nB, `redo takes them again (A ${await count(tA)} want ${nA2}, B ${await count(tB)} want ${nB})`);
  // slice keys: arrows step the axial plane, Shift the coronal and Alt the sagittal plane
  const pos = async (n) => Number((await page.locator(`[data-testid="mpr-${n}"]`).innerText()).match(/(\d+) \/ \d+/)[1]);
  const [a0, c0, s0] = [await pos("axial"), await pos("coronal"), await pos("sagittal")];
  await page.keyboard.press("ArrowUp");
  await waitFor(async () => (await pos("axial")) === a0 + 1, "ArrowUp steps the axial plane");
  await page.keyboard.press("Shift+ArrowUp");
  await waitFor(async () => (await pos("coronal")) === c0 + 1, "Shift + ArrowUp steps the coronal plane");
  await page.keyboard.press("Alt+ArrowDown");
  await waitFor(async () => (await pos("sagittal")) === s0 - 1, "Alt + ArrowDown steps the sagittal plane back");
  check((await pos("axial")) === a0 + 1, "...and the axial plane stayed");
  check(((await page.locator(".mpr-step").first().getAttribute("title")) ?? "").includes("Page"), "the slice buttons say which keys step them");
  await page.locator('[data-testid="mpr-max-coronal"]').dispatchEvent("click");
  await page.keyboard.press("ArrowUp");
  await waitFor(async () => (await pos("coronal")) === c0 + 2, "in a maximized plane the arrows step that plane");
  await page.locator('[data-testid="mpr-max-coronal"]').dispatchEvent("click");
  // the 3D render shows the visible masks
  await page.locator('[data-testid="show-render3d"]').click();
  await page.waitForSelector('[data-testid="render3d-mask"]');
  await waitFor(async () => (await page.locator('[data-testid="render3d-mask"]').isEnabled()) && /Masks/.test(await page.locator(".render3d-checks").innerText()), "the 3D render offers both visible masks", 40000);
  // an ungrouped neighbour would not lose anything: covered in the conformance tests
} finally {
  for (const t of made.types) {
    const items = (await apiCall(root, "GET", `/api/v2/annotations?image=${IMAGE}&deleted=false&annotation_type=${t}&limit=5`)).body?.items ?? [];
    for (const a of items) await apiCall(root, "DELETE", `/api/v2/annotations/${a.id}`);
  }
  await browser.close();
}
console.log("done");
