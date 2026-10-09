// #1035 彈性計薪 B 批(日薪／時薪制)本機 e2e。
// 規格書:母版 .project/specs/彈性計薪.md 第七節 PT e2e-local(B)、第八節 PJ-02 截圖。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
// fixture:服務人員 H(一開始抽成制),每週時段每天 10:00~12:00、營業時間 08:00~21:00。
//   B1 服務人員管理:計酬方式下拉四種、選「時薪制」出現說明 → 儲存 → 資料庫是 hourly_wage
//   B2 抽成與薪資設定:「日薪／時薪制服務人員」區塊,金額 0 整張黃 + 「尚未設定金額」→ 填 200 → 存檔、黃卡消失
//   B3 歷史往前挪 40 天 + 跑凍結排程 ⇒ 過去 35 天每天一筆(120 分 × 200 ÷ 60 = 400 元)
//   B4 店家報表:「日薪／時薪支出」卡 = 400 × 本月到今天的天數、下方「含今天的預估」;淨利 = 原算法 − 工資
//   B5 服務人員報表(商家視角)與服務人員本人的薪資報表:上工天數 / 時數 / 工資合計 + 每天明細(已結算 / 預估)
//   B6 關掉昨天 10:00 那一格 ⇒ 昨天重算成 90 分、300 元(refrozen_reason = override)
//   B7 服務人員本人打開「休假設定」⇒ 時薪制不能自己開關時段,看到說明
//   B8 手機 375 寬:設定頁、店家報表、服務人員報表、我的薪資報表不爆版
// 截圖存 test-results/req1035b-shots(1280 / 375)。
import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant, primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  clientAs,
  injectSession,
  moveWageHistoryBack,
  runFreezeWorkDays,
  serviceClient,
  setupWage1035bFixture,
  teardownWage1035bFixture,
  workDayRecord,
  type Wage1035bFixture,
} from "./support/wage-1035b-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/req1035b-shots";

test.describe.configure({ mode: "serial" });

let fixture: Wage1035bFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupWage1035bFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownWage1035bFixture(fixture);
  console.log("[彈性計薪 B 批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function taipeiYesterday(): string {
  return new Date(Date.now() + 8 * 3600_000 - 24 * 3600_000).toISOString().slice(0, 10);
}

/** 本月 1 號到今天(含)共幾天 ⇒ 預期工資 = 400 × 天數。 */
function daysSoFarThisMonth(): number {
  return Number(taipeiToday().slice(8, 10));
}

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

async function compensationType(): Promise<string> {
  const r = await serviceClient()
    .from("merchant_staff")
    .select("compensation_type")
    .eq("id", fixture.staffId)
    .single();
  return (r.data as { compensation_type: string }).compensation_type;
}

test("B1 計酬方式下拉四種;選時薪制出現說明 → 儲存", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/staff");
  const card = page.locator("li").filter({ hasText: fixture.staffName });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });
  const select = page.getByRole("combobox", { name: "計酬類型" });
  await expect(select).toBeVisible({ timeout: LOAD_TIMEOUT });
  await select.click();
  await expect(page.getByRole("option")).toHaveText(["抽成制", "月薪制", "日薪制", "時薪制"]);
  await shot(page, "01_compensation_dropdown_1280", false);
  await page.getByRole("option", { name: "時薪制" }).click();
  await expect(page.getByTestId("staff-compensation-wage-help")).toHaveText(
    "上工時間照行事曆的可預約時段自動計算，請假那天不算。金額請到「抽成與薪資設定」設定。",
  );
  await expect(page.getByTestId("staff-compensation-change-note")).toContainText(
    "月中更改時，月薪以月底當時的計酬方式計算整個月。",
  );
  await shot(page, "02_compensation_hourly_help_1280", false);
  await page.getByRole("button", { name: "儲存" }).click();
  await expect.poll(compensationType, { timeout: LOAD_TIMEOUT }).toBe("hourly_wage");
  expectOnlyLocalRequests(recorder);
});

test("B2 日薪／時薪設定區:金額 0 黃卡 → 填 200 存檔", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const section = page.getByTestId("wage-staff-section");
  await expect(section).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(section).toContainText(fixture.staffName);
  await expect(section).toContainText("時薪制");
  await expect(section.getByText("尚未設定金額")).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, "03_wage_section_missing_1280");

  const input = section.getByLabel("金額（元／小時）");
  await input.fill("200");
  await input.press("Enter");
  await expect(page.getByText(`已更新「${fixture.staffName}」的時薪制金額`).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(section.getByText("尚未設定金額")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(section).toContainText("例：時薪 200 元 × 2 小時 20 分 = 467 元");
  await shot(page, "04_wage_section_set_1280");

  const r = await serviceClient()
    .from("staff_wage_settings")
    .select("wage_amount")
    .eq("staff_id", fixture.staffId)
    .single();
  expect(Number((r.data as { wage_amount: number }).wage_amount)).toBe(200);
  expectOnlyLocalRequests(recorder);
});

test("B3 歷史往前挪 + 跑凍結排程 ⇒ 過去 35 天每天一筆 400 元", async () => {
  moveWageHistoryBack(fixture);
  expect(runFreezeWorkDays(fixture)).toBe(35);
  expect(workDayRecord(fixture, taipeiYesterday())).toBe("120/400/-");
  // 再跑一次不會重寫
  expect(runFreezeWorkDays(fixture)).toBe(35);
});

test("B4 店家報表:日薪／時薪支出卡、含今天的預估、淨利扣掉工資", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const today = taipeiToday();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  const expected = 400 * daysSoFarThisMonth();
  const res = await clientAs(fixture.adminSession).rpc("get_merchant_billing_summary_by_range", {
    p_merchant_id: fixture.merchantId,
    p_start_date: `${y}-${mm}-01`,
    p_end_date: `${y}-${mm}-${String(last).padStart(2, "0")}`,
  });
  if (res.error) throw new Error(res.error.message);
  const s = res.data as Record<string, number | boolean | null>;
  expect(Number(s["total_wage_payout"])).toBe(expected);
  expect(s["wage_includes_estimate"]).toBe(true);
  expect(s["wage_feature_used"]).toBe(true);
  expect(Number(s["estimated_net_margin"])).toBe(
    Number(s["total_revenue_excl_tax"]) -
      Number(s["total_material_cost"]) -
      Number(s["total_commission_payout"]) -
      (Number(s["total_monthly_salary_base"]) - Number(s["total_monthly_salary_deduction"])) -
      Number(s["total_monthly_bonus"] ?? 0) -
      expected,
  );

  await openAsAdmin(page, "/app/billing-report");
  const label = page.getByText("日薪／時薪支出", { exact: true });
  await expect(label).toBeVisible({ timeout: LOAD_TIMEOUT });
  const card = label.locator("xpath=../..");
  await expect(card).toContainText(`${expected.toLocaleString()} 元`);
  await expect(card).toContainText("含今天的預估");
  await expect(page.getByText(`工資 ${expected.toLocaleString()} 元`)).toBeVisible();
  await shot(page, "05_billing_wage_card_1280");
  expectOnlyLocalRequests(recorder);
});

test("B5 服務人員報表(商家視角)與我的薪資報表:三張卡 + 每天明細", async ({ browser }) => {
  const expected = 400 * daysSoFarThisMonth();
  const days = daysSoFarThisMonth();
  const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const recorder = recordRequestHosts(adminPage);
  await injectSession(adminPage, fixture.adminSession);
  await primeCurrentMerchant(adminPage, LOAD_TIMEOUT);
  await adminPage.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  const report = adminPage.getByTestId("wage-staff-report");
  await expect(report).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(adminPage.getByTestId("wage-rate-summary")).toHaveText("時薪 200 元");
  await expect(report).toContainText(`${days} 天`);
  await expect(report).toContainText(`${(days * 2).toString()} 小時`);
  await expect(report).toContainText(`${expected.toLocaleString()} 元`);
  await expect(report).toContainText("預估");
  if (days > 1) await expect(report).toContainText("已結算");
  await shot(adminPage, "06_staff_report_wage_1280");
  expectOnlyLocalRequests(recorder);
  await adminPage.close();

  const staffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const recorder2 = recordRequestHosts(staffPage);
  await injectSession(staffPage, fixture.staffSession);
  await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
  await staffPage.goto("/app/my-payroll");
  const mine = staffPage.getByTestId("wage-staff-report");
  await expect(mine).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(mine).toContainText(`${expected.toLocaleString()} 元`);
  await expect(mine.getByRole("button", { name: "匯出這份報表為 CSV" })).toHaveCount(0);
  await shot(staffPage, "07_my_payroll_wage_1280");
  expectOnlyLocalRequests(recorder2);
  await staffPage.close();
});

test("B6 關掉昨天 10:00 那一格 ⇒ 昨天重算 90 分、300 元", async () => {
  const r = await clientAs(fixture.adminSession).rpc("set_staff_day_override", {
    p_staff_id: fixture.staffId,
    p_override_date: taipeiYesterday(),
    p_start_time: "10:00",
    p_end_time: "10:30",
    p_is_available: false,
  });
  if (r.error) throw new Error(r.error.message);
  expect(workDayRecord(fixture, taipeiYesterday())).toBe("90/300/override");
});

test("B7 時薪制的人打開「休假設定」⇒ 不能自己開關時段,看到說明", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.staffSession);
  await primeStaffCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/my-availability");
  await expect(page.getByTestId("staff-availability-wage-note")).toHaveText(
    "你的上工時間照店家排的時段計算，要調整請聯絡店家。",
    { timeout: LOAD_TIMEOUT },
  );
  await shot(page, "08_my_availability_wage_note_1280");
  expectOnlyLocalRequests(recorder);
});

test("B8 手機 375 寬:設定頁、店家報表、服務人員報表、我的薪資報表不爆版", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/payroll-settings");
  await expect(page.getByTestId("wage-staff-section")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(page);
  await shot(page, "11_settings_375");
  await page.goto("/app/billing-report");
  await expect(page.getByText("日薪／時薪支出", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await noHorizontalOverflow(page);
  await shot(page, "12_billing_375");
  await page.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  await expect(page.getByTestId("wage-staff-report")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(page);
  await shot(page, "13_staff_report_375");
  expectOnlyLocalRequests(recorder);
  await page.close();

  const staffPage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const recorder2 = recordRequestHosts(staffPage);
  await injectSession(staffPage, fixture.staffSession);
  await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
  await staffPage.goto("/app/my-payroll");
  await expect(staffPage.getByTestId("wage-staff-report")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(staffPage);
  await shot(staffPage, "14_my_payroll_375");
  expectOnlyLocalRequests(recorder2);
  await staffPage.close();
});
