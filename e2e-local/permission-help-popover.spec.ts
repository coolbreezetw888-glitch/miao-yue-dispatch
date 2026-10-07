// SPECS-INDEX #990(第 11 批 C 項):客服權限頁 + 服務人員權限 8 個開關的說明收進「?」。
// 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §3、§5.3。本機 Supabase 專用(e2e-local 設定,
// loopback guard 生效,不碰正式庫)。
//
//   ① 電腦 1280px:客服權限頁 → 說明不常駐 → 點「?」跳框(半形括號)→ 點旁邊關掉 → 開關狀態沒變、沒送出任何變更
//   ② 手機 375px:服務人員 → 編輯 → 權限功能 8 個開關 → 說明不常駐、每個都有「?」、「即將推出」還在
//      → 點「?」跳框 → 點旁邊關掉 → 開關狀態沒變
//   ③ 320px:兩頁各點一顆「?」,說明框不超出畫面、整頁沒有橫向捲動
//
// 執行:npx playwright test --config playwright.local.config.ts permission-help-popover

import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  STAFF_BOOLEAN_PERMISSION_FIELDS,
  visibleAgentPermissionSections,
} from "../src/modules/staff-agent/types";
import {
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SECTIONS = visibleAgentPermissionSections();

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 180_000 });

let fixture: LiveSyncFixture;
let agentId: string;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
  // 本機測試商家底下補一位「已邀請」的客服(商家刪除時 cascade 一起刪,teardown 不用另外處理)。
  const ins = await serviceClient()
    .from("merchant_agents")
    .insert({
      merchant_id: fixture.m1.merchantId,
      name: `E2E權限說明客服${fixture.runId}`,
      phone: "0911000990",
      invited_email: `e2e-perm-help-${fixture.runId}@example.test`,
      status: "invited",
    })
    .select("id")
    .single();
  if (ins.error) throw new Error(`建立測試客服失敗:${ins.error.message}`);
  agentId = (ins.data as { id: string }).id;
});

test.afterAll(async () => {
  if (fixture) await teardownLiveSyncFixture(fixture);
});

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

async function agentPermissionRowCount(): Promise<number> {
  const r = await serviceClient()
    .from("merchant_agent_permissions")
    .select("section_key", { count: "exact", head: true })
    .eq("agent_id", agentId);
  return r.count ?? 0;
}

async function openStaffEditor(page: Page) {
  const card = page.locator("li").filter({ hasText: fixture.staffA.name });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("switch", { name: /服務人員新增編輯訂單/ })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

test("#990 電腦 1280px:客服權限頁說明收進「?」,點開看得到(半形括號)、點旁邊關閉、開關不變", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, `/app/agents/${agentId}/permissions`);
  const rows = page.locator("main ul > li");
  await expect(rows).toHaveCount(SECTIONS.length, { timeout: LOAD_TIMEOUT });
  await expect(rows.getByTestId("permission-switch-title")).toHaveText(
    SECTIONS.map((s) => s.label),
  );
  await expect(page.getByRole("button", { name: /^說明：/ })).toHaveCount(SECTIONS.length);

  const orders = SECTIONS.find((s) => s.key === "orders")!;
  await expect(page.getByText(orders.description)).toHaveCount(0);
  const sw = page.getByRole("switch", { name: orders.label, exact: true });
  const before = await sw.getAttribute("data-state");
  const rowsBefore = await agentPermissionRowCount();

  await page.getByTestId("permission-help-trigger-orders").click();
  const popover = page.getByTestId("permission-help-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("使用會員點數折抵(紅利點數功能開啟時)。");
  await expect(popover).not.toContainText("（");

  await page.getByRole("heading", { level: 1 }).click();
  await expect(popover).toHaveCount(0);
  await expect(sw).toHaveAttribute("data-state", before ?? "unchecked");
  expect(await agentPermissionRowCount()).toBe(rowsBefore);
  await page.context().close();
});

test("#990 手機 375px:服務人員權限 8 個開關說明收進「?」,「即將推出」還在,點 ? 不切換開關", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 375, "/app/staff");
  await openStaffEditor(page);

  for (const f of STAFF_BOOLEAN_PERMISSION_FIELDS) {
    await expect(page.getByTestId(`permission-help-trigger-${f.key}`)).toHaveAttribute(
      "aria-label",
      `說明：${f.label}`,
    );
    await expect(page.getByText(f.description, { exact: true })).toHaveCount(0);
  }
  const comingSoon = STAFF_BOOLEAN_PERMISSION_FIELDS.filter((f) => f.comingSoon).length;
  await expect(
    page.getByTestId("permission-switch-title").filter({ hasText: "即將推出" }),
  ).toHaveCount(comingSoon);

  const field = STAFF_BOOLEAN_PERMISSION_FIELDS.find((f) => f.key === "unlimited_backend_edit")!;
  const sw = page.getByRole("switch", { name: new RegExp(field.label) });
  const before = await sw.getAttribute("data-state");
  const trigger = page.getByTestId(`permission-help-trigger-${field.key}`);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const popover = page.getByTestId("permission-help-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(
    "可預約時段以外(例如他只開 9 點到 18 點，開啟後 18 點以後也能排)。",
  );
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(sw).toHaveAttribute("data-state", before ?? "unchecked");
  // Esc 只關說明框,編輯視窗還在
  await expect(sw).toBeVisible();

  // 再開一次,點旁邊(開關名稱以外的空白處 = 說明框外)關閉
  await trigger.click();
  await expect(popover).toBeVisible();
  const box = (await popover.boundingBox())!;
  await page.mouse.click(box.x + 4, Math.max(box.y - 30, 4));
  await expect(popover).toHaveCount(0);
  await expect(sw).toHaveAttribute("data-state", before ?? "unchecked");
  await page.context().close();
});

test("#990 320px:兩頁的說明框不超出畫面、沒有橫向捲動", async ({ browser }) => {
  const page = await openAsAdmin(browser, 320, `/app/agents/${agentId}/permissions`);
  await expect(page.locator("main ul > li")).toHaveCount(SECTIONS.length, {
    timeout: LOAD_TIMEOUT,
  });
  // 說明最長的那一項(服務人員管理)
  await page.getByTestId("permission-help-trigger-staff_management").click();
  let popover = page.getByTestId("permission-help-popover");
  await expect(popover).toBeVisible();
  let box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await assertNoHorizontalOverflow(page, "320px 客服權限頁(說明框打開)");
  await page.keyboard.press("Escape");

  await page.goto("/app/staff");
  await openStaffEditor(page);
  const trigger = page.getByTestId("permission-help-trigger-can_create_edit_orders");
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  popover = page.getByTestId("permission-help-popover");
  await expect(popover).toBeVisible();
  box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await assertNoHorizontalOverflow(page, "320px 服務人員權限開關(說明框打開)");
  await page.context().close();
});
