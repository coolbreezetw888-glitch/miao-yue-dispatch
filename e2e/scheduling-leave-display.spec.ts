// 模組 7(排班與休假管理)規格書 §8 自動化測試規劃明確要求、但當時因時間因素跳過的兩支
// Playwright 測試(2026-09-20 主腦複查後補齊,見 SPECS-INDEX 編號 266/267 備註):
//
//   1. 排班一覽頁面(§4.4):建立一筆整天請假紀錄後,排班一覽正確顯示灰底+假別名稱的請假標示;
//      取消請假後,恢復正常顯示(不再是灰底)。
//   2. 行事曆疊加請假顯示(§4.5):請假當天,行事曆上該服務人員整欄變成灰底、不可點擊建單的
//      樣式;非請假的日期/其他服務人員不受影響。
//
// 這是跨頁面的視覺呈現行為(不是純邏輯),比照 ARCHITECTURE.md 第八節第 5 條/automated-testing
// SKILL 的分工原則,用真正的 Playwright 瀏覽器測試,不是 Vitest 邏輯測試——`describeScheduleCell`
// 這個純函式判斷邏輯已經有 Vitest 涵蓋(src/modules/scheduling/types.test.ts),但「後端資料
// 有沒有真的正確傳到畫面上、畫面有沒有真的套用正確的樣式」只有真實瀏覽器測得出來。
//
// fixture 資料建立/清理見 e2e/support/scheduling-leave-fixture.ts。
import { expect, test } from "@playwright/test";

import {
  cancelFixtureLeave,
  createStaffLeaveForCalendarTest,
  injectSchedulingLeaveFixtureSession,
  LEAVE_TYPE_NAME,
  setupSchedulingLeaveFixture,
  teardownSchedulingLeaveFixture,
  type SchedulingLeaveFixture,
} from "./support/scheduling-leave-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: SchedulingLeaveFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupSchedulingLeaveFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[scheduling-leave-display] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownSchedulingLeaveFixture(fixture);
  console.log(
    "[scheduling-leave-display] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectSchedulingLeaveFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 Require*Access 守衛誤判導回 /app。為什麼是這個頁面/這個錨點,見
  // e2e/support/app-shell.ts 的完整說明。
  await primeCurrentMerchant(page);
});

test("排班一覽(§4.4):整天請假顯示灰底+假別名稱,取消後恢復正常", async ({ page }) => {
  await page.goto("/app/scheduling");
  // 等表格真的載入完成(兩位測試服務人員的名字都出現在最左欄)。
  await expect(page.getByText(fixture.staffOnLeaveName)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(fixture.staffNormalName)).toBeVisible();

  // 請假中的服務人員,今天這一格要顯示「休假:{假別名稱}」且是灰底(bg-muted,見
  // SchedulingOverviewPage.tsx 的 CELL_TONE_CLASSES.leave)。
  const leaveCell = page.getByRole("link", { name: `休假:${LEAVE_TYPE_NAME}`, exact: true });
  await expect(leaveCell).toBeVisible();
  await expect(leaveCell).toHaveClass(/bg-muted\b/);

  // 正常服務人員的所有格子都不應該出現「休假」字樣(不受影響)。
  const staffNormalRow = page.locator("tr", { hasText: fixture.staffNormalName });
  await expect(staffNormalRow.getByText("休假:", { exact: false })).toHaveCount(0);

  // 取消請假後(直接呼叫跟前端相同的 cancel_staff_leave RPC,見 fixture 檔頭說明),重新整理
  // 應該恢復正常顯示——因為兩位服務人員都設了 no_time_slot_limit=true,恢復正常後這一格應該顯示
  // 「不受時段限制」文字(見 describeScheduleCell 優先權 4),不再是灰底請假標示。
  await cancelFixtureLeave(fixture);
  await page.reload();
  await expect(page.getByText(fixture.staffOnLeaveName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  await expect(
    page.getByRole("link", { name: `休假:${LEAVE_TYPE_NAME}`, exact: true }),
  ).toHaveCount(0);
  const staffOnLeaveRow = page.locator("tr", { hasText: fixture.staffOnLeaveName });
  await expect(staffOnLeaveRow.getByText("不受時段限制", { exact: false }).first()).toBeVisible();
});

test("行事曆(§4.5):請假當天整欄灰底不可建單,非請假日期/其他服務人員不受影響", async ({ page }) => {
  // 這個測試獨立於上一個測試——上一個測試結束時已經把 fixture 的請假紀錄取消掉了,這裡重新
  // 建立一筆(範圍還是「今天」),確保這個測試不依賴前一個測試有沒有先跑過、跑到哪個階段。
  await createStaffLeaveForCalendarTest(fixture);

  await page.goto(`/app/calendar?date=${fixture.todayDateKey}`);
  await expect(page.getByRole("button", { name: "週檢視" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  // SPECS-INDEX #640:行事曆預設改成先顯示月檢視,這裡要測的是週檢視底下的服務人員欄位,
  // 先手動切回週檢視,不能再假設進頁面時預設就是週檢視。
  await page.getByRole("button", { name: "週檢視" }).click();
  await expect(page.getByText(fixture.staffOnLeaveName, { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const leaveColumn = page.getByTestId(`staff-column-${fixture.staffOnLeaveId}`);
  const normalColumn = page.getByTestId(`staff-column-${fixture.staffNormalId}`);

  // 請假服務人員:欄位標題顯示「休假:{假別名稱}」,且有一個涵蓋全高、標示不可預約的灰底遮罩。
  await expect(leaveColumn.getByText(`休假:${LEAVE_TYPE_NAME}`, { exact: false })).toBeVisible();
  await expect(
    leaveColumn.getByLabel(`休假:${LEAVE_TYPE_NAME},無法預約`, { exact: true }),
  ).toBeVisible();
  // 不可點擊建單:請假時整欄不會渲染任何時段格子/下拉選單(見 CalendarPage.tsx `s.on_leave ?
  // null : slots.map(...)`),用「沒有任何 button 元素」佐證這一欄底下沒有可互動的建單入口。
  await expect(leaveColumn.locator("button")).toHaveCount(0);

  // 正常服務人員(同一天):不受影響,欄位標題不會出現「休假」字樣,而且因為
  // no_time_slot_limit=true + 商家整週營業,應該渲染出正常、可點擊的「可預約」時段格子
  // (aria-label="可預約",見 CalendarPage.tsx 的 DropdownMenuTrigger 按鈕)。
  await expect(normalColumn.getByText("休假", { exact: false })).toHaveCount(0);
  await expect(normalColumn.getByLabel("可預約").first()).toBeVisible();
  // 對照組:請假服務人員這一欄完全沒有「可預約」的時段按鈕(也沒有「不可預約」的純視覺格子,
  // 因為 on_leave 時整段背景格線邏輯直接跳過,只渲染灰底遮罩,見 CalendarPage.tsx `s.on_leave ?
  // null : slots.map(...)`)。
  await expect(leaveColumn.getByLabel("可預約")).toHaveCount(0);

  // 換到同一週「不是今天」的另一天:請假服務人員這天沒有請假紀錄,應該恢復正常顯示,不再是
  // 灰底不可建單狀態。
  await page.getByRole("button", { name: `切換到 ${fixture.otherDateKeyInSameWeek}` }).click();
  await expect(page.getByText(fixture.staffOnLeaveName, { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    leaveColumn.getByLabel(`休假:${LEAVE_TYPE_NAME},無法預約`, { exact: true }),
  ).toHaveCount(0);
  await expect(leaveColumn.getByText("休假", { exact: false })).toHaveCount(0);
});
