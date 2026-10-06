// 「商家端行事曆月曆日期格兩色數字」(#984)本機 e2e。
// 規格書:.project/specs/商家端月曆兩色數字.md 第三節(e2e-local)。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
// 沿用 #977 第 4 批的 fixture(staff-confirm-fixture:一間商家、服務人員 S 與 D),再加三張單:
//   12:00 D 主要 + S 協助(D 開了「商家後台確認後直接接單」⇒ 已確認)— 兩位都在時間軸上,只能算一次
//   18:00 D 主要,已確認後標記完成 — 不算
//   19:00 S 主要,取消 — 不算
// 所以今天一開始:待確認 2(S 10:00、16:00)、已確認 2(S 14:00、D+S 12:00)。
//
//   M1 管理員:月曆今天的格子出現兩色數字 2 / 2,原本的藍點不在;打開 10:00 那張「確認訂單」⇒
//      不重新整理,數字變成 1 / 3;沒有預約的格子什麼數字都沒有
//   M2 手機 375 寬:兩位數(12 / 10)兩顆在同一列、不超出格子、整頁不橫向捲動(截圖存 test-results)
import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  addTodayBookings,
  CUSTOMER_CONFIRM,
  injectSession,
  serviceClient,
  setupStaffConfirmFixture,
  teardownStaffConfirmFixture,
  type StaffConfirmFixture,
} from "./support/staff-confirm-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial" });

let fixture: StaffConfirmFixture;
let setupFailed = false;

async function createBooking(
  f: StaffConfirmFixture,
  staffId: string,
  time: string,
  customer: string,
  phoneSuffix: number,
  assistantIds: string[] = [],
): Promise<{ id: string; status: string }> {
  const r = await f.admin.rpc("create_booking", {
    p_merchant_id: f.merchantId,
    p_staff_id: staffId,
    p_service_items: [{ service_item_id: f.serviceItemId, quantity: 1, unit_price: 1500 }],
    p_start_at: buildTaipeiIso(f.dateKey, time),
    p_customer_name: customer,
    p_customer_phone: `09${String((Number(f.runId.slice(-6)) * 100 + 90 + phoneSuffix) % 100_000_000).padStart(8, "0")}`,
    p_payment_method_id: f.paymentMethodId,
    p_assistant_staff_ids: assistantIds,
  });
  if (r.error || !r.data) throw new Error(`建立預約 ${time} 失敗:${r.error?.message}`);
  return r.data as { id: string; status: string };
}

test.beforeAll(async () => {
  try {
    fixture = await setupStaffConfirmFixture();
    // 12:00 D 主要 + S 協助 ⇒ 已確認(D 直接接單)
    const shared = await createBooking(
      fixture,
      fixture.directStaffId,
      "12:00",
      "E2E984協助共用客戶",
      1,
      [fixture.staffId],
    );
    if (shared.status !== "accepted")
      throw new Error(`fixture 前提不成立:12:00 應為已確認,實際 ${shared.status}`);
    // 18:00 D 主要 ⇒ 已確認 ⇒ 標記完成
    const done = await createBooking(
      fixture,
      fixture.directStaffId,
      "18:00",
      "E2E984已完成客戶",
      2,
    );
    const c = await fixture.admin.rpc("complete_booking", { p_booking_id: done.id });
    if (c.error) throw new Error(`標記完成失敗:${c.error.message}`);
    // 19:00 S 主要 ⇒ 取消
    const cancelled = await createBooking(fixture, fixture.staffId, "19:00", "E2E984已取消客戶", 3);
    const x = await fixture.admin.rpc("cancel_booking", { p_booking_id: cancelled.id });
    if (x.error) throw new Error(`取消失敗:${x.error.message}`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (!fixture) return;
  const actions = await teardownStaffConfirmFixture(fixture);
  console.log(
    "[#984 商家端月曆兩色數字] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
  void setupFailed;
});

/** 商家端月曆格線裡「今天」那一格(CalendarPage 月檢視的格子帶 data-month-date-key)。 */
function todayCell(page: Page) {
  return page.locator(`button[data-month-date-key="${fixture.dateKey}"]`);
}

async function openMerchantCalendar(page: Page) {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await expect(todayCell(page)).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test("M1 管理員:月曆兩色數字(協助人員不重複、已完成/取消不算),確認一筆後立即變化", async ({
  page,
}) => {
  const recorder = recordRequestHosts(page);
  await openMerchantCalendar(page);

  const cell = todayCell(page);
  await expect(cell.getByTestId("day-pending-count")).toHaveText("2", { timeout: LOAD_TIMEOUT });
  await expect(cell.getByTestId("day-accepted-count")).toHaveText("2");
  await expect(cell.getByTestId("day-pending-count")).toHaveAttribute("aria-label", "待確認 2 筆");
  // 原本的藍點拿掉(不跟數字同時出現)
  await expect(cell.locator(".bg-brand.rounded-full")).toHaveCount(0);
  // 其他沒有預約的格子沒有數字(只有今天這一格有)
  await expect(page.locator("[data-month-date-key] [data-testid=day-pending-count]")).toHaveCount(
    1,
  );
  await expect(page.locator("[data-month-date-key] [data-testid=day-accepted-count]")).toHaveCount(
    1,
  );

  // 時間軸打開 10:00 那張 ⇒ 確認訂單
  await page.getByText(CUSTOMER_CONFIRM, { exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "確認訂單" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await dialog.getByRole("button", { name: "確認訂單" }).click();
  await expect(page.getByText("已確認訂單")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 不重新整理:數字跟著變
  await expect(cell.getByTestId("day-pending-count")).toHaveText("1", { timeout: LOAD_TIMEOUT });
  await expect(cell.getByTestId("day-accepted-count")).toHaveText("3");

  const b = await serviceClient()
    .from("bookings")
    .select("status")
    .eq("id", fixture.bookingToConfirmId)
    .single();
  expect(b.data?.status).toBe("accepted");
  expectOnlyLocalRequests(recorder);
});

test("M2 手機 375 寬:兩位數(12 / 10)兩顆在同一列、不超出格子", async ({ browser }) => {
  // M1 之後:待確認 1、已確認 3 ⇒ 再加 11 張待確認、7 張已確認 ⇒ 12 / 10
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
    ["13:00", "15:00", "17:00", "18:00", "20:00", "21:00", "22:00"],
    true,
  );

  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const recorder = recordRequestHosts(page);
  try {
    await openMerchantCalendar(page);
    const cell = todayCell(page);
    const pending = cell.getByTestId("day-pending-count");
    const accepted = cell.getByTestId("day-accepted-count");
    await expect(pending).toHaveText("12", { timeout: LOAD_TIMEOUT });
    await expect(accepted).toHaveText("10", { timeout: LOAD_TIMEOUT });

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
    // 同一排的格子一樣高(沒有數字的格子也預留同樣高度)
    const rowHeights = await page.evaluate((key) => {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-month-date-key]"));
      const idx = cells.findIndex((c) => c.dataset["monthDateKey"] === key);
      const rowStart = idx - (idx % 7);
      return cells
        .slice(rowStart, rowStart + 7)
        .map((c) => Math.round(c.getBoundingClientRect().height));
    }, fixture.dateKey);
    expect(new Set(rowHeights).size).toBe(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await cell.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("merchant-calendar-375-two-digit-counts.png"),
      fullPage: false,
    });
    expectOnlyLocalRequests(recorder);
  } finally {
    await context.close();
  }
});
