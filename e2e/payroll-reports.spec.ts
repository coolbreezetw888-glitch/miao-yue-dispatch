// 模組 8(薪資與帳務)規格書 §7/§8 明確要求的兩支 Playwright 測試:
//   1. 店家端帳務報表(§4.3):完成一筆按件計酬訂單後,當月帳務報表正確出現對應抽成金額;
//      新增一筆月薪制服務人員的請假紀錄後,報表正確反映扣款。
//   2. 師傅報表(§4.4):切換不同計酬類型的服務人員,報表版面正確切換顯示對應內容。
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

  // 已知既有問題(跟這次修正主題無關,e2e/mobile-overflow.spec.ts 開頭同一段說明已記錄):
  // 全新瀏覽器 session 第一次深連結到受保護頁面時,有機會在 currentMerchantId 還沒被
  // context.tsx 的 fallback effect 寫進 localStorage 前,就先讀到 merchant === null 而被
  // Require*Access 誤判導回 /app。先訪問一次 /app 讓「目前操作中商家」正確寫進 localStorage。
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("店家帳務報表(§4.3):完成訂單的抽成 + 請假扣款正確反映在當月報表", async ({ page }) => {
  await page.goto("/app/billing-report");
  await expect(page.getByRole("heading", { name: "店家帳務報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 總抽成支出:完成的那筆訂單(1000 元、商家預設抽成 20%)產生 200 元抽成快照。
  await expect(page.getByText("總抽成支出")).toBeVisible();
  await expect(page.getByText(`${EXPECTED_COMMISSION_AMOUNT.toLocaleString()} 元`).first()).toBeVisible();

  // 月薪扣款合計:月薪制服務人員請了一天「事假」(full_day_rate,day_rate = 3000/30 = 100)。
  await expect(page.getByText("月薪扣款合計")).toBeVisible();
  await expect(page.getByText(`${EXPECTED_LEAVE_DEDUCTION.toLocaleString()} 元`).first()).toBeVisible();

  // 服務人員明細表格:兩位測試服務人員都應該出現,分別顯示抽成金額/月薪淨額。
  await expect(page.getByRole("cell", { name: fixture.pieceRateStaffName })).toBeVisible();
  await expect(page.getByRole("cell", { name: fixture.monthlySalaryStaffName })).toBeVisible();

  const pieceRateRow = page.locator("tr", { hasText: fixture.pieceRateStaffName });
  await expect(pieceRateRow.getByText(`${EXPECTED_COMMISSION_AMOUNT} 元(抽成)`)).toBeVisible();

  const expectedNetPay = MONTHLY_BASE_SALARY - EXPECTED_LEAVE_DEDUCTION;
  const monthlyRow = page.locator("tr", { hasText: fixture.monthlySalaryStaffName });
  await expect(monthlyRow.getByText(`${expectedNetPay} 元(淨額)`)).toBeVisible();
});

test("師傅報表(§4.4):切換不同計酬類型的服務人員,版面正確切換", async ({ page }) => {
  await page.goto("/app/staff-report");
  await expect(page.getByRole("heading", { name: "師傅報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 選按件計酬服務人員:應該看到「訂單明細」表格 + 正確的抽成金額,不應該看到「月薪基本額」。
  await page.getByLabel("服務人員").click();
  await page.getByRole("option", { name: fixture.pieceRateStaffName }).click();

  await expect(page.getByText("訂單明細")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("E2E測試客戶")).toBeVisible();
  await expect(page.getByText(`${EXPECTED_COMMISSION_AMOUNT}%`)).toHaveCount(0); // 比例欄位是 20%,不是抽成金額
  await expect(page.getByRole("cell", { name: "20%" })).toBeVisible();
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
