// 第 11 批 F #993(2026-10-07)本機 e2e:建單 / 編輯訂單的料錢成本改成「數量 − +」與「自訂成本單價」。
// 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §十三 13.7 e2e-local。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。fixture 沿用第 9 批(建完硬刪除),另外多建一個料錢品項。
//
//   H1 商家:選擇料錢 → 品項 A ×2、品項 B 自訂成本單價 12.5 → 確認 → 摘要與合計正確 → 儲存 →
//      資料庫數量 / 單價正確 → 詳情顯示「× 數量」與小計 → 編輯帶回(數量、自訂開關亮著、單價)
//   H2 服務人員端同一流程:建單選料錢、調數量 → 資料庫正確
//   H3 375 / 320 寬:建單表單的料錢摘要、選擇料錢整頁都沒有橫向捲動(截圖存 test-results)
import { mkdirSync } from "node:fs";

import { devices, expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  ITEM_NAME,
  MATERIAL_NAME,
  serviceClient,
  setupBatch9Fixture,
  teardownBatch9Fixture,
  type Batch9Fixture,
} from "./support/batch9-fixture";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import { injectSession } from "./support/staff-order-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/b11-f-material-shots";
const MATERIAL_B_NAME = "E2E第11批料錢銅管";
const CUSTOMER_MERCHANT = "E2E第11批F商家料錢客戶";
const CUSTOMER_STAFF = "E2E第11批F服務人員料錢客戶";

test.describe.configure({ mode: "serial" });

let fixture: Batch9Fixture;
let materialBId: string;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupBatch9Fixture();
    // 第二個料錢品項(現價 600);第 9 批 fixture 只有一個(MATERIAL_NAME,現價 300)。
    const r = await fixture.admin
      .from("material_cost_items")
      .insert({ merchant_id: fixture.merchantId, name: MATERIAL_B_NAME, amount: 600 })
      .select("id")
      .single();
    if (r.error || !r.data) throw new Error(`建立第二個料錢品項失敗:${r.error?.message}`);
    materialBId = (r.data as { id: string }).id;
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBatch9Fixture(fixture);
  console.log("[第11批F] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function materialRows(bookingId: string) {
  const r = await serviceClient()
    .from("booking_material_costs")
    .select("material_cost_item_id,quantity,amount_snapshot")
    .eq("booking_id", bookingId)
    .order("material_cost_item_id");
  if (r.error) throw new Error(`讀料錢失敗:${r.error.message}`);
  return (r.data as { material_cost_item_id: string; quantity: number; amount_snapshot: number }[])
    .map((x) => ({
      id: x.material_cost_item_id,
      quantity: x.quantity,
      unit: Number(x.amount_snapshot),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function bookingIdByCustomer(customer: string): Promise<string> {
  const r = await serviceClient()
    .from("bookings")
    .select("id")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", customer)
    .single();
  if (r.error || !r.data) throw new Error(`查訂單失敗:${r.error?.message}`);
  return (r.data as { id: string }).id;
}

/** 商家管理員 → 行事曆(明天)→「新增預約」→ 選服務人員。 */
async function openMerchantNewBooking(page: Page): Promise<Locator> {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page.getByRole("button", { name: "新增預約" }).first().click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: fixture.staff.name }).click();
  return dialog;
}

async function pickService(page: Page, form: Locator) {
  await form.locator("#booking-service-items").click();
  const picker = page.getByTestId("service-item-picker");
  await picker.getByRole("checkbox", { name: new RegExp(ITEM_NAME) }).click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(picker).toHaveCount(0);
}

async function pickPayment(page: Page, form: Locator) {
  await form.locator("#booking-payment-method").click();
  await page.getByRole("option", { name: fixture.paymentMethodName }).click();
}

function materialCard(picker: Locator, name: string): Locator {
  return picker.locator('[data-testid^="material-picker-item-"]').filter({ hasText: name });
}

test("H1 商家:A ×2、B 自訂成本單價 12.5 → 摘要合計 → 儲存 → 資料庫 / 詳情 × 數量 → 編輯帶回", async ({
  page,
}) => {
  const recorder = recordRequestHosts(page);
  const form = await openMerchantNewBooking(page);
  await form.locator("#booking-customer-name").fill(CUSTOMER_MERCHANT);
  await form.locator("#booking-customer-phone").fill(`09${fixture.runId.slice(-8)}`);
  await pickService(page, form);
  await pickPayment(page, form);

  // 料錢區:「選擇料錢 >」一列(不再是一顆顆方塊)。
  await expect(form.locator("#booking-material-costs")).toHaveText(/選擇料錢/);
  await form.locator("#booking-material-costs").click();
  const picker = page.getByTestId("material-picker");
  await expect(picker.getByRole("heading", { name: "選擇料錢" })).toBeVisible();
  await expect(picker.getByRole("tablist")).toHaveCount(0);
  const a = materialCard(picker, MATERIAL_NAME);
  await a.getByRole("checkbox", { name: new RegExp(MATERIAL_NAME) }).click();
  await a.getByRole("button", { name: `增加「${MATERIAL_NAME}」的數量` }).click();
  await expect(a.getByRole("spinbutton", { name: `「${MATERIAL_NAME}」的數量` })).toHaveValue("2");
  const b = materialCard(picker, MATERIAL_B_NAME);
  await b.getByRole("checkbox", { name: new RegExp(MATERIAL_B_NAME) }).click();
  await b.getByRole("switch", { name: "自訂成本單價" }).click();
  await b.getByLabel("單價", { exact: true }).fill("12.5");
  await picker.getByRole("button", { name: "確認（已選 2 項）" }).click();
  await expect(picker).toHaveCount(0);

  const summary = form.getByTestId("booking-material-summary");
  await expect(summary).toContainText(`${MATERIAL_NAME} × 2`);
  await expect(summary).toContainText("$600");
  await expect(summary).toContainText(`${MATERIAL_B_NAME} × 1(自訂單價 $12.5)`);
  await expect(form.getByTestId("booking-material-summary-total")).toHaveText(
    "已選 2 項，料錢合計 $612.5(僅供操作者參考，不代表訂單金額)",
  );

  await page.waitForTimeout(1500); // 紅利預覽要算完才能送(同第 9 批 G1)
  await form.getByRole("button", { name: "建立預約" }).click();
  const confirmPoints = page.getByRole("alertdialog").getByRole("button", { name: "確認送出" });
  if (await confirmPoints.isVisible().catch(() => false)) await confirmPoints.click();
  await expect(form).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const bookingId = await bookingIdByCustomer(CUSTOMER_MERCHANT);
  expect(await materialRows(bookingId)).toEqual(
    [
      { id: fixture.materialId, quantity: 2, unit: 300 },
      { id: materialBId, quantity: 1, unit: 12.5 },
    ].sort((x, y) => x.id.localeCompare(y.id)),
  );

  // 詳情:名稱 × 數量、小計。
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click();
  const blockEl = page.getByTestId(`booking-block-${bookingId}-main`);
  await expect(blockEl).toBeVisible({ timeout: LOAD_TIMEOUT });
  await blockEl.scrollIntoViewIfNeeded();
  await blockEl.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText(`${MATERIAL_NAME} × 2`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(detail.getByText(`${MATERIAL_B_NAME} × 1`)).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/H1-detail.png` });

  // 編輯帶回:摘要一樣;整頁裡數量 2、B 的自訂開關亮著、單價 12.5。
  await detail.getByRole("button", { name: "編輯" }).click();
  const edit = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "編輯預約" }) });
  await expect(edit.getByTestId("booking-material-summary-total")).toHaveText(
    "已選 2 項，料錢合計 $612.5(僅供操作者參考，不代表訂單金額)",
    { timeout: LOAD_TIMEOUT },
  );
  await edit.locator("#booking-material-costs").click();
  const editPicker = page.getByTestId("material-picker");
  await expect(
    materialCard(editPicker, MATERIAL_NAME).getByRole("spinbutton", {
      name: `「${MATERIAL_NAME}」的數量`,
    }),
  ).toHaveValue("2");
  await page.screenshot({ path: `${SHOT_DIR}/H1-edit-picker.png` });
  await editPicker.getByRole("button", { name: /^確認/ }).click();
  expectOnlyLocalRequests(recorder);
});

test("H2 服務人員端:建單選料錢、調數量 ⇒ 資料庫數量 / 單價正確", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.staff.session);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await page.locator(`button[data-date-key="${fixture.dateKey}"]`).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: "時間軸格線" }).click();
  await expect(page.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: /^17:00 (可預約|不可預約)$/ }).click();
  await page.getByRole("menuitem", { name: "新增預約" }).click();
  const form = page.getByRole("dialog");
  await expect(form.locator("#booking-material-costs")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await form.locator("#booking-customer-name").fill(CUSTOMER_STAFF);
  await form.locator("#booking-customer-phone").fill(
    `09${String(Number(fixture.runId.slice(-8)) + 7)
      .padStart(8, "0")
      .slice(-8)}`,
  );
  await pickService(page, form);
  await pickPayment(page, form);
  await form.locator("#booking-material-costs").click();
  const picker = page.getByTestId("material-picker");
  const a = materialCard(picker, MATERIAL_NAME);
  await a.getByRole("checkbox", { name: new RegExp(MATERIAL_NAME) }).click();
  await a.getByRole("button", { name: `增加「${MATERIAL_NAME}」的數量` }).click();
  await a.getByRole("button", { name: `增加「${MATERIAL_NAME}」的數量` }).click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(form.getByTestId("booking-material-summary")).toContainText(`${MATERIAL_NAME} × 3`);
  await expect(form.getByTestId("booking-material-summary-total")).toContainText("料錢合計 $900");
  await page.waitForTimeout(1500);
  await form.getByRole("button", { name: "建立預約" }).click();
  const confirmPoints = page.getByRole("alertdialog").getByRole("button", { name: "確認送出" });
  if (await confirmPoints.isVisible().catch(() => false)) await confirmPoints.click();
  await expect(page.getByText(/已送出訂單/).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  const bookingId = await bookingIdByCustomer(CUSTOMER_STAFF);
  expect(await materialRows(bookingId)).toEqual([
    { id: fixture.materialId, quantity: 3, unit: 300 },
  ]);
  expectOnlyLocalRequests(recorder);
});

async function narrowPage(browser: Browser, width: number) {
  const iphone = devices["iPhone SE (3rd gen)"];
  const context = await browser.newContext({
    viewport: { width, height: 667 },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  await context.addInitScript(() => {
    window.localStorage.setItem("miaoyue_pwa_install_hint_dismissed_at", String(Date.now()));
  });
  return { context, page: await context.newPage() };
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label} 不可以左右滑`).toBeLessThanOrEqual(0);
}

for (const width of [375, 320]) {
  test(`H3 ${width} 寬:料錢摘要與選擇料錢整頁不爆版`, async ({ browser }) => {
    const { context, page } = await narrowPage(browser, width);
    try {
      const recorder = recordRequestHosts(page);
      const form = await openMerchantNewBooking(page);
      await form.locator("#booking-material-costs").scrollIntoViewIfNeeded();
      await form.locator("#booking-material-costs").click();
      const picker = page.getByTestId("material-picker");
      const a = materialCard(picker, MATERIAL_NAME);
      await a.getByRole("checkbox", { name: new RegExp(MATERIAL_NAME) }).click();
      const b = materialCard(picker, MATERIAL_B_NAME);
      await b.getByRole("checkbox", { name: new RegExp(MATERIAL_B_NAME) }).click();
      await b.getByRole("switch", { name: "自訂成本單價" }).click();
      await b.getByLabel("單價", { exact: true }).fill("12345678.5");
      await expectNoHorizontalOverflow(page, `${width} 寬選擇料錢整頁`);
      await page.screenshot({ path: `${SHOT_DIR}/H3-picker-${width}.png` });
      await picker.getByRole("button", { name: /^確認/ }).click();
      const summary = form.getByTestId("booking-material-summary");
      await summary.scrollIntoViewIfNeeded();
      await expect(summary).toContainText("(自訂單價 $12,345,678.5)");
      await expectNoHorizontalOverflow(page, `${width} 寬建單表單料錢摘要`);
      await page.screenshot({ path: `${SHOT_DIR}/H3-summary-${width}.png` });
      expectOnlyLocalRequests(recorder);
    } finally {
      await context.close();
    }
  });
}
