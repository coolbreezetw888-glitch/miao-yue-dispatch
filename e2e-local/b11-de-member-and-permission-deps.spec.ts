// 第 11 批 D(#991)+ E(#992):本機 Supabase 專用(e2e-local 設定,loopback guard 生效,不碰正式庫)。
// 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §10.6、§11.10 e2e-local。
//
//   D:會員詳情「標記」只剩黑名單;紅利點數頁「核發獎勵資格條件」下拉只有 2 個選項。
//   E:客服權限頁相依權限小卡窗(取消 / 只開這一個 / 一起開啟、一起關閉 / 只關這一個),每一步用
//      service client 讀 DB 核對;舊資料黃色 `!`;重新整理後畫面與 DB 一致;
//      1280 / 375 / 320 小卡窗開著時無橫向捲動、三顆按鈕排列(手機直排整條寬、電腦一列等寬)。
//   測完把這位客服的權限寫回測試前的值(測試前後對照印在 console,回報用)。
//   截圖存 test-results/b11-e-shots/(不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b11-de-member-and-permission-deps

import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  adminRpc,
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = "test-results/b11-e-shots";
const THREE = ["material_costs", "commission_settings", "team_leave"] as const;
const LABEL: Record<string, string> = {
  material_costs: "料錢成本管理",
  commission_settings: "抽成與薪資設定",
  team_leave: "月薪人員假別設定",
  members: "會員管理",
  member_points: "紅利點數",
};

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let agentId: string;
let memberId: string;
let permsBefore: Record<string, boolean> = {};

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
  const ins = await serviceClient()
    .from("merchant_agents")
    .insert({
      merchant_id: fixture.m1.merchantId,
      name: `E2E相依權限客服${fixture.runId}`,
      phone: "0911000992",
      invited_email: `e2e-perm-deps-${fixture.runId}@example.test`,
      status: "invited",
    })
    .select("id")
    .single();
  if (ins.error) throw new Error(`建立測試客服失敗:${ins.error.message}`);
  agentId = (ins.data as { id: string }).id;

  const member = (await adminRpc(fixture.m1, "create_member", {
    p_merchant_id: fixture.m1.merchantId,
    p_name: `E2E第11批D會員${fixture.runId}`,
    p_phone: "0912991991",
  })) as { id: string };
  memberId = member.id;

  permsBefore = await readPerms();
});

test.afterAll(async () => {
  if (!fixture) return;
  // 把這位客服的權限寫回測試前的值(只動這位 fixture 客服;商家刪除時也會 cascade)。
  if (agentId) {
    const after = await readPerms();
    const keys = [...new Set([...Object.keys(permsBefore), ...Object.keys(after)])].sort();
    const restore = keys.map((k) => ({ section_key: k, granted: permsBefore[k] ?? false }));
    if (restore.length > 0) {
      const res = await fixture.m1.admin.rpc("set_agent_permissions", {
        p_agent_id: agentId,
        p_changes: restore,
      });
      if (res.error) throw new Error(`還原權限失敗:${res.error.message}`);
    }
    const restored = await readPerms();
    console.log(
      "[b11-e] 權限前後對照:",
      JSON.stringify({ before: permsBefore, afterTest: after, restored }),
    );
    for (const k of keys) expect(restored[k] ?? false).toBe(permsBefore[k] ?? false);
  }
  await teardownLiveSyncFixture(fixture);
});

async function readPerms(): Promise<Record<string, boolean>> {
  const r = await serviceClient()
    .from("merchant_agent_permissions")
    .select("section_key, granted")
    .eq("agent_id", agentId);
  if (r.error) throw new Error(r.error.message);
  return Object.fromEntries(
    (r.data as { section_key: string; granted: boolean }[]).map((p) => [p.section_key, p.granted]),
  );
}

async function expectDb(expected: Partial<Record<string, boolean>>) {
  await expect
    .poll(async () => {
      const p = await readPerms();
      return Object.fromEntries(Object.keys(expected).map((k) => [k, p[k] ?? false]));
    })
    .toEqual(expected);
}

async function setDb(values: Record<string, boolean>) {
  const res = await fixture.m1.admin.rpc("set_agent_permissions", {
    p_agent_id: agentId,
    p_changes: Object.entries(values).map(([k, v]) => ({ section_key: k, granted: v })),
  });
  if (res.error) throw new Error(res.error.message);
}

async function openAsAdmin(browser: Browser, width: number, path: string): Promise<Page> {
  const session = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(session).not.toBeNull();
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 812 : 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, session!);
  await page.goto("/app");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(path);
  return page;
}

const sw = (page: Page, key: string) => page.locator(`#agent-permission-switch-${key}`);
const dialog = (page: Page) => page.getByTestId("agent-permission-dependency-confirm");

/** 等小卡窗的開啟動畫(zoom-in-95)播完再量尺寸,否則會量到縮放中的 43.99px。 */
async function settleDialog(page: Page) {
  await dialog(page).evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
}

async function waitIdle(page: Page) {
  // 寫入中整頁開關 disabled;等「訂單管理」恢復可按 = 這次寫入結束。
  await expect(sw(page, "orders")).toBeEnabled({ timeout: LOAD_TIMEOUT });
}

async function expectChecked(page: Page, key: string, on: boolean) {
  await expect(sw(page, key)).toHaveAttribute("data-state", on ? "checked" : "unchecked");
}

// ---------------------------------------------------------------------------
// D
// ---------------------------------------------------------------------------

test("D:會員詳情「標記」只剩黑名單;紅利點數頁資格條件下拉只有 2 個選項", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, `/app/members/${memberId}`);
  const recorder = recordRequestHosts(page);
  await expect(page.getByText("黑名單狀態")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("電話驗證狀態")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "標記為已驗證" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消驗證標記" })).toHaveCount(0);

  await page.goto("/app/member-points");
  const select = page.getByRole("combobox", { name: "資格條件" });
  await expect(select).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(/客服人工標記/)).toHaveCount(0);
  await select.click();
  await expect(page.getByRole("option")).toHaveText(["不限制", "只看 LINE 已綁定"]);
  await page.keyboard.press("Escape");
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

// ---------------------------------------------------------------------------
// E:1280 完整流程(每一步 DB 核對)
// ---------------------------------------------------------------------------

test("E 1280:取消 / 一起開啟 / 一起關閉 / 只開這一個 / 只關這一個,每一步 DB 核對", async ({
  browser,
}) => {
  await setDb({
    material_costs: false,
    commission_settings: false,
    team_leave: false,
    members: false,
    member_points: false,
  });
  const page = await openAsAdmin(browser, 1280, `/app/agents/${agentId}/permissions`);
  const recorder = recordRequestHosts(page);
  await expect(page.locator("main ul > li").first()).toBeVisible({ timeout: LOAD_TIMEOUT });

  // ① 點料錢成本管理 ⇒ 小卡窗列 2 項;開關還沒亮
  await sw(page, "material_costs").click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).locator("[data-testid^='agent-permission-dependency-item-']"),
  ).toHaveCount(2);
  await expect(dialog(page)).toContainText("要一起開啟 2 個相關權限嗎？");
  await expect(dialog(page)).toContainText("月薪金額與抽成比例");
  await expectChecked(page, "material_costs", false);
  await page.screenshot({ path: `${SHOTS}/e-1280-enable-dialog.png` });

  // 1280:三顆同一列、寬度相差 ≤ 1px、高度 ≥ 44
  await settleDialog(page);
  const buttons = dialog(page).getByRole("button");
  await expect(buttons).toHaveText(["取消", "只開這一個", "一起開啟"]);
  const boxes = await Promise.all(
    [0, 1, 2].map(async (i) => (await buttons.nth(i).boundingBox())!),
  );
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThanOrEqual(1);
  const widths = boxes.map((b) => b.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44);
  await assertNoHorizontalOverflow(page, "1280 客服權限頁(相依小卡窗開著)");

  // ② 取消 ⇒ DB 三把仍是關
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expectDb({ material_costs: false, commission_settings: false, team_leave: false });
  for (const k of THREE) await expectChecked(page, k, false);

  // ③ 再點 → 一起開啟 ⇒ DB 三把都開
  await sw(page, "material_costs").click();
  await dialog(page).getByRole("button", { name: "一起開啟" }).click();
  await expectDb({ material_costs: true, commission_settings: true, team_leave: true });
  await waitIdle(page);
  for (const k of THREE) await expectChecked(page, k, true);

  // ④ 關假別 → 一起關閉 ⇒ DB 三把都關
  await sw(page, "team_leave").click();
  await expect(dialog(page)).toContainText("要一起關閉 2 個相關權限嗎？");
  await expect(dialog(page).getByRole("button")).toHaveText(["取消", "只關這一個", "一起關閉"]);
  await page.screenshot({ path: `${SHOTS}/e-1280-disable-dialog.png` });
  await dialog(page).getByRole("button", { name: "一起關閉" }).click();
  await expectDb({ material_costs: false, commission_settings: false, team_leave: false });
  await waitIdle(page);

  // ⑤ 會員管理 / 紅利點數都關,點會員管理 → 只開這一個 ⇒ DB 只有會員管理開、黃色 `!` 出現
  await sw(page, "members").click();
  await expect(dialog(page)).toContainText("要一起開啟 1 個相關權限嗎？");
  await page.getByTestId("agent-permission-dependency-only-this").click();
  await expectDb({ members: true, member_points: false });
  await waitIdle(page);
  const membersNote = page.getByTestId("permission-dependency-note-members");
  await expect(membersNote).toBeVisible();
  await expect(membersNote).toHaveAttribute("role", "note");
  await page.screenshot({ path: `${SHOTS}/e-1280-only-this-note.png`, fullPage: true });

  // ⑥ 再點紅利點數(閉包空 ⇒ 不跳窗)⇒ 提醒消失
  await sw(page, "member_points").click();
  await expect(dialog(page)).toHaveCount(0);
  await expectDb({ members: true, member_points: true });
  await waitIdle(page);
  await expect(membersNote).toHaveCount(0);

  // ⑦ 關紅利點數 → 只關這一個 ⇒ 會員管理下方提醒再出現
  await sw(page, "member_points").click();
  await expect(dialog(page)).toContainText("要一起關閉 1 個相關權限嗎？");
  await page.getByTestId("agent-permission-dependency-only-this").click();
  await expectDb({ members: true, member_points: false });
  await waitIdle(page);
  await expect(page.getByTestId("permission-dependency-note-members")).toBeVisible();

  // ⑧ 會員管理 / 紅利點數 再用「一起」跑一次開與關
  await sw(page, "member_points").click(); // 會員管理已開 ⇒ 不跳窗
  await expectDb({ members: true, member_points: true });
  await waitIdle(page);
  await sw(page, "members").click();
  await dialog(page).getByRole("button", { name: "一起關閉" }).click();
  await expectDb({ members: false, member_points: false });
  await waitIdle(page);
  await sw(page, "member_points").click();
  await dialog(page).getByRole("button", { name: "一起開啟" }).click();
  await expectDb({ members: true, member_points: true });
  await waitIdle(page);

  // ⑨ 重新整理後畫面與 DB 一致
  await page.reload();
  await expect(page.locator("main ul > li").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  const db = await readPerms();
  for (const k of [...THREE, "members", "member_points"]) {
    await expectChecked(page, k, db[k] ?? false);
  }
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

// ---------------------------------------------------------------------------
// E:手機 375 / 320 三顆直排、無橫向捲動
// ---------------------------------------------------------------------------

for (const width of [375, 320]) {
  test(`E ${width}px:小卡窗三顆直排整條寬、文字單行、無橫向捲動`, async ({ browser }) => {
    await setDb({ material_costs: false, commission_settings: false, team_leave: false });
    const page = await openAsAdmin(browser, width, `/app/agents/${agentId}/permissions`);
    await expect(page.locator("main ul > li").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    const target = sw(page, "material_costs");
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await expect(dialog(page)).toBeVisible();

    await settleDialog(page);
    const content = (await dialog(page).boundingBox())!;
    expect(content.x).toBeGreaterThanOrEqual(0);
    expect(content.x + content.width).toBeLessThanOrEqual(width);
    // 小卡窗內寬 = 內容區寬(扣掉左右內距與邊框)
    const innerWidth = await dialog(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });

    const buttons = dialog(page).getByRole("button");
    const boxes = await Promise.all(
      [0, 1, 2].map(async (i) => (await buttons.nth(i).boundingBox())!),
    );
    // DOM 順序 取消、只開這一個、一起開啟;畫面由上到下 一起開啟 / 只開這一個 / 取消
    expect(boxes[2]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[0]!.y);
    for (const b of boxes) {
      expect(Math.abs(b.width - innerWidth)).toBeLessThanOrEqual(1);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeLessThanOrEqual(48);
    }
    await assertNoHorizontalOverflow(page, `${width}px 客服權限頁(相依小卡窗開著)`);
    await page.screenshot({ path: `${SHOTS}/e-${width}-enable-dialog.png` });

    await dialog(page).getByRole("button", { name: "取消" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expectDb({ material_costs: false, commission_settings: false, team_leave: false });
    await page.context().close();
  });
}
