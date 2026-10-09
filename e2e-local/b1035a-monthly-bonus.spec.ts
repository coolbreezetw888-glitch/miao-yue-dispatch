// #1035 彈性計薪 A 批(月薪加獎金)本機 e2e。
// 規格書:母版 .project/specs/彈性計薪.md 第七節 PT e2e-local(A)、第八節 PJ-02 截圖。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
// fixture:月薪人員 M 今天完成 13 單(冷氣 13 台 + 水管 1 份)。
//   A1c 還沒指派方案:服務人員本人的「我的薪資報表」預設照舊(本月 1 號到今天、按日期)
//   A1 抽成與薪資設定:空狀態 → 新增方案(每單 100 + 只算冷氣、超過 10 台每台 300)→ 試算 2,200 → 儲存
//   A2 月薪人員「獎金方案」下拉指派 → 資料庫歷史開新列
//   A3 店家報表:「月薪獎金」卡 2,200、淨利 = 原算法 − 2,200;切到自訂區間(不完整月份)⇒ 說明文字
//   A4 服務人員報表(商家視角)看到獎金明細「第 11～13 份，共 3 份」;服務人員本人的「我的薪資報表」也看得到
//      (#1035 追加:方案本月才指派 ⇒ 預設不跳,照舊本月 1 號到今天)
//   A4b 上個月月底就有方案 ⇒ 預設跳到上個月整月、按月份,一進來就看到獎金區塊(測完還原)
//   A5 改規則選「從下個月起」⇒ 本月報表不變、卡片標「下個月起另有設定」
//   A6 手機 375 寬:設定頁、編輯器、報表不爆版(沒有橫向捲動)
// 截圖存 test-results/req1035a-shots(1280 / 375)。
import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant, primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  clientAs,
  injectSession,
  serviceClient,
  setupBonus1035aFixture,
  teardownBonus1035aFixture,
  type Bonus1035aFixture,
} from "./support/bonus-1035a-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/req1035a-shots";
const PLAN_NAME = "E2E冷氣組";

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
  console.log("[彈性計薪 A 批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
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

/** 本機時間(瀏覽器跟 Node 跑在同一台、同一個時區)的今天 / 本月 / 上個月,格式跟日期欄位一致。 */
function localDates() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    today: `${ym(now)}-${pad(now.getDate())}`,
    thisMonth: ym(now),
    previousMonth: ym(prev),
  };
}

async function summary() {
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

test("A1 新增方案(兩條規則)+ 試算 2,200 → 儲存", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const section = page.getByTestId("bonus-plan-section");
  await expect(section.getByText("還沒有獎金方案")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await shot(page, "01_settings_empty_1280");

  await section.getByTestId("bonus-plan-new").click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText("新增獎金方案")).toBeVisible();
  await editor.getByLabel("方案名稱").fill(PLAN_NAME);

  // 第 1 條:每單加錢,從第一單起每單 100
  const cards = editor.getByTestId("bonus-rule-card");
  await cards.nth(0).getByRole("radio", { name: "每單加錢" }).click();
  await cards.nth(0).getByLabel("超過多少後才開始算（單）").fill("0");
  await cards.nth(0).getByLabel("每單加多少（元）").fill("100");
  await expect(cards.nth(0).getByTestId("bonus-rule-summary")).toHaveText("每單加 100 元");

  // 第 2 條:每份加錢,只算冷氣清洗,超過 10 份後每份 300
  await editor.getByTestId("bonus-rule-add").click();
  await expect(cards).toHaveCount(2);
  const second = cards.nth(1);
  await second.getByRole("radio", { name: "每份加錢" }).click();
  await second.getByRole("button", { name: "第 2 條只算這些服務" }).click();
  await page.locator(`[data-testid$="-services-option-${fixture.acServiceItemId}"]`).click();
  await page.keyboard.press("Escape");
  await second.getByLabel("超過多少後才開始算（份）").fill("10");
  await second.getByLabel("每份加多少（元）").fill("300");
  await expect(second.getByTestId("bonus-rule-summary")).toHaveText(
    "只算「E2E冷氣清洗」：超過 10 份之後，第 11 份起每份加 300 元",
  );

  // 試算(資料庫算):13 單 × 100 + 第 11～13 台 × 300 = 2,200
  const preview = editor.getByTestId("bonus-preview-result");
  await expect(preview).toContainText("2,200 元", { timeout: LOAD_TIMEOUT });
  await expect(preview).toContainText("第 11～13 份，共 3 份");
  await editor.getByTestId("bonus-preview").scrollIntoViewIfNeeded();
  await shot(page, "02_editor_with_preview_1280", false);

  await editor.getByTestId("bonus-plan-save").click();
  await expect(page.getByText("已建立獎金方案").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(section.getByTestId("bonus-plan-list")).toContainText(PLAN_NAME);
  await shot(page, "03_settings_with_plan_1280");
  expectOnlyLocalRequests(recorder);
});

test("A1b 四種規則的摘要句與試算(截圖用,不存檔)", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const section = page.getByTestId("bonus-plan-section");
  await expect(section.getByTestId("bonus-plan-list")).toContainText(PLAN_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await section.getByTestId("bonus-plan-new").click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("方案名稱").fill("E2E四種規則");
  const cards = editor.getByTestId("bonus-rule-card");
  for (let i = 1; i < 4; i += 1) await editor.getByTestId("bonus-rule-add").click();
  await expect(cards).toHaveCount(4);

  await cards.nth(0).getByRole("radio", { name: "每單加錢" }).click();
  await cards.nth(0).getByLabel("每單加多少（元）").fill("100");
  await cards.nth(1).getByLabel("超過多少後才開始算（份）").fill("10");
  await cards.nth(1).getByLabel("算到多少為止（份，選填）").fill("20");
  await cards.nth(1).getByLabel("每份加多少（元）").fill("300");
  await cards.nth(2).getByRole("radio", { name: "業績百分比" }).click();
  await cards.nth(2).getByLabel("超過多少後才開始算（元）").fill("10000");
  await cards.nth(2).getByLabel("百分比（%）").fill("5");
  await cards.nth(3).getByRole("radio", { name: "達標給一筆" }).click();
  await cards.nth(3).getByRole("radio", { name: "完成單數" }).click();
  await cards.nth(3).getByLabel("達到多少就給（單）").fill("13");
  await cards.nth(3).getByLabel("給多少（元）").fill("3000");

  const summaries = editor.getByTestId("bonus-rule-summary");
  await expect(summaries.nth(0)).toHaveText("每單加 100 元");
  await expect(summaries.nth(1)).toHaveText("第 11～20 份，每份加 300 元");
  await expect(summaries.nth(2)).toHaveText("業績超過 10,000 元的部分，加 5%");
  await expect(summaries.nth(3)).toHaveText("這個月完成滿 13 單，加 3,000 元");
  // 13 單 × 100 + 第 11～14 份 × 300 + (15,000 − 10,000) × 5% + 達標 3,000 = 1,300 + 1,200 + 250 + 3,000
  await expect(editor.getByTestId("bonus-preview-result")).toContainText("5,750 元", {
    timeout: LOAD_TIMEOUT,
  });
  await shot(page, "02b_editor_four_kinds_top_1280", false);
  await editor.getByTestId("bonus-preview").scrollIntoViewIfNeeded();
  await shot(page, "02c_editor_four_kinds_preview_1280", false);
  await editor.getByRole("button", { name: "取消" }).click();
  await expect(editor).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
});

test("A1c 還沒指派方案的月薪人員:我的薪資報表預設照舊(本月 1 號到今天、按日期)", async ({
  browser,
}) => {
  const staffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const recorder = recordRequestHosts(staffPage);
  await injectSession(staffPage, fixture.staffSession);
  await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
  await staffPage.goto("/app/my-payroll");
  const { today, thisMonth } = localDates();
  await expect(staffPage.getByRole("radio", { name: "按日期" })).toHaveAttribute(
    "aria-checked",
    "true",
    {
      timeout: LOAD_TIMEOUT,
    },
  );
  await expect(staffPage.locator("#date-range-start")).toHaveValue(`${thisMonth}-01`);
  await expect(staffPage.locator("#date-range-end")).toHaveValue(today);
  await expect(staffPage.getByTestId("staff-bonus-details")).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
  await staffPage.close();
});

test("A2 月薪人員下拉指派方案 → 歷史開新列", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const select = page.locator(`#staff-bonus-plan-${fixture.staffId}`);
  await expect(select).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(select).toContainText("不給獎金");
  await select.click();
  await page.getByRole("option", { name: PLAN_NAME }).click();
  await expect(page.getByText(`已把「${fixture.staffName}」套用到「${PLAN_NAME}」`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(select).toContainText(PLAN_NAME);
  await shot(page, "04_assign_dropdown_1280");

  const h = await serviceClient()
    .from("staff_payroll_status_history")
    .select("bonus_plan_id")
    .eq("staff_id", fixture.staffId)
    .is("effective_to", null)
    .single();
  expect(h.error).toBeNull();
  expect(h.data?.bonus_plan_id).toMatch(/^[0-9a-f-]{36}$/);
  expectOnlyLocalRequests(recorder);
});

test("A3 店家報表:月薪獎金卡 2,200、淨利扣掉獎金;不完整月份顯示說明", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const s = await summary();
  expect(Number(s["total_monthly_bonus"])).toBe(2200);
  expect(Number(s["estimated_net_margin"])).toBe(
    Number(s["total_revenue_excl_tax"]) -
      Number(s["total_material_cost"]) -
      Number(s["total_commission_payout"]) -
      (Number(s["total_monthly_salary_base"]) - Number(s["total_monthly_salary_deduction"])) -
      2200,
  );

  await openAsAdmin(page, "/app/billing-report");
  // 卡片 = CardDescription「月薪獎金」往上兩層(CardHeader → Card)。
  const card = page.getByText("月薪獎金", { exact: true }).locator("xpath=../..");
  await expect(page.getByText("月薪獎金", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("2,200 元");
  await expect(page.getByText(`${fixture.staffName}`)).toBeVisible();
  await expect(page.getByText("獎金 2200 元")).toBeVisible();
  await shot(page, "05_billing_full_month_1280");

  // 切到自訂區間、把起日改成本月 2 號 ⇒ 不是完整月份。
  await page.getByRole("radio", { name: "自訂區間" }).click();
  const start = page.locator("#date-range-start");
  const startValue = await start.inputValue();
  await start.fill(`${startValue.slice(0, 8)}02`);
  await expect(page.getByText("獎金：需選擇完整月份才能計算")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await shot(page, "06_billing_partial_1280");
  expectOnlyLocalRequests(recorder);
});

test("A4 服務人員報表(商家視角)與服務人員本人的我的薪資報表都看得到獎金明細", async ({
  browser,
}) => {
  const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const recorder = recordRequestHosts(adminPage);
  await injectSession(adminPage, fixture.adminSession);
  await primeCurrentMerchant(adminPage, LOAD_TIMEOUT);
  await adminPage.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  const details = adminPage.getByTestId("staff-bonus-details");
  await expect(details).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(details).toContainText(PLAN_NAME);
  await expect(details).toContainText("第 11～13 份，共 3 份");
  await expect(details).toContainText("900 元");
  await expect(adminPage.getByText("合計（含獎金）")).toBeVisible();
  await shot(adminPage, "07_staff_report_bonus_1280");
  expectOnlyLocalRequests(recorder);
  await adminPage.close();

  const staffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const recorder2 = recordRequestHosts(staffPage);
  await injectSession(staffPage, fixture.staffSession);
  await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
  await staffPage.goto("/app/my-payroll");
  const mine = staffPage.getByTestId("staff-bonus-details");
  // #1035 追加(主腦裁決):fixture 的方案是「這個月」才指派的,上個月沒有方案 ⇒ 預設不跳,
  // 照舊是本月 1 號到今天、按日期(不是完整月份)⇒ 只顯示「不是完整月份，不計算獎金」;切到「按月份」才算本月。
  const { today, thisMonth } = localDates();
  await expect(mine).toContainText("這幾個月不是完整月份，不計算獎金", { timeout: LOAD_TIMEOUT });
  await expect(staffPage.getByRole("radio", { name: "按日期" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(staffPage.locator("#date-range-start")).toHaveValue(`${thisMonth}-01`);
  await expect(staffPage.locator("#date-range-end")).toHaveValue(today);
  await shot(staffPage, "08a_my_payroll_partial_1280");
  await staffPage.getByRole("radio", { name: "按月份" }).click();
  const endMonth = staffPage.locator("#date-range-end");
  // 原生月份欄位填同一個值不會觸發 change ⇒ 先填下個月、再填回本月(兩次都會把訖日換成該月最後一天)。
  const [ty, tm] = thisMonth.split("-").map(Number);
  const nextMonth = tm === 12 ? `${ty! + 1}-01` : `${ty}-${String(tm! + 1).padStart(2, "0")}`;
  await endMonth.fill(nextMonth);
  await endMonth.fill(thisMonth);
  await expect(mine).toContainText("第 11～13 份，共 3 份");
  // 服務人員本人看不到方案名稱(只有規則名稱與金額)。
  await expect(mine).not.toContainText(PLAN_NAME);
  await shot(staffPage, "08_my_payroll_bonus_1280");
  expectOnlyLocalRequests(recorder2);
  await staffPage.close();
});

test("A4b 上個月月底就有方案 ⇒ 我的薪資報表預設跳到上個月整月(按月份)、一進來就看到獎金", async ({
  browser,
}) => {
  // 暫時加一列「上個月就已經套用方案」的薪資狀態歷史(蓋住上個月月底)+ 上個月生效的規則版本;
  // 測完刪掉,其他測試看到的資料跟原本一樣。只動本次 fixture 的服務人員 / 方案。
  const svc = serviceClient();
  const hist = await svc
    .from("staff_payroll_status_history")
    .select("effective_from, bonus_plan_id, merchant_id, monthly_base_salary")
    .eq("staff_id", fixture.staffId)
    .order("effective_from", { ascending: true });
  expect(hist.error).toBeNull();
  const rows = hist.data ?? [];
  const planId = rows.map((r) => r.bonus_plan_id as string | null).find((v) => v) ?? null;
  expect(planId).toMatch(/^[0-9a-f-]{36}$/);
  const earliest = rows[0]!;
  const { previousMonth } = localDates();
  // 上個月 1 號(台北)前一天開始,到最早那列開始為止。
  const from = new Date(`${previousMonth}-01T00:00:00+08:00`);
  from.setUTCDate(from.getUTCDate() - 1);
  const ins = await svc
    .from("staff_payroll_status_history")
    .insert({
      staff_id: fixture.staffId,
      merchant_id: earliest.merchant_id,
      compensation_type: "monthly_salary",
      status: "active",
      monthly_base_salary: earliest.monthly_base_salary,
      bonus_plan_id: planId,
      effective_from: from.toISOString(),
      effective_to: earliest.effective_from,
      is_backfill_seed: false,
    })
    .select("id")
    .single();
  expect(ins.error).toBeNull();
  const ver = await svc
    .from("staff_bonus_plan_versions")
    .select("merchant_id, rules")
    .eq("plan_id", planId!)
    .order("effective_month", { ascending: true })
    .limit(1)
    .single();
  expect(ver.error).toBeNull();
  const verIns = await svc
    .from("staff_bonus_plan_versions")
    .insert({
      plan_id: planId,
      merchant_id: ver.data!.merchant_id,
      effective_month: `${previousMonth}-01`,
      rules: ver.data!.rules,
    })
    .select("id")
    .single();
  expect(verIns.error).toBeNull();

  try {
    const staffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const recorder = recordRequestHosts(staffPage);
    await injectSession(staffPage, fixture.staffSession);
    await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
    await staffPage.goto("/app/my-payroll");
    await expect(staffPage.getByRole("radio", { name: "按月份" })).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: LOAD_TIMEOUT },
    );
    await expect(staffPage.locator("#date-range-start")).toHaveValue(previousMonth);
    await expect(staffPage.locator("#date-range-end")).toHaveValue(previousMonth);
    const mine = staffPage.getByTestId("staff-bonus-details");
    await expect(mine).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(mine).toContainText("這個月獎金");
    await expect(mine).not.toContainText("這幾個月不是完整月份");
    await expect(mine).not.toContainText(PLAN_NAME);
    await shot(staffPage, "08b_my_payroll_default_previous_month_1280");
    expectOnlyLocalRequests(recorder);
    await staffPage.close();
  } finally {
    await svc.from("staff_bonus_plan_versions").delete().eq("id", verIns.data!.id);
    await svc.from("staff_payroll_status_history").delete().eq("id", ins.data!.id);
  }
});

test("A5 改規則選「從下個月起」⇒ 本月不變、卡片標「下個月起另有設定」", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openAsAdmin(page, "/app/payroll-settings");
  const list = page.getByTestId("bonus-plan-list");
  await expect(list).toContainText(PLAN_NAME, { timeout: LOAD_TIMEOUT });
  await list.getByRole("button", { name: "編輯" }).click();
  const editor = page.getByRole("dialog");
  const second = editor.getByTestId("bonus-rule-card").nth(1);
  await second.getByLabel("每份加多少（元）").fill("500");
  await editor.getByRole("radio", { name: "從下個月起生效" }).click();
  await editor.getByTestId("bonus-plan-save").click();
  await expect(page.getByText("已更新獎金方案").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(list.getByText("下個月起另有設定")).toBeVisible();

  const s = await summary();
  expect(Number(s["total_monthly_bonus"])).toBe(2200);
  expectOnlyLocalRequests(recorder);
});

test("A5b 開編輯器、開封存確認窗:console 沒有 React「same key」錯誤", async ({ page }) => {
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
  await expect(editor.getByTestId("bonus-preview")).toBeVisible();
  await editor.getByRole("button", { name: "取消" }).click();
  await expect(editor).toHaveCount(0);

  await list.getByRole("button", { name: "更多動作" }).click();
  await page.getByRole("menuitem", { name: "封存" }).click();
  const confirm = page.getByTestId("bonus-plan-archive-confirm");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toHaveCount(0);

  expect(consoleErrors.filter((t) => /same key/i.test(t))).toEqual([]);
  expectOnlyLocalRequests(recorder);
});

test("A6 手機 375 寬:設定頁、編輯器、報表不爆版", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/payroll-settings");
  await expect(page.getByTestId("bonus-plan-list")).toContainText(PLAN_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await noHorizontalOverflow(page);
  await shot(page, "11_settings_375");
  await page.getByTestId("bonus-plan-list").getByRole("button", { name: "編輯" }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByTestId("bonus-preview-result")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(page);
  await shot(page, "12_editor_375", false);
  await page.keyboard.press("Escape");

  await page.goto("/app/billing-report");
  await expect(page.getByText("月薪獎金", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(page);
  await shot(page, "13_billing_375");

  await page.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  await expect(page.getByTestId("staff-bonus-details")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await noHorizontalOverflow(page);
  await shot(page, "14_staff_report_375");
  expectOnlyLocalRequests(recorder);
  await page.close();
});
