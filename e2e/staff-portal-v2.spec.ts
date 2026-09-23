// 模組 14(服務人員端)v2 規格書第十二節要求的 Playwright「核心情境,必測」測試,上一輪
// (git log 25b2402)只更新了既有測試的 fixture,沒有新增任何 v2 功能本身的自動化 e2e 測試——
// 這次品管驗收(SPECS-INDEX 編號 484/485)補上:
//
//   10.2.4(核心情境,必測):行事曆「卡片列表」/「時間軸格線」兩種檢視切換,同一天預約數量
//     一致,點擊任一筆預約彈出的詳情內容一致、都只有「關閉」按鈕,沒有任何可以修改資料的按鈕。
//   10.3.2/§485(核心必測,品管打回重做修正):服務人員標記/取消「整天排休」,計數正確,而且
//     商家管理員視角的既有行事曆正確反映這筆整天休假(格線顯示「例外關閉」,不是可預約)——
//     這是這次品管抓到的真實 bug(get_merchant_day_schedule 的 24:00 跨日回捲),必須有自動化
//     測試網住,不能只靠人工驗證。
//   10.3.3:「時段排休」依商家實際營業時間顯示時段列表,切換單一半小時休息,商家管理員視角能
//     看到同樣的「例外關閉」樣式(交叉驗證同一份底層資料)。
//   10.4.6(核心情境,必測):薪資報表頁標題/月份箭頭切換/摘要卡片,且找不到 CSV 匯出按鈕,
//     按件計酬服務人員視角的「我的抽成」數字跟商家管理員視角(師傅報表頁)的「抽成合計」一致。
//
// fixture 資料建立/清理見 e2e/support/staff-portal-v2-fixture.ts。
import { expect, test, type Browser } from "@playwright/test";

import {
  EXPECTED_COMMISSION_AMOUNT,
  injectAdminSession,
  injectStaffSession,
  setupStaffPortalV2Fixture,
  teardownStaffPortalV2Fixture,
  type StaffPortalV2Fixture,
} from "./support/staff-portal-v2-fixture";
import { addDays, getTaipeiNow, toDateKey } from "../src/modules/booking/dateUtils";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: StaffPortalV2Fixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupStaffPortalV2Fixture();
  } catch (err) {
    setupFailed = true;
    console.error("[staff-portal-v2] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownStaffPortalV2Fixture(fixture);
  console.log("[staff-portal-v2] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

/** 兩個分頁籤各自的月曆都預設從「這次測試實際執行當下」的當月開始(見 DayOffTabsSection.tsx
 * WholeDayOffTab/BySlotOffTab 各自的 useState(() => startOfMonth(getTaipeiNow()))),
 * fixture 的目標日期(今天 +10/+11 天)有機會跨到下個月——這裡在測試執行當下動態算出需要點擊
 * 「下個月 →」幾次,不寫死假設「一定跟今天同一個月」,確保這支測試不管哪一天執行都不會因為
 * 月份邊界而失敗。 */
async function navigateMonthForward(page: import("@playwright/test").Page, targetDateKey: string) {
  const today = getTaipeiNow();
  const [ty, tm] = targetDateKey.split("-").map(Number);
  const monthsDiff = (ty! * 12 + (tm! - 1)) - (today.getFullYear() * 12 + today.getMonth());
  for (let i = 0; i < monthsDiff; i++) {
    await page.getByRole("button", { name: "下個月 →" }).click();
  }
}

test.beforeEach(async ({ page }) => {
  await injectStaffSession(page, fixture);
  // 已知既有問題(跟這次修正主題無關,e2e/mobile-overflow.spec.ts / staff-portal.spec.ts 開頭
  // 已記錄):全新瀏覽器 session 第一次深連結到受保護頁面時,有機會在 currentMerchantId 還沒被
  // context.tsx 的 fallback effect 寫進 localStorage 前就被誤判。先訪問一次 /app。
  await page.goto("/app");
});

test("10.2.4(核心情境,必測):行事曆卡片列表/時間軸格線兩種檢視數量一致,詳情內容一致且唯讀", async ({
  page,
}) => {
  await page.goto("/app/calendar");
  await expect(page.getByRole("button", { name: "卡片列表" })).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 預設看到卡片列表(v1 既有行為),今天這筆已完成訂單看得到。
  await expect(page.getByText("E2E測試客戶v2")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 點擊切換成時間軸格線:同一天的預約要看得到同一筆(用客戶姓名比對數量一致,這裡只有一筆)。
  await page.getByRole("button", { name: "時間軸格線" }).click();
  await expect(page.getByText("E2E測試客戶v2")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 時間軸格線正確顯示營業時間範圍(對照 fixture 設定的 09:00 開店時間)。
  await expect(page.getByText("09:00", { exact: true })).toBeVisible();

  // 時間軸格線點擊這筆預約,開啟唯讀詳情彈窗。
  await page.getByRole("button", { name: /E2E測試客戶v2/ }).click();
  await expect(page.getByRole("heading", { name: "預約詳情" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("已完成")).toBeVisible();
  await expect(page.getByText("$1,000")).toBeVisible();
  // 唯讀:沒有任何可以修改資料的按鈕。
  for (const forbidden of ["確認", "完成", "取消預約", "編輯", "相關訂單"]) {
    await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "關閉" }).click();
  await expect(page.getByRole("heading", { name: "預約詳情" })).toHaveCount(0);

  // 切回卡片列表,點擊同一筆,詳情內容一致。
  await page.getByRole("button", { name: "卡片列表" }).click();
  await page.getByText("E2E測試客戶v2").first().click();
  await expect(page.getByRole("heading", { name: "預約詳情" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("已完成")).toBeVisible();
  await expect(page.getByText("$1,000")).toBeVisible();
  for (const forbidden of ["確認", "完成", "取消預約", "編輯", "相關訂單"]) {
    await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "關閉" }).click();
});

test("10.3.2 + SPECS-INDEX 編號 485(核心必測,品管打回重做修正):整天排休標記/取消,商家管理員視角正確顯示「例外關閉」", async ({
  page,
  browser,
}: {
  page: import("@playwright/test").Page;
  browser: Browser;
}) => {
  await page.goto("/app/my-availability");
  await expect(page.getByRole("heading", { name: "休假設定" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 「整天排休」是預設分頁籤。
  await expect(page.getByRole("tab", { name: "整天排休" })).toBeVisible();

  await navigateMonthForward(page, fixture.wholeDayOffDateKey);

  const dayCell = page.getByTestId(`day-off-cell-${fixture.wholeDayOffDateKey}`);
  await expect(dayCell).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dayCell.click();

  await expect(page.getByText("已將這天標記為整天休假")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("本月已排休 1 天")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 標記後這一天要變成橘色系高亮(warn 色階,見 DayOffTabsSection.tsx isHighlighted 分支)。
  await expect(dayCell).toHaveClass(/border-warn/);

  // ---- 品管打回重做的核心情境:切到商家管理員視角,確認同一天正確顯示「例外關閉」。----
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app");
  await adminPage.goto(`/app/calendar?date=${fixture.wholeDayOffDateKey}`);
  // SPECS-INDEX #640:行事曆預設改成先顯示月檢視,這裡要測的是週檢視底下的服務人員時間軸,
  // 先手動切回週檢視,不能再假設進頁面時預設就是週檢視。
  await adminPage.getByRole("button", { name: "週檢視" }).click();
  await expect(adminPage.getByText(fixture.staffName, { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const staffColumn = adminPage.getByTestId(`staff-column-${fixture.staffId}`);
  await expect(staffColumn).toBeVisible({ timeout: LOAD_TIMEOUT });

  // fixture 營業時間 09:00-18:00 = 18 個半小時格,修正前的 bug 會讓 availability_overrides
  // 合併結果變成 start=00:00/end=00:00(零寬度區間),前端比對邏輯永遠比對不到任何一格,這裡
  // 應該是 0 格顯示「例外關閉」;修正後應該是全部 18 格都顯示「例外關閉」(含最後一格
  // 17:30-18:00,也就是原本 23:30 這格回捲問題實際影響到的邊界)。
  await expect(staffColumn.getByText("例外關閉", { exact: true })).toHaveCount(18);
  // 對照組:商家管理員視角完全看不到「新增預約」這個選項——打開其中一格的下拉選單確認。
  await staffColumn.getByRole("button", { name: "不可預約" }).first().click();
  await expect(adminPage.getByRole("menuitem", { name: "新增預約" })).toHaveCount(0);
  await expect(adminPage.getByRole("menuitem", { name: "開啟時段" })).toBeVisible();
  await adminPage.keyboard.press("Escape");

  await adminContext.close();

  // 取消整天排休:計數歸零、恢復原色。
  await dayCell.click();
  await expect(page.getByText("已取消這天的休假")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("本月已排休 0 天")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dayCell).not.toHaveClass(/border-warn/);
});

test("10.3.3:時段排休依營業時間顯示,商家管理員視角看到一致的「例外關閉」樣式(不影響其他時段)", async ({
  page,
  browser,
}: {
  page: import("@playwright/test").Page;
  browser: Browser;
}) => {
  await page.goto("/app/my-availability");
  await expect(page.getByRole("heading", { name: "休假設定" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("tab", { name: "時段排休" }).click();

  await navigateMonthForward(page, fixture.slotOffDateKey);
  await page.getByTestId(`day-off-cell-${fixture.slotOffDateKey}`).click();

  // 依 fixture 營業時間(09:00-18:00)顯示半小時時間軸列表,不是寫死的固定範圍。
  await expect(page.getByText("09:00-09:30")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("17:30-18:00")).toBeVisible();

  // 標記 12:00-12:30 這一格為休息。
  const targetSlotButton = page.getByRole("button", { name: /^12:00-12:30/ });
  await expect(targetSlotButton).toBeVisible();
  await targetSlotButton.click();
  await expect(page.getByText("已標記為休息")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: /^12:00-12:30/ })).toContainText("休息");
  // 相鄰時段不受影響,仍是可預約。
  await expect(page.getByRole("button", { name: /^11:30-12:00/ })).toContainText("可預約");
  await expect(page.getByRole("button", { name: /^12:30-13:00/ })).toContainText("可預約");

  // ---- 跨視角一致性:商家管理員視角同一天同一格要顯示「例外關閉」,其他格維持可預約。----
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app");
  await adminPage.goto(`/app/calendar?date=${fixture.slotOffDateKey}`);
  // SPECS-INDEX #640:行事曆預設改成先顯示月檢視,這裡要測的是週檢視底下的服務人員時間軸,
  // 先手動切回週檢視,不能再假設進頁面時預設就是週檢視。
  await adminPage.getByRole("button", { name: "週檢視" }).click();
  const staffColumn = adminPage.getByTestId(`staff-column-${fixture.staffId}`);
  await expect(staffColumn).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 只有這一格是「例外關閉」,不是整天(跟 485 那支整天排休測試明確區分開)。
  await expect(staffColumn.getByText("例外關閉", { exact: true })).toHaveCount(1);
  // 注意:aria-label 用 exact:true,否則「可預約」會被當成「不可預約」的子字串一併命中。
  await expect(staffColumn.getByLabel("可預約", { exact: true })).toHaveCount(17); // 18 格扣掉這 1 格。
  await expect(staffColumn.getByLabel("不可預約", { exact: true })).toHaveCount(1);

  await adminContext.close();

  // 恢復可預約:取消這一格的休息標記。
  await page.getByRole("button", { name: /^12:00-12:30/ }).click();
  await expect(page.getByText("已恢復為可預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: /^12:00-12:30/ })).toContainText("可預約");
});

test("10.4.6(核心情境,必測):薪資報表頁標題/月份切換/摘要卡片,無 CSV 匯出,且與商家管理員視角抽成數字一致", async ({
  page,
  browser,
}: {
  page: import("@playwright/test").Page;
  browser: Browser;
}) => {
  await page.goto("/app/my-payroll");
  await expect(page.getByRole("heading", { name: "薪資報表" })).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 找不到 CSV 匯出按鈕。
  await expect(page.getByRole("button", { name: "匯出這份報表為 CSV" })).toHaveCount(0);

  // 月份箭頭切換(這個月->下個月->回這個月),報表資料同步更新——下個月沒有訂單,摘要卡片歸零。
  const now = getTaipeiNow();
  const thisMonthLabel = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  await expect(page.getByText(thisMonthLabel, { exact: true })).toBeVisible();

  // 按件計酬服務人員視角:三張摘要卡片,數字跟明細表格一致。
  await expect(page.getByText("完成訂單")).toBeVisible();
  await expect(page.getByText("1 筆", { exact: true })).toBeVisible();
  await expect(page.getByText("我的抽成")).toBeVisible();
  await expect(page.getByText(`$${EXPECTED_COMMISSION_AMOUNT.toLocaleString("zh-TW")}`)).toBeVisible();
  await expect(page.getByText("訂單總額")).toBeVisible();
  await expect(page.getByText("$1,000")).toBeVisible();

  await page.getByRole("button", { name: "下個月 →" }).click();
  const nextMonthDate = addDays(new Date(now.getFullYear(), now.getMonth() + 1, 1), 0);
  const nextMonthLabel = `${nextMonthDate.getFullYear()} 年 ${nextMonthDate.getMonth() + 1} 月`;
  await expect(page.getByText(nextMonthLabel, { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("0 筆", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: "← 上個月" }).click();
  await expect(page.getByText(thisMonthLabel, { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });

  // ---- 跨視角一致性:商家管理員視角(師傅報表頁)同一位服務人員同一個月的「抽成合計」
  // 要跟服務人員自助視角的「我的抽成」完全一致,而且商家管理員視角回歸測試:CSV 匯出按鈕仍在
  // (不能因為服務人員頁面拿掉這顆按鈕就連帶波及商家管理員既有功能)。----
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app");
  await adminPage.goto("/app/staff-report");
  await expect(adminPage.getByRole("heading", { name: "師傅報表" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await adminPage.getByLabel("服務人員").click();
  await adminPage.getByRole("option", { name: fixture.staffName }).click();

  await expect(
    adminPage.getByText(`抽成合計 ${EXPECTED_COMMISSION_AMOUNT} 元`, { exact: false }),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 商家管理員視角回歸測試(必測):CSV 匯出按鈕仍然存在,沒有被連帶拿掉。
  await expect(adminPage.getByRole("button", { name: "匯出這份報表為 CSV" })).toBeVisible();

  await adminContext.close();
});
