// 模組 8(薪資與帳務)規格書 §7/§8 明確要求的兩支 Playwright 測試:
//   1. 店家端帳務報表(§4.3):完成一筆按件計酬訂單後,當月帳務報表正確出現對應抽成金額;
//      新增一筆月薪制服務人員的請假紀錄後,報表正確反映扣款。
//   2. 服務人員報表(§4.4,原名「師傅報表」,2026-09-24 改名):切換不同計酬類型的服務人員,報表版面正確切換顯示對應內容。
//
// fixture 資料建立/清理見 e2e/support/payroll-fixture.ts。

import { expect, test } from "@playwright/test";

import {
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
