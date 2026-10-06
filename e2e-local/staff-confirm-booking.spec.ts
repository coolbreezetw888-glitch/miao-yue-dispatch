// 「服務人員接單確認 第 4 批」(#977)本機 e2e。
// 規格書:.project/specs/服務人員接單確認-第4批.md 第六節(e2e-local)。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
//   E1 服務人員:月曆今天的格子兩色數字(待確認 2、已確認 1);鈴鐺紅點 2、清單頂端「你有 2 筆訂單待確認」,
//      點了到我的行事曆;打開 10:00 那張 ⇒「確認接單」⇒ 成功提示、詳情變「已確認」、按鈕消失;
//      不重新整理,月曆數字立刻變成待確認 1、已確認 2,鈴鐺紅點變 1;資料庫操作紀錄是服務人員本人
//   E2 商家管理員:鈴鐺看到「服務人員確認接單時」那一則(含服務人員與客戶姓名),點了到訂單管理
//   E3 管理員在後台建單指派給開了「商家後台確認後直接接單」的服務人員 ⇒ 成功提示「已送出訂單（已確認）」、
//      資料庫狀態 accepted;表單說明是新文字
//   E4 手機 375 寬:月曆日期格兩顆數字在同一列、不超出格子;一位數(1 / 2)與兩位數(12 / 10)各一組(截圖存 test-results)
import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  addTodayBookings,
  CUSTOMER_CONFIRM,
  injectSession,
  ITEM_NAME,
  serviceClient,
  setupStaffConfirmFixture,
  teardownStaffConfirmFixture,
  type StaffConfirmFixture,
} from "./support/staff-confirm-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial" });

let fixture: StaffConfirmFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupStaffConfirmFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownStaffConfirmFixture(fixture);
  console.log("[接單確認第4批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

/** 月曆格線裡「今天」那一格(MyCalendarPage 的格子帶 data-date-key)。 */
function todayCell(page: Page) {
  return page.locator(`button[data-date-key="${fixture.dateKey}"]`);
}

async function openStaffCalendar(page: Page) {
  await injectSession(page, fixture.staffSession);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(CUSTOMER_CONFIRM, { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

test("E1 服務人員:兩色數字、鈴鐺待確認提醒、確認接單後立即更新", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffCalendar(page);

  const cell = todayCell(page);
  await expect(cell.getByTestId("day-pending-count")).toHaveText("2");
  await expect(cell.getByTestId("day-accepted-count")).toHaveText("1");

  // 鈴鐺:紅點 = 2(沒有未讀通知,只有待確認提醒)
  await expect(page.getByTestId("notification-unread-badge")).toHaveText("2");
  await page.getByTestId("notification-bell").click();
  const reminder = page.getByTestId("notification-staff-pending-reminder");
  await expect(reminder).toContainText("你有 2 筆訂單待確認");
  await reminder.click();
  await expect(page).toHaveURL(/\/app\/calendar$/);

  // 打開 10:00 那張 ⇒ 確認接單
  await page.getByText(CUSTOMER_CONFIRM, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog.getByText("待確認", { exact: true })).toBeVisible();
  await dialog.getByTestId("staff-confirm-booking-button").click();
  await expect(page.getByText("已確認接單")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog.getByText("已確認", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog.getByTestId("staff-confirm-booking-button")).toHaveCount(0);
  await dialog.getByRole("contentinfo").getByRole("button", { name: "關閉" }).click();

  // 不重新整理:數字立刻更新
  await expect(cell.getByTestId("day-pending-count")).toHaveText("1", { timeout: LOAD_TIMEOUT });
  await expect(cell.getByTestId("day-accepted-count")).toHaveText("2");
  await expect(page.getByTestId("notification-unread-badge")).toHaveText("1", {
    timeout: LOAD_TIMEOUT,
  });

  // 資料庫:狀態 accepted、操作紀錄是服務人員本人
  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("status")
    .eq("id", fixture.bookingToConfirmId)
    .single();
  expect(b.data?.status).toBe("accepted");
  const log = await svc
    .from("booking_status_change_logs")
    .select("from_status,to_status,actor_role_snapshot,actor_name_snapshot")
    .eq("booking_id", fixture.bookingToConfirmId)
    .eq("to_status", "accepted")
    .single();
  expect(log.data).toEqual({
    from_status: "pending_confirmation",
    to_status: "accepted",
    actor_role_snapshot: "staff",
    actor_name_snapshot: fixture.staffName,
  });
  expectOnlyLocalRequests(recorder);
});

test("E2 商家管理員:鈴鐺看到服務人員確認接單的通知,點了到訂單管理", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await expect(page.getByTestId("notification-unread-badge")).toHaveText("1", {
    timeout: LOAD_TIMEOUT,
  });
  await page.getByTestId("notification-bell").click();
  const row = page.getByTestId("notification-row").filter({ hasText: "服務人員確認接單時" });
  await expect(row).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(row).toContainText(fixture.staffName);
  await expect(row).toContainText(CUSTOMER_CONFIRM);
  // 管理員視角沒有待確認提醒
  await expect(page.getByTestId("notification-staff-pending-reminder")).toHaveCount(0);
  await row.click();
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
  expectOnlyLocalRequests(recorder);
});

test("E3 後台建單指派給開了「商家後台確認後直接接單」的服務人員 ⇒ 直接是已確認", async ({
  page,
}) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(`/app/calendar?date=${fixture.tomorrowKey}`);
  await page.getByRole("button", { name: "新增預約" }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(
    dialog.getByText(
      "建立後的狀態依服務人員設定：需要服務人員確認的是「待確認」，設定「商家後台確認後直接接單」的會直接是「已確認」。",
    ),
  ).toBeVisible();
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: fixture.directStaffName }).click();

  await dialog.locator("#booking-service-items").click();
  const picker = dialog.getByTestId("service-item-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("checkbox", { name: new RegExp(ITEM_NAME) }).click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(dialog.locator("#booking-datetime")).toContainText("10:00");

  const customer = `E2E第4批直接接單客戶${fixture.runId}`;
  await dialog.locator("#booking-customer-name").fill(customer);
  await dialog.locator("#booking-customer-phone").fill("0912000977");
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByText("已送出訂單（已確認）")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const b = await serviceClient()
    .from("bookings")
    .select("id,status,staff_id")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", customer)
    .single();
  expect(b.error).toBeNull();
  expect(b.data).toMatchObject({ status: "accepted", staff_id: fixture.directStaffId });
  const log = await serviceClient()
    .from("booking_status_change_logs")
    .select("from_status,to_status")
    .eq("booking_id", b.data!.id);
  expect(log.data).toEqual([{ from_status: null, to_status: "accepted" }]);
  expectOnlyLocalRequests(recorder);
});

/** 375 寬:兩顆數字同一列、左右不重疊、都在格子裡面,整頁沒有橫向捲動。 */
async function expectBadgesFit(page: Page, pendingText: string, acceptedText: string) {
  const cell = todayCell(page);
  const pending = cell.getByTestId("day-pending-count");
  const accepted = cell.getByTestId("day-accepted-count");
  await expect(pending).toHaveText(pendingText, { timeout: LOAD_TIMEOUT });
  await expect(accepted).toHaveText(acceptedText, { timeout: LOAD_TIMEOUT });

  const [cellBox, pBox, aBox] = await Promise.all([
    cell.boundingBox(),
    pending.boundingBox(),
    accepted.boundingBox(),
  ]);
  expect(cellBox && pBox && aBox).toBeTruthy();
  // 同一列(上緣差不到 2px)、左右排列且不重疊
  expect(Math.abs(pBox!.y - aBox!.y)).toBeLessThan(2);
  expect(aBox!.x).toBeGreaterThanOrEqual(pBox!.x + pBox!.width);
  // 兩顆都在格子裡面(扣掉格子 1px 邊框)
  for (const box of [pBox!, aBox!]) {
    expect(box.x).toBeGreaterThanOrEqual(cellBox!.x + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(cellBox!.y + cellBox!.height - 1);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("E4 手機 375 寬:月曆日期格兩顆數字在同一列、不超出格子(一位數與兩位數)", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const recorder = recordRequestHosts(page);
  try {
    await openStaffCalendar(page);
    // 一位數(E1 之後:待確認 1、已確認 2)
    await expectBadgesFit(page, "1", "2");
    await page.screenshot({
      path: test.info().outputPath("staff-calendar-375-two-color-counts.png"),
      fullPage: false,
    });

    // 兩位數:今天再加 11 張待確認、8 張已確認 ⇒ 待確認 12、已確認 10
    await addTodayBookings(
      fixture,
      [
        "00:00",
        "01:00",
        "02:00",
        "03:00",
        "04:00",
        "05:00",
        "06:00",
        "07:00",
        "08:00",
        "09:00",
        "11:00",
      ],
      false,
    );
    await addTodayBookings(
      fixture,
      ["12:00", "13:00", "15:00", "17:00", "18:00", "19:00", "20:00", "21:00"],
      true,
    );
    await page.reload();
    await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expectBadgesFit(page, "12", "10");
    await page.screenshot({
      path: test.info().outputPath("staff-calendar-375-two-digit-counts.png"),
      fullPage: false,
    });
    expectOnlyLocalRequests(recorder);
  } finally {
    await context.close();
  }
});
