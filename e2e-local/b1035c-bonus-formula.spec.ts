// #1035 彈性計薪 C 批(自由公式)本機 e2e。
// 規格書:母版 .project/specs/彈性計薪.md 第七節 PT e2e-local(C)、第八節 PJ-02 截圖(C)。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
// fixture 沿用 A 批(bonus-1035a-fixture):月薪人員 M 今天完成 13 單、14 份(冷氣 13 台 + 水管 1 份)。
//   C1 規則選「自訂公式（進階）」→ 打錯公式 ⇒ 紅字含位置、存檔按鈕擋住並說第幾條
//   C2 用「插入欄位」改正(游標位置)⇒「公式可以使用」;範例數字試算;實際數字試算;除以 0 旗標
//   C3 存檔 → 指派 → 店家報表月薪獎金 = 試算金額;服務人員報表只顯示「依自訂公式計算」、不顯示公式原文
//   C4 手機 375 寬:公式編輯器不爆版
//   C5 開公式編輯器、服務選單、兩種試算、兩條公式:console 沒有 React「same key」錯誤
// 截圖存 test-results/req1035c-shots(1280 / 375)。
import { mkdirSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  clientAs,
  injectSession,
  setupBonus1035aFixture,
  teardownBonus1035aFixture,
  type Bonus1035aFixture,
} from "./support/bonus-1035a-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/req1035c-shots";
const PLAN_NAME = "E2E公式組";
const FORMULA = "MAX(完成數量 - 10, 0) * 300";

test.describe.configure({ mode: "serial" });

let fixture: Bonus1035aFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupBonus1035aFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonus1035aFixture(fixture);
  console.log("[彈性計薪 C 批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function openAsAdmin(page: Page, path: string) {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(path);
}

async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function monthSummary() {
  const now = new Date(Date.now() + 8 * 3600_000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  const r = await clientAs(fixture.adminSession).rpc("get_merchant_billing_summary_by_range", {
    p_merchant_id: fixture.merchantId,
    p_start_date: `${y}-${mm}-01`,
    p_end_date: `${y}-${mm}-${String(last).padStart(2, "0")}`,
  });
  if (r.error) throw new Error(r.error.message);
  return r.data as Record<string, number | null>;
}

/** 新增方案的編輯器,第 1 條規則切成自訂公式。 */
async function openFormulaEditor(page: Page): Promise<{ editor: Locator; card: Locator }> {
  const section = page.getByTestId("bonus-plan-section");
  await expect(section).toBeVisible({ timeout: LOAD_TIMEOUT });
  await section.getByTestId("bonus-plan-new").first().click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText("新增獎金方案")).toBeVisible();
  await editor.getByLabel("方案名稱").fill(PLAN_NAME);
  const card = editor.getByTestId("bonus-rule-card").nth(0);
  await card.getByRole("radio", { name: "自訂公式（進階）" }).click();
  await expect(card.getByTestId("bonus-formula-fields")).toBeVisible();
  return { editor, card };
}

test("C1 打錯公式 ⇒ 紅字含位置、存檔按鈕擋住", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const { editor, card } = await openFormulaEditor(page);

  await card.getByTestId("bonus-formula-input").fill("完成台數 * 3");
  await expect(card.getByText("第 1 個字附近：不認識「完成台數」", { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(editor.getByTestId("bonus-plan-save-blocker")).toContainText(
    "第 1 條規則的公式有錯誤，修正後才能存檔。",
  );
  await expect(editor.getByTestId("bonus-plan-save")).toBeDisabled();
  await shot(page, "01_formula_error_1280", false);

  await card.getByTestId("bonus-formula-input").fill("5%");
  await expect(card.getByText("5% 請寫成 0.05", { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await editor.getByRole("button", { name: "取消" }).click();
  expectOnlyLocalRequests(recorder);
});

test("C2 插入欄位改正 ⇒ 可以使用;範例 / 實際數字試算;除以 0 旗標;存檔", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const { editor, card } = await openFormulaEditor(page);
  const input = card.getByTestId("bonus-formula-input");

  // 用「MAX( , )」按鈕插入,游標停在第一個參數 ⇒ 接著打字就進到括號裡。
  await input.fill("");
  await card.getByRole("button", { name: "MAX( , )" }).click();
  await expect(input).toHaveValue("MAX(, )");
  await page.keyboard.type("完成數量 - 10");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("0");
  await page.keyboard.press("End");
  await page.keyboard.type(" * 300");
  await expect(input).toHaveValue(FORMULA);
  await expect(card.getByTestId("bonus-formula-ok")).toHaveText("✓ 公式可以使用", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(editor.getByTestId("bonus-plan-save")).toBeEnabled();

  // 範例數字:完成數量 15 ⇒ (15 − 10) × 300 = 1,500
  const tester = card.getByTestId("bonus-formula-tester");
  await tester.getByLabel("完成數量").fill("15");
  await expect(tester.getByTestId("bonus-formula-result")).toContainText("1,500 元", {
    timeout: LOAD_TIMEOUT,
  });
  await shot(page, "02_formula_ok_sample_1280", false);

  // 實際數字:M 本月 14 份 ⇒ 1,200
  await tester.getByRole("radio", { name: "用月薪人員的實際數字" }).click();
  await expect(tester.getByTestId("bonus-formula-result")).toContainText("1,200 元", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(tester.getByTestId("bonus-formula-result")).toContainText("完成數量 14");
  // 方案層級的試算(preview_staff_bonus)也一樣
  await expect(editor.getByTestId("bonus-preview-result")).toContainText("1,200 元", {
    timeout: LOAD_TIMEOUT,
  });

  // 第 2 條:除以 0(完成單數 13 − 13 = 0)⇒ 該處 0 + 旗標說明
  await editor.getByTestId("bonus-rule-add").click();
  const second = editor.getByTestId("bonus-rule-card").nth(1);
  await second.getByRole("radio", { name: "自訂公式（進階）" }).click();
  await second.getByTestId("bonus-formula-input").fill("業績 / (完成單數 - 13) + 100");
  await expect(second.getByTestId("bonus-formula-ok")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const tester2 = second.getByTestId("bonus-formula-tester");
  await tester2.getByRole("radio", { name: "用月薪人員的實際數字" }).click();
  await expect(tester2.getByTestId("bonus-formula-result")).toContainText("100 元", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(tester2).toContainText("公式中有除以 0 的情況，該處以 0 計算。");
  await tester2.scrollIntoViewIfNeeded();
  await shot(page, "03_formula_div0_1280", false);
  await second.getByRole("button", { name: "刪除第 2 條" }).click();
  await expect(editor.getByTestId("bonus-rule-card")).toHaveCount(1);

  await editor.getByTestId("bonus-plan-save").click();
  await expect(page.getByText("已建立獎金方案").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("bonus-plan-list")).toContainText(PLAN_NAME);
  expectOnlyLocalRequests(recorder);
});

test("C3 指派 → 店家報表月薪獎金 = 試算 1,200;服務人員報表不顯示公式原文", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const select = page.locator(`#staff-bonus-plan-${fixture.staffId}`);
  await expect(select).toBeVisible({ timeout: LOAD_TIMEOUT });
  await select.click();
  await page.getByRole("option", { name: PLAN_NAME }).click();
  await expect(select).toContainText(PLAN_NAME, { timeout: LOAD_TIMEOUT });

  const s = await monthSummary();
  expect(Number(s["total_monthly_bonus"])).toBe(1200);

  await page.goto("/app/billing-report");
  const card = page.getByText("月薪獎金", { exact: true }).locator("xpath=../..");
  await expect(page.getByText("月薪獎金", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("1,200 元");

  await page.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  const details = page.getByTestId("staff-bonus-details");
  await expect(details).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(details).toContainText("依自訂公式計算");
  await expect(details).toContainText("1,200 元");
  await expect(details).not.toContainText("MAX(");
  await shot(page, "04_staff_report_formula_1280");
  expectOnlyLocalRequests(recorder);
});

test("C4 手機 375 寬:公式編輯器不爆版", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/payroll-settings");
  const list = page.getByTestId("bonus-plan-list");
  await expect(list).toContainText(PLAN_NAME, { timeout: LOAD_TIMEOUT });
  await list.getByRole("button", { name: "編輯" }).click();
  const editor = page.getByRole("dialog");
  const card = editor.getByTestId("bonus-rule-card").nth(0);
  await expect(card.getByTestId("bonus-formula-input")).toHaveValue(FORMULA);
  await expect(card.getByTestId("bonus-formula-ok")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await card.getByTestId("bonus-formula-input").fill("完成台數 * 3");
  await expect(card.getByText("不認識「完成台數」", { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await noHorizontalOverflow(page);
  await shot(page, "05_formula_error_375", false);
  await card.getByTestId("bonus-formula-input").fill(FORMULA);
  await expect(card.getByTestId("bonus-formula-ok")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await card.getByTestId("bonus-formula-tester").getByLabel("完成數量").fill("15");
  await expect(card.getByTestId("bonus-formula-result")).toContainText("1,500 元", {
    timeout: LOAD_TIMEOUT,
  });
  await card.getByTestId("bonus-formula-tester").scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await shot(page, "06_formula_ok_375", false);
  expectOnlyLocalRequests(recorder);
  await page.close();
});

test("C5 開公式編輯器、服務選單、兩種試算:console 沒有 React「same key」錯誤", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") consoleErrors.push(msg.text());
  });
  await openAsAdmin(page, "/app/payroll-settings");
  const list = page.getByTestId("bonus-plan-list");
  await expect(list).toContainText(PLAN_NAME, { timeout: LOAD_TIMEOUT });
  await list.getByRole("button", { name: "編輯" }).click();
  const editor = page.getByRole("dialog");
  const card = editor.getByTestId("bonus-rule-card").nth(0);
  await expect(card.getByTestId("bonus-formula-ok")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await card.getByRole("button", { name: '數量("")' }).click();
  await expect(card.getByTestId("bonus-formula-service-picker")).toBeVisible();
  await card.getByRole("button", { name: '業績("")' }).click();
  await expect(card.getByTestId("bonus-formula-service-picker")).toBeVisible();
  const tester = card.getByTestId("bonus-formula-tester");
  await tester.getByRole("radio", { name: "用月薪人員的實際數字" }).click();
  await expect(tester.getByTestId("bonus-formula-result")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await tester.getByRole("radio", { name: "用範例數字" }).click();
  await editor.getByTestId("bonus-rule-add").click();
  await editor
    .getByTestId("bonus-rule-card")
    .nth(1)
    .getByRole("radio", { name: "自訂公式（進階）" })
    .click();
  await expect(editor.getByTestId("bonus-formula-fields")).toHaveCount(2);
  await editor.getByRole("button", { name: "取消" }).click();
  const discard = page.getByRole("button", { name: /放棄/ });
  if (await discard.count()) await discard.first().click();
  await expect(editor).toHaveCount(0);

  expect(consoleErrors.filter((t) => /same key/i.test(t))).toEqual([]);
  expectOnlyLocalRequests(recorder);
});
