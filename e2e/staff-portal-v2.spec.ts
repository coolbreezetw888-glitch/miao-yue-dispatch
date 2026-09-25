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
//     按件計酬服務人員視角的「我的抽成」數字跟商家管理員視角(服務人員報表頁)的「抽成合計」一致。
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
import { getTaipeiNow, toDateKey } from "../src/modules/booking/dateUtils";

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
  const monthsDiff = ty! * 12 + (tm! - 1) - (today.getFullYear() * 12 + today.getMonth());
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
  await expect(page.getByRole("button", { name: "卡片列表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 🔴 2026-09-25(#788):fixture 的那筆訂單從「今天」改成「上個月 15 號預約、今天才完成」
  //    (跨月才能驗到報表的歸月基準,見 staff-portal-v2-fixture.ts 的說明)。
  //    所以這支測試要先把服務人員自助行事曆切到**預約發生的那個月**、再點那一天。
  //    ⚠️ 不能用 `/app/calendar?date=YYYY-MM-DD` 深連結:實查 src/modules/staff-portal/
  //       MyCalendarPage.tsx(服務人員自助版行事曆,跟商家版 CalendarPageInner 是不同元件)
  //       的 monthAnchor/selectedDateKey 都是 `useState(() => getTaipeiNow())`,**完全沒有讀
  //       searchParams**。`?date=` 只有商家版 CalendarPageInner 支援
  //       (CalendarPage.tsx:1468-1507)。這一點已實測驗證過(深連結版本會逾時找不到預約)。
  //    ⚠️ 驗證意圖完全不變:同一天的預約在「卡片列表」與「時間軸格線」兩種檢視都看得到、
  //       數量一致,點開的詳情內容一致且唯讀。改的只是「看哪一天」,不是驗什麼。
  await page.getByRole("button", { name: "← 上個月" }).click();
  await expect(
    page.getByText(`${fixture.bookingStartYear} 年 ${fixture.bookingStartMonth} 月`),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 月曆格子的無障礙名稱是「日期數字」+(有預約時)「筆數徽章」,例如 15 號有 1 筆 → 「15 1」。
  // 用 /^15\b/ 鎖住開頭,避免命中 5 號或 25 號。一個月曆格線裡「15」只會出現一次
  // (前後補的鄰月日期最多到 13 號左右)。
  await page.getByRole("button", { name: /^15\b/ }).click();
  await expect(page.getByText(`${fixture.bookingStartDateKey} 的預約`)).toBeVisible();

  // 卡片列表(v1 既有行為),那筆已完成訂單看得到。
  await expect(page.getByText("E2E測試客戶v2")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 點擊切換成時間軸格線:同一天的預約要看得到同一筆(用客戶姓名比對數量一致,這裡只有一筆)。
  await page.getByRole("button", { name: "時間軸格線" }).click();
  await expect(page.getByText("E2E測試客戶v2")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 時間軸格線正確顯示營業時間範圍(對照 fixture 設定的 09:00 開店時間)。
  await expect(page.getByText("09:00", { exact: true })).toBeVisible();

  // 時間軸格線點擊這筆預約,開啟唯讀詳情彈窗。
  await page.getByRole("button", { name: /E2E測試客戶v2/ }).click();
  await expect(page.getByRole("heading", { name: "預約詳情" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
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
  await expect(page.getByRole("heading", { name: "預約詳情" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
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
  await expect(page.getByRole("heading", { name: "休假設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
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
  // 應該是 0 格是「例外關閉」;修正後應該是全部 18 格都是「例外關閉」(含最後一格
  // 17:30-18:00,也就是原本 23:30 這格回捲問題實際影響到的邊界)。
  //
  // 2026-09-24:原本這行斷言的是格子上的「例外關閉」文字,但使用者當天明確要求拿掉這段文字
  //(原話:「不需要有文字說明,只有跨店占用需要有文字顯示說明」),CalendarPage.tsx 已改成
  // badgeText="",例外開啟/關閉只靠斜線圖樣表示。驗證意圖完全不變(整天排休後,商家管理員
  // 視角這一天 18 格都要是「例外關閉」狀態),改成斷言視覺狀態本身——CalendarPage.tsx 為此
  // 在每一格輸出 data-slot-state(見該檔案 DaySlotState 的說明),因為斜線圖樣是商家可自訂的
  // 動態 inline style(SPECS-INDEX #644),沒有穩定的 class 可以選取。
  await expect(staffColumn.locator('[data-slot-state="override-closed"]')).toHaveCount(18);
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
  await expect(page.getByRole("heading", { name: "休假設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
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
  // 2026-09-24:同上一支測試,「例外關閉」文字已依使用者要求移除,改斷言 data-slot-state。
  await expect(staffColumn.locator('[data-slot-state="override-closed"]')).toHaveCount(1);
  // 注意:aria-label 用 exact:true,否則「可預約」會被當成「不可預約」的子字串一併命中。
  await expect(staffColumn.getByLabel("可預約", { exact: true })).toHaveCount(17); // 18 格扣掉這 1 格。
  await expect(staffColumn.getByLabel("不可預約", { exact: true })).toHaveCount(1);

  await adminContext.close();

  // 恢復可預約:取消這一格的休息標記。
  await page.getByRole("button", { name: /^12:00-12:30/ }).click();
  await expect(page.getByText("已恢復為可預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: /^12:00-12:30/ })).toContainText("可預約");
});

test("10.4.6(核心情境,必測):薪資報表頁標題/區間篩選/摘要卡片,無 CSV 匯出,且與商家管理員視角抽成數字一致", async ({
  page,
  browser,
}: {
  page: import("@playwright/test").Page;
  browser: Browser;
}) => {
  await page.goto("/app/my-payroll");
  await expect(page.getByRole("heading", { name: "薪資報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 找不到 CSV 匯出按鈕。
  await expect(page.getByRole("button", { name: "匯出這份報表為 CSV" })).toHaveCount(0);

  // 2026-09-24 更新:商家端三項調整 §3.6 / 服務人員端 §15.2(已上線,git 802ab11)把這個頁面的
  // 時間篩選從「月份箭頭切換」改成 DateRangePicker 區間篩選(起訖日期或起訖月份,最長一年),
  // MyYearMonthSwitcher.tsx 已經整個移除。所以原本斷言的「YYYY 年 M 月」標籤、「下個月 →」
  // 「← 上個月」按鈕都不存在了。驗證意圖完全不變(時間篩選真的會帶動報表重新查詢:切到沒有
  // 訂單的下個月要歸零,切回來要恢復),改成操作新的區間篩選元件。
  const now = getTaipeiNow();
  const pad = (n: number) => String(n).padStart(2, "0");
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonth = `${nextMonthDate.getFullYear()}-${pad(nextMonthDate.getMonth() + 1)}`;
  const startInput = page.locator("#date-range-start");
  const endInput = page.locator("#date-range-end");

  // 預設區間(src/modules/payroll/dateRangeUtils.ts defaultDateRange):本月 1 號 ~ 今天。
  await expect(startInput).toHaveValue(`${thisMonth}-01`);

  // 按件計酬服務人員視角:三張摘要卡片,數字跟明細表格一致。
  //
  // 2026-09-24:這幾行原本是直接對「整頁」找金額文字(page.getByText("$500"))。StaffReportPage
  // 這次把「訂單明細」表格裡的金額也統一改走 formatAmount(稽核問題 4:同一頁不能一邊印 $500、
  // 一邊印原始值 500,服務人員會以為被扣錢),所以 $500 現在同時出現在摘要卡片跟明細列的抽成欄,
  // $1,000 同時出現在摘要卡片跟明細列的抽成基數欄 → page.getByText 一次命中兩個節點,
  // Playwright strict mode 判定失敗。這是格式統一造成的,不是數字算錯。
  // 驗證意圖不變(而且更精準):斷言限定在「這張摘要卡片」上,確認卡片本身顯示的是正確金額。
  const doneOrdersCard = page.locator(".rounded-xl.border", { hasText: "完成訂單" });
  const myCommissionCard = page.locator(".rounded-xl.border", { hasText: "我的抽成" });
  const totalAmountCard = page.locator(".rounded-xl.border", { hasText: "訂單總額" });

  await expect(doneOrdersCard).toBeVisible();
  await expect(doneOrdersCard).toContainText("1 筆");
  await expect(myCommissionCard).toBeVisible();
  await expect(myCommissionCard).toContainText(
    `$${EXPECTED_COMMISSION_AMOUNT.toLocaleString("zh-TW")}`,
  );
  await expect(totalAmountCard).toBeVisible();
  await expect(totalAmountCard).toContainText("$1,000");

  // 明細列的金額跟摘要卡片是同一個數字、同一種格式(稽核問題 4 的回歸保護:兩邊都要是 $500,
  // 不能一邊 $500 一邊 500)。
  await expect(page.locator("table tbody tr").first()).toContainText(
    `$${EXPECTED_COMMISSION_AMOUNT.toLocaleString("zh-TW")}`,
  );

  // 切到「按月份」顆粒度,改查下個月 → 應該是 0 筆。
  // 刻意先改「訖」再改「起」,中途不會出現「結束日期早於起始日期」這個非法中間狀態
  // (見 dateRangeUtils.validateDateRange)。
  await page.getByRole("button", { name: "按月份" }).click();
  await expect(startInput).toHaveValue(thisMonth);
  await endInput.fill(nextMonth);
  await startInput.fill(nextMonth);
  await expect(doneOrdersCard).toContainText("0 筆", { timeout: LOAD_TIMEOUT });

  // 切回這個月,資料恢復(同樣先改「起」再改「訖」,避開非法中間狀態)。
  //
  // 🔴 2026-09-25(#788):這個「1 筆」的語意在這次改動之後**變強了**,註解必須跟著改寫,
  //    否則下一個維護者會看不懂為什麼一筆**上個月**的訂單會出現在本月報表,很可能「順手修正」
  //    成錯的。
  //    fixture 的訂單現在是「上個月 15 號預約、**今天**才按下完成」。使用者 2026-09-24 的裁決是
  //    「完成代表收到錢…直到哪個月份按完成才歸在那個月」,所以它**應該**算在這個月。
  //    ⇒ 這一條現在同時在驗兩件事:①時間篩選真的會帶動重新查詢 ②歸月基準是「完成時間」。
  await startInput.fill(thisMonth);
  await endInput.fill(thisMonth);
  await expect(doneOrdersCard).toContainText("1 筆", { timeout: LOAD_TIMEOUT });

  // 🔴 #788 的反向守門員(這條才是這次改動真正的價值):切到**上個月**(訂單實際發生的月份)
  //    → 必須是 0 筆。這直接證明「訂單不是按預約月份歸月」。
  //    ⚠️ 兩個方向都要驗:只驗「上個月是 0」的話,一個「永遠回傳 0」的壞實作也會過關;
  //       上面那條「這個月是 1 筆」就是它的前提斷言。
  const lastMonth = `${fixture.bookingStartYear}-${pad(fixture.bookingStartMonth)}`;
  await startInput.fill(lastMonth);
  await endInput.fill(lastMonth);
  await expect(doneOrdersCard).toContainText("0 筆", { timeout: LOAD_TIMEOUT });

  // 再切回這個月,讓後面的跨視角斷言在「本月」的口徑下比對(也順便再證明一次不是「永遠 0」)。
  await endInput.fill(thisMonth);
  await startInput.fill(thisMonth);
  await expect(doneOrdersCard).toContainText("1 筆", { timeout: LOAD_TIMEOUT });

  // ---- 跨視角一致性:商家管理員視角(服務人員報表頁)同一位服務人員同一個月的「抽成合計」
  // 要跟服務人員自助視角的「我的抽成」完全一致,而且商家管理員視角回歸測試:CSV 匯出按鈕仍在
  // (不能因為服務人員頁面拿掉這顆按鈕就連帶波及商家管理員既有功能)。----
  //
  // ⚠️ 2026-09-25(#787)誠實標註這一段的**能力邊界**,免得之後有人誤以為它守得住基準分岔:
  //    這裡比的兩個畫面是
  //      /app/my-payroll  → MyPayrollPage  → get_staff_commission_summary_by_range
  //      /app/staff-report → StaffReportPage → get_staff_commission_summary
  //    兩支函式**同屬服務人員側、用同一個歸月基準**。所以這一段能抓到的是
  //    「單月版與區間版分岔」「頁面顯示格式分岔」,**抓不到**「服務人員側 vs 商家帳務側」
  //    的基準分岔 —— 兩邊會一起錯、一起相等、一起綠。
  //    真正的跨基準對帳在 e2e/payroll-reports.spec.ts 的第三支測試(#787)與
  //    supabase/tests/database/module8_04_...sql 的跨視角斷言(#785)。不要把這兩件事搞混。
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app");
  await adminPage.goto("/app/staff-report");
  await expect(adminPage.getByRole("heading", { name: "服務人員報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await adminPage.getByLabel("服務人員").click();
  await adminPage.getByRole("option", { name: fixture.staffName }).click();

  // 2026-09-24:商家管理員視角的「抽成合計」原本是直接印原始數字 + 「元」(`抽成合計 500 元`),
  // 這次稽核問題 4 把它也改走 formatAmount,顯示成 `抽成合計 $500`(跟同一頁的明細列、跟服務
  // 人員視角的摘要卡片格式一致)。驗證意圖不變:兩個視角的抽成數字必須是同一個值。
  await expect(
    adminPage.getByText(`抽成合計 $${EXPECTED_COMMISSION_AMOUNT.toLocaleString("zh-TW")}`, {
      exact: false,
    }),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 商家管理員視角回歸測試(必測):CSV 匯出按鈕仍然存在,沒有被連帶拿掉。
  await expect(adminPage.getByRole("button", { name: "匯出這份報表為 CSV" })).toBeVisible();

  await adminContext.close();
});
