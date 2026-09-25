// 模組 8(薪資與帳務)規格書 §7/§8 明確要求的兩支 Playwright 測試:
//   1. 店家端帳務報表(§4.3):完成一筆按件計酬訂單後,當月帳務報表正確出現對應抽成金額;
//      新增一筆月薪制服務人員的請假紀錄後,報表正確反映扣款。
//   2. 服務人員報表(§4.4,原名「師傅報表」,2026-09-24 改名):切換不同計酬類型的服務人員,報表版面正確切換顯示對應內容。
//
// fixture 資料建立/清理見 e2e/support/payroll-fixture.ts。

import { expect, test } from "@playwright/test";

import {
  COMPLETION_MONTH,
  COMPLETION_YEAR,
  EXPECTED_COMMISSION_AMOUNT,
  EXPECTED_LEAVE_DEDUCTION,
  MONTHLY_BASE_SALARY,
  injectPayrollFixtureSession,
  setupPayrollFixture,
  teardownPayrollFixture,
  type PayrollFixture,
} from "./support/payroll-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: PayrollFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupPayrollFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[payroll-reports] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownPayrollFixture(fixture);
  console.log("[payroll-reports] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectPayrollFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 Require*Access 守衛誤判導回 /app。為什麼是這個頁面/這個錨點,見
  // e2e/support/app-shell.ts 的完整說明。
  await primeCurrentMerchant(page);
});

test("店家帳務報表(§4.3):完成訂單的抽成 + 請假扣款正確反映在當月報表", async ({ page }) => {
  await page.goto("/app/billing-report");
  // 2026-09-24:這個頁面的標題在 2026-09-23 的後台導覽大改版(git 3b51310)裡從
  // 「店家帳務報表」改名成「店家報表」(BillingReportPage.tsx:66),測試沒跟著改。
  // 之前整檔的 beforeEach 啟動斷言先逾時,把這個過時的斷言蓋住了,所以一直沒被發現。
  // 驗證意圖不變:進得了 /app/billing-report 且頁面標題正確渲染。
  await expect(page.getByRole("heading", { name: "店家報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 2026-09-24:原本這幾行是 getByText("總抽成支出") + getByText("200 元").first(),兩個問題:
  //   ① 「商家總淨利」卡片的說明文字整句就是「總營收(未稅)− 總料錢成本 − 總抽成支出 −
  //      (月薪基本額合計 − 月薪扣款合計)…」,把「總抽成支出」「月薪扣款合計」這兩個標籤各多
  //      命中一次 → Playwright strict mode 判定失敗(這段說明文字是既有功能,不是今晚新增的;
  //      之前整檔 beforeEach 先逾時,所以這個問題一直沒浮出來)。
  //   ② 金額用 .first() 對整頁比對,沒有跟標籤綁在一起,「200 元」出現在別張卡片也會過關。
  // 改成直接鎖定那一張統計卡(卡片文字 = 標籤 + 金額),標籤跟金額一次驗完,比原本更嚴格。
  const summaryCard = (label: string) =>
    page.locator(".rounded-xl.border").filter({ hasText: new RegExp(`^${label}`) });

  // 總抽成支出:完成的那筆訂單(1000 元、商家預設抽成 20%)產生 200 元抽成快照。
  await expect(summaryCard("總抽成支出")).toContainText(
    `${EXPECTED_COMMISSION_AMOUNT.toLocaleString()} 元`,
  );

  // 月薪扣款合計:月薪制服務人員請了一天「事假」(full_day_rate,day_rate = 3000/30 = 100)。
  await expect(summaryCard("月薪扣款合計")).toContainText(
    `${EXPECTED_LEAVE_DEDUCTION.toLocaleString()} 元`,
  );

  // 服務人員明細表格:兩位測試服務人員都應該出現,分別顯示抽成金額/月薪淨額。
  await expect(page.getByRole("cell", { name: fixture.pieceRateStaffName })).toBeVisible();
  await expect(page.getByRole("cell", { name: fixture.monthlySalaryStaffName })).toBeVisible();

  const pieceRateRow = page.locator("tr", { hasText: fixture.pieceRateStaffName });
  await expect(pieceRateRow.getByText(`${EXPECTED_COMMISSION_AMOUNT} 元(抽成)`)).toBeVisible();

  const expectedNetPay = MONTHLY_BASE_SALARY - EXPECTED_LEAVE_DEDUCTION;
  const monthlyRow = page.locator("tr", { hasText: fixture.monthlySalaryStaffName });
  await expect(monthlyRow.getByText(`${expectedNetPay} 元(淨額)`)).toBeVisible();
});

test("服務人員報表(§4.4):切換不同計酬類型的服務人員,版面正確切換", async ({ page }) => {
  await page.goto("/app/staff-report");
  await expect(page.getByRole("heading", { name: "服務人員報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 選按件計酬服務人員:應該看到「訂單明細」表格 + 正確的抽成金額,不應該看到「月薪基本額」。
  await page.getByLabel("服務人員").click();
  await page.getByRole("option", { name: fixture.pieceRateStaffName }).click();

  await expect(page.getByText("訂單明細")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("E2E測試客戶")).toBeVisible();
  await expect(page.getByText(`${EXPECTED_COMMISSION_AMOUNT}%`)).toHaveCount(0); // 200% 不該出現(抽成金額不是比例)
  // 2026-09-24:抽成比例原本是訂單明細表格的一個欄位(所以舊斷言找的是 cell "20%")。
  // 「服務項目層級抽成」改版(git 8464efd)之後,表格欄位變成
  // 日期/客戶/抽成基準/抽成金額/明細,比例搬進「展開」後的逐項明細裡
  // (StaffReportPage.tsx:246-277,percentage 模式顯示「服務項目 × 數量(20%)」;
  // 舊制紀錄則顯示「這筆是改版前的舊制紀錄,抽成比例 20%」)。
  // 這支測試之前一直排在失敗的第一支測試後面沒被執行到(serial 模式),所以沒人發現它過時。
  // 驗證意圖不變:按件計酬視角看得到 20% 這個抽成比例,而不是把抽成金額誤當成比例。
  await page.getByRole("button", { name: "展開" }).first().click();
  await expect(page.locator("table")).toContainText("20%");
  await expect(page.getByText("月薪基本額")).toHaveCount(0);

  // 切換成月薪制服務人員:版面應該換成「月薪基本額/總扣款/實發淨額」+「假別扣款明細」,
  // 不應該再看到「訂單明細」表格。
  await page.getByLabel("服務人員").click();
  await page.getByRole("option", { name: fixture.monthlySalaryStaffName }).click();

  await expect(page.getByText("月薪基本額")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("假別扣款明細")).toBeVisible();
  await expect(page.getByText("訂單明細")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "事假" })).toBeVisible();

  const expectedNetPay = MONTHLY_BASE_SALARY - EXPECTED_LEAVE_DEDUCTION;
  await expect(page.getByText(`${expectedNetPay} 元`).first()).toBeVisible();
});

// =============================================================================
// #787(SPECS-INDEX,規格書 .project/specs/服務人員報表歸月基準修正.md):
// 真正的「商家帳務報表 ↔ 服務人員報表」**跨基準**對帳。
//
// 🔴 為什麼需要這一支,以及為什麼它看起來「跟別的測試都對同一個常數斷言、好像重複了」:
//
//    這條測試的價值**不在**那個常數,而在於「**兩個畫面、兩支不同的資料庫函式、同一個月份、
//    同一個數字**」:
//      /app/billing-report → BillingReportPage → get_merchant_billing_summary_by_range
//                            (抽成基準:booking_commission_records.computed_at)
//      /app/staff-report   → StaffReportPage   → get_staff_commission_summary
//                            (抽成基準:2026-09-25 之前是 bookings.start_at → 這就是 #767 的 bug)
//
//    2026-09-25 之前,repo 裡**沒有任何一條測試**在守這兩側的一致性:
//    staff-portal-v2.spec.ts 那條「跨視角一致」比的是 /app/my-payroll 與 /app/staff-report,
//    **兩頁呼叫的是同一組服務人員側函式**,所以它在結構上永遠不可能抓到基準分岔 ——
//    兩邊會一起錯、一起相等、一起綠。這正是 #767 能一路漏到今天的原因。
//
//    ⇒ **請不要因為「都對 EXPECTED_COMMISSION_AMOUNT 斷言、重複了」而刪掉這支測試。**
//      它是唯一一條會在「服務人員側與商家帳務側用不同歸月基準」時變紅的 e2e。
//      (資料庫層的對應守門員是 supabase/tests/database/module8_04_...sql 的跨視角斷言。)
//
// fixture 是「上個月 15 號預約、今天才按下完成」(#786),所以兩側都必須把這筆錢認在**這個月**。
// =============================================================================
test("#787(核心守門員):商家帳務報表 ↔ 服務人員報表,同一個月同一位服務人員的抽成金額必須一致", async ({
  page,
}) => {
  await page.goto("/app/billing-report");
  await expect(page.getByRole("heading", { name: "店家報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 前提 1:人員明細表格真的有列。
  // 🔴 不先證明表格非空,下面「找得到某一列」「那一列顯示某個金額」的斷言在空表格上會變成
  //    「0 個節點」,某些寫法(toHaveCount(0) 型)會直接假通過。BillingReportPage 全頁只有
  //    這一張 <Table>(實查),所以 `table tbody tr` 就是人員明細列。
  const staffRows = page.locator("table tbody tr");
  await expect(staffRows.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(await staffRows.count()).toBeGreaterThan(0);

  // 前提 2:找得到按件計酬那位服務人員的那一列。
  const pieceRateRow = page.locator("tr", { hasText: fixture.pieceRateStaffName });
  await expect(pieceRateRow).toHaveCount(1);

  // 行為 1:商家帳務報表上,這一列顯示的抽成金額(這一側的基準是 bcr.computed_at)。
  await expect(pieceRateRow.getByText(`${EXPECTED_COMMISSION_AMOUNT} 元(抽成)`)).toBeVisible();

  // 行為 2:🔴 **點那一列真正的「查看明細 →」連結**進到服務人員報表,不要自己組 URL ——
  //         走使用者真的會走的路徑(BillingReportPage 的
  //         <Link to="/app/staff-report?staffId=…&year=…&month=…">),
  //         這樣連帶驗到 staffId / year / month 三個參數有正確傳遞。
  //         使用者最可能親眼撞見 #767 的就是這條路徑:
  //         「帳務報表說這位師傅本月抽成 200 元」→ 點下去 →「這個月沒有已完成的訂單」。
  await pieceRateRow.getByRole("link", { name: "查看明細 →" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/app/staff-report\\?staffId=${fixture.pieceRateStaffId}&year=${COMPLETION_YEAR}&month=${COMPLETION_MONTH}$`,
    ),
  );
  await expect(page.getByRole("heading", { name: "服務人員報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 前提 3:服務人員報表的訂單明細表格真的有列(同樣防「空清單假通過」)。
  //         這一條就是 #767 那個 bug 的第一個落點:舊基準下這裡會是
  //         「這個月沒有已完成的訂單。」,整張表格連 tbody 都不存在。
  const detailRows = page.locator("table tbody tr");
  await expect(detailRows.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(await detailRows.count()).toBeGreaterThan(0);

  // 行為 3:🔴 對帳本身 —— 服務人員報表的「抽成合計」必須等於剛剛在帳務報表看到的那個數字。
  //         (兩邊的顯示格式不同:帳務報表是「200 元(抽成)」,服務人員報表走 formatAmount
  //          顯示成「抽成合計 $200」;比對的是同一個數值。)
  await expect(
    page.getByText(`抽成合計 $${EXPECTED_COMMISSION_AMOUNT.toLocaleString("zh-TW")}`, {
      exact: false,
    }),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 附帶(#781):明細表格的日期欄位標題是「完成日期」,不是「日期」——讓讀報表的人自己就看得懂
  // 這份報表的認列口徑,這也是 #782 決定「不加說明橫幅」的替代做法。
  await expect(page.getByRole("columnheader", { name: "完成日期" })).toBeVisible();
});
