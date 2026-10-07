// #986 第 9 批(使用者裁決小項 + 第 7 批調整)本機 e2e。
// 規格書:.project/specs/使用者裁決小項與第7批調整-第9批.md 5-4。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
//   G1 服務人員建單勾一個料錢 → 商家端(管理員身分)看得到;服務人員再編輯拿掉 → 商家端看到已拿掉
//   G2 服務人員拖拉改時間 → 本機 line_notification_log 沒有新增任何「客戶(member)」目標的列
//   G3 建單時間間隔 = 10 → 商家端拖拉一張單到格子中間 ⇒ 落點是 10 分鐘倍數(09:40);服務人員端同樣(13:40)
//      同時存兩張拖拉中截圖(桌機 + 375 寬),讓使用者判斷手感
//   G4 服務項目頁新增一個有描述的項目 → 建單「選擇項目」整頁看得到描述(商家端、服務人員端各一次)
//   G5 服務人員確認接單 → 有「訂單管理」的客服鈴鐺看得到;沒有的客服看不到
//   G6 375 寬:服務項目頁描述欄、選擇項目卡片描述、超級管理員頁(標點改過)不爆版
import { mkdirSync } from "node:fs";

import { devices, expect, test, type Browser, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  CUSTOMER_BC,
  CUSTOMER_BM,
  CUSTOMER_BS,
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
const SHOT_DIR = "test-results/req986-batch9-shots";
const NEW_ITEM_NAME = "E2E第9批有描述的項目";
const NEW_ITEM_DESCRIPTION = "含清洗與檢查\n約需 30 分鐘";

test.describe.configure({ mode: "serial" });

let fixture: Batch9Fixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupBatch9Fixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBatch9Fixture(fixture);
  console.log("[第9批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function mobilePage(browser: Browser) {
  const iphone = devices["iPhone SE (3rd gen)"];
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  return { context, page: await context.newPage() };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 服務人員登入 → 行事曆 → 選明天 → 切到「時間軸格線」。 */
async function openStaffTimeline(page: Page) {
  await injectSession(page, fixture.staff.session);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await page.locator(`button[data-date-key="${fixture.dateKey}"]`).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: "時間軸格線" }).click();
  await expect(page.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

/** 商家管理員 → 行事曆明天 → 週檢視格線。 */
async function openMerchantGrid(page: Page) {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  const grid = page.getByTestId("calendar-day-grid");
  await expect(grid).toBeVisible({ timeout: LOAD_TIMEOUT });
  return grid;
}

async function startAtMs(bookingId: string): Promise<number> {
  const r = await serviceClient().from("bookings").select("start_at").eq("id", bookingId).single();
  if (r.error) throw new Error(`查訂單時間失敗:${r.error.message}`);
  return new Date((r.data as { start_at: string }).start_at).getTime();
}

function taipeiMs(time: string): number {
  return new Date(`${fixture.dateKey}T${time}:00+08:00`).getTime();
}

/** 管理員身分(RLS = 商家端看得到的)讀這張單的料錢品項名稱。 */
async function merchantSideMaterials(bookingId: string): Promise<string[]> {
  const r = await fixture.admin
    .from("booking_material_costs")
    .select("material_cost_item_id")
    .eq("booking_id", bookingId);
  if (r.error) throw new Error(`商家端讀料錢失敗:${r.error.message}`);
  return (r.data as { material_cost_item_id: string }[]).map((x) => x.material_cost_item_id);
}

test("G1 服務人員建單勾料錢 → 商家端看得到;再編輯拿掉 → 商家端看到已拿掉", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page);
  await page.getByRole("button", { name: /^11:00 (可預約|不可預約)$/ }).click();
  await page.getByRole("menuitem", { name: "新增預約" }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("料錢成本").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await form.locator("#booking-customer-name").fill("E2E第9批料錢客戶");
  await form.locator("#booking-customer-phone").fill(`09${fixture.runId.slice(-8)}`);
  await form.locator("#booking-service-items").click();
  const picker = page.getByTestId("service-item-picker");
  await picker.getByRole("checkbox", { name: new RegExp(ITEM_NAME) }).click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await form.locator("#booking-payment-method").click();
  await page.getByRole("option", { name: fixture.paymentMethodName }).click();
  // 第 11 批 F #993:料錢改成「選擇料錢」整頁。
  await form.locator("#booking-material-costs").click();
  const materialPicker = page.getByTestId("material-picker");
  await materialPicker.getByRole("checkbox", { name: new RegExp(MATERIAL_NAME) }).click();
  await materialPicker.getByRole("button", { name: /^確認/ }).click();
  await form.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText(/已送出訂單/).first()).toBeVisible({ timeout: LOAD_TIMEOUT });

  const created = await serviceClient()
    .from("bookings")
    .select("id")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", "E2E第9批料錢客戶")
    .single();
  const bookingId = (created.data as { id: string }).id;
  await expect.poll(() => merchantSideMaterials(bookingId)).toEqual([fixture.materialId]);

  // 服務人員再編輯:預帶已勾的料錢,拿掉後儲存。
  await page.getByTestId("my-timeline-grid").getByText("E2E第9批料錢客戶").click();
  await page.getByRole("dialog").getByTestId("staff-edit-booking-button").click();
  const edit = page.getByRole("dialog");
  // 第 11 批 F #993:預帶的料錢在摘要裡;到「選擇料錢」整頁取消勾選後確認。
  await expect(edit.getByTestId("booking-material-summary")).toContainText(MATERIAL_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await edit.locator("#booking-material-costs").click();
  const editPicker = page.getByTestId("material-picker");
  const materialBox = editPicker.getByRole("checkbox", { name: new RegExp(MATERIAL_NAME) });
  await expect(materialBox).toHaveAttribute("aria-checked", "true");
  await materialBox.click();
  await expect(materialBox).toHaveAttribute("aria-checked", "false");
  await editPicker.getByRole("button", { name: /^確認/ }).click();
  await expect(edit.getByTestId("booking-material-summary")).toHaveCount(0);
  await page.waitForTimeout(1500); // 紅利預覽要算完才能送(同第 7 批 E3)
  await edit.getByRole("button", { name: "儲存變更" }).click();
  const confirmPoints = page.getByRole("alertdialog").getByRole("button", { name: "確認送出" });
  if (await confirmPoints.isVisible().catch(() => false)) await confirmPoints.click();
  await expect(page.getByText("已更新預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect.poll(() => merchantSideMaterials(bookingId)).toEqual([]);
  expectOnlyLocalRequests(recorder);
});

test("G2 + G3(服務人員端)拖拉 → 落在 10 分鐘倍數;LINE 記錄沒有任何客戶目標的列", async ({
  page,
}) => {
  const recorder = recordRequestHosts(page);
  const svc = serviceClient();
  const memberLogsBefore = await svc
    .from("line_notification_log")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId)
    .eq("target_type", "member");

  await openStaffTimeline(page);
  const block = page.getByTestId(`booking-block-${fixture.bookings.bs}-main`);
  await expect(block).toHaveAttribute("data-booking-draggable", "true", { timeout: LOAD_TIMEOUT });
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + 6 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 12);
  // 1px = 1 分鐘(30 分鐘 / 30px)。往下 41px ⇒ 13:41 ⇒ 吸附到 13:40(格子中間)。
  await page.mouse.move(start.x, start.y + 41, { steps: 8 });
  await expect(page.getByTestId("booking-drag-hint")).toHaveText("改時間 → 13:40");
  await page.screenshot({ path: `${SHOT_DIR}/staff-drag-desktop-interval10.png` });
  await page.mouse.up();
  await expect
    .poll(() => startAtMs(fixture.bookings.bs), { timeout: LOAD_TIMEOUT })
    .toBe(taipeiMs("13:40"));
  expect(((await startAtMs(fixture.bookings.bs)) / 60_000) % 10).toBe(0);
  expect(CUSTOMER_BS).toBeTruthy();

  // 拖拉後不會有任何客戶(member)目標的 LINE 記錄。
  await page.waitForTimeout(2000);
  const memberLogsAfter = await svc
    .from("line_notification_log")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId)
    .eq("target_type", "member");
  expect(memberLogsAfter.count ?? 0).toBe(memberLogsBefore.count ?? 0);
  expect(memberLogsAfter.count ?? 0).toBe(0);
  expectOnlyLocalRequests(recorder);
});

test("G3(商家端)建單時間間隔 10 ⇒ 拖到格子中間落在 09:40", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const grid = await openMerchantGrid(page);
  const block = page.getByTestId(`booking-block-${fixture.bookings.bm}-main`);
  await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(block).toContainText(CUSTOMER_BM);
  await block.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const box = (await block.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12);
  await expect(grid).toHaveAttribute("data-drag-phase", "dragging");
  await page.mouse.move(start.x, start.y + 41, { steps: 8 });
  await expect(page.getByTestId("booking-drag-hint")).toHaveText("改時間 → 09:40");
  await page.screenshot({ path: `${SHOT_DIR}/merchant-drag-desktop-interval10.png` });
  await page.mouse.up();
  await expect(grid).toHaveAttribute("data-drag-phase", "idle", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() => startAtMs(fixture.bookings.bm), { timeout: LOAD_TIMEOUT })
    .toBe(taipeiMs("09:40"));
  expectOnlyLocalRequests(recorder);
});

test("G3(375 寬)服務人員端拖拉中截圖:提示顯示吸附後的真實時間", async ({ browser }) => {
  const { context, page } = await mobilePage(browser);
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page);
  const block = page.getByTestId(`booking-block-${fixture.bookings.bs}-main`);
  await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + 6 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 12);
  await page.mouse.move(start.x, start.y + 21, { steps: 6 }); // 13:40 + 21 分 ⇒ 14:01 ⇒ 14:00
  await expect(page.getByTestId("booking-drag-hint")).toHaveText("改時間 → 14:00");
  await page.screenshot({ path: `${SHOT_DIR}/staff-drag-375-interval10.png` });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectNoHorizontalOverflow(page);
  expectOnlyLocalRequests(recorder);
  await context.close();
});

test("G4 服務項目頁新增有描述的項目 → 選擇項目整頁看得到描述(商家端、服務人員端)", async ({
  page,
  browser,
}) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/service-items");
  await page.getByRole("button", { name: "新增服務項目" }).first().click({ timeout: LOAD_TIMEOUT });
  const layer = page.getByRole("dialog");
  await layer.locator("#item-name").fill(NEW_ITEM_NAME);
  await layer.locator("#item-price").fill("800");
  await layer.locator("#item-duration").fill("30");
  await layer.locator("#item-description").fill(NEW_ITEM_DESCRIPTION);
  await expect(layer.getByText(`${Array.from(NEW_ITEM_DESCRIPTION).length} / 200`)).toBeVisible();
  await layer.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByText("已新增服務項目")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const row = await serviceClient()
    .from("service_items")
    .select("id,description")
    .eq("merchant_id", fixture.merchantId)
    .eq("name", NEW_ITEM_NAME)
    .single();
  const newItem = row.data as { id: string; description: string };
  expect(newItem.description).toBe(NEW_ITEM_DESCRIPTION);
  await expect(page.getByTestId(`service-item-description-${newItem.id}`)).toBeVisible();

  // 商家端:行事曆「新增預約」→ 選擇項目整頁。
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page.getByRole("button", { name: "新增預約" }).first().click({ timeout: LOAD_TIMEOUT });
  await page.getByRole("dialog").locator("#booking-service-items").click({ timeout: LOAD_TIMEOUT });
  const merchantPicker = page.getByTestId("service-item-picker");
  await expect(merchantPicker.getByTestId(`picker-item-description-${newItem.id}`)).toContainText(
    "含清洗與檢查",
  );
  // 沒有描述的項目不留空白。
  await expect(
    merchantPicker.getByTestId(`picker-item-description-${fixture.serviceItemId}`),
  ).toHaveCount(0);
  expectOnlyLocalRequests(recorder);

  // 服務人員端(375 寬順便看不爆版)。
  const { context, page: staffPage } = await mobilePage(browser);
  const staffRecorder = recordRequestHosts(staffPage);
  await openStaffTimeline(staffPage);
  await staffPage.getByRole("button", { name: /^18:00 (可預約|不可預約)$/ }).click();
  await staffPage.getByRole("menuitem", { name: "新增預約" }).click();
  await staffPage
    .getByRole("dialog")
    .locator("#booking-service-items")
    .click({ timeout: LOAD_TIMEOUT });
  const staffPicker = staffPage.getByTestId("service-item-picker");
  await expect(staffPicker.getByTestId(`picker-item-description-${newItem.id}`)).toContainText(
    "約需 30 分鐘",
  );
  await expectNoHorizontalOverflow(staffPage);
  await staffPage.screenshot({ path: `${SHOT_DIR}/picker-description-375.png` });
  expectOnlyLocalRequests(staffRecorder);
  await context.close();
});

test("G5 服務人員確認接單 → 有訂單管理的客服鈴鐺看得到;沒有的客服看不到", async ({ browser }) => {
  const confirm = await fixture.staff.client.rpc("staff_confirm_booking", {
    p_booking_id: fixture.bookings.bc,
  });
  expect(confirm.error).toBeNull();

  for (const [agent, shouldSee] of [
    [fixture.agentO, true],
    [fixture.agentN, false],
  ] as const) {
    const context = await browser.newContext({ timezoneId: "Asia/Taipei" });
    const page = await context.newPage();
    const recorder = recordRequestHosts(page);
    await injectSession(page, agent.session);
    await page.goto("/app");
    await page.getByTestId("notification-bell").click({ timeout: LOAD_TIMEOUT });
    const row = page.getByTestId("notification-row").filter({ hasText: "服務人員確認接單時" });
    if (shouldSee) {
      await expect(row).toHaveCount(1, { timeout: LOAD_TIMEOUT });
      await expect(row).toContainText(fixture.staff.name);
      await expect(row).toContainText(CUSTOMER_BC);
      await row.click();
      await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
    } else {
      await page.waitForTimeout(1500);
      await expect(row).toHaveCount(0);
    }
    expectOnlyLocalRequests(recorder);
    await context.close();
  }
});

test("G6 375 寬:服務項目頁描述欄、超級管理員頁(標點改過)不爆版", async ({ browser }) => {
  const { context, page } = await mobilePage(browser);
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/service-items");
  await page.getByRole("button", { name: "新增服務項目" }).first().click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog").locator("#item-description")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `${SHOT_DIR}/service-item-form-375.png`, fullPage: true });
  expectOnlyLocalRequests(recorder);
  await context.close();

  const p2 = await mobilePage(browser);
  const r2 = recordRequestHosts(p2.page);
  await injectSession(p2.page, fixture.platform.session);
  await p2.page.goto("/platform-admin");
  await expect(p2.page.getByText(/系統裡所有的集團與商家，可以篩選/)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expectNoHorizontalOverflow(p2.page);
  await p2.page.screenshot({ path: `${SHOT_DIR}/platform-overview-375.png`, fullPage: true });
  await p2.page.goto(`/platform-admin/merchants/${fixture.merchantId}`);
  await expect(p2.page.getByText(/唯讀。這間店目前登記的服務人員。/)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expectNoHorizontalOverflow(p2.page);
  await p2.page.screenshot({
    path: `${SHOT_DIR}/platform-merchant-detail-375.png`,
    fullPage: true,
  });
  expectOnlyLocalRequests(r2);
  await p2.context.close();
});
