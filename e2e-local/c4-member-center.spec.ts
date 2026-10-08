// 客戶端第 4 批 4-A 本機 e2e:會員中心、我的預約、自己取消、錢包、我的資料、完成頁新文案、後台取消期限設定。
// 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(🔴 零之零優先);介面 .project/notes/c4-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c4-member-center`
// LINE 登入 / Edge Function(送出、取消)用 page.route 模擬,資料庫全部是本機真的。
// 截圖:E2E_SHOT_DIR(預設 ../.project/notes/c4-shots),1280 / 375 各一(C4-J02 屬於 4-A 的畫面)。
//
// 涵蓋(規格 T 表 4-A 部分):
//   C4-B01 ① 會員中心入口(有 / 沒有 LINE 登入的店)、C4-B02 登入頁 / 沒有開放、C4-B03 登入後一律到 /me(新客人 / 已接上)、
//   C4-C02 首頁(有 / 沒有預約)、C4-C04 / D06 我的預約 → 取消 → 歷史;後台訂單已取消 + 操作紀錄「客人」+ 鈴鐺(C4-D04)、
//   C4-D01 期限過了沒有取消鈕、C4-W 錢包(紅利開 / 關;店家內部說明不外洩)、C4-E02 / E03 我的資料(生日鎖定)、
//   C4-A04 後台改地址 ⇒ 客人看到同一個值、C4-E05 預約時自動帶地址、C4-B04 ⑦-1 / ⑦-2 / ⑦-3 新文案、C4-K01 後台取消期限設定、
//   C4-F02 會員中心回應原文搜不到哨兵、沒有 _internal。
import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  injectSession,
  ITEM_INDOOR,
  SENTINELS,
  serviceClient,
  SHOP_A_NAME,
  STAFF_MING,
} from "./support/c1-public-booking-fixture";
import {
  createCustomerSession,
  mockLineLogin,
  newLineSub,
  testPhone,
} from "./support/c2-line-login-fixture";
import { injectCustomerSession, LOAD_TIMEOUT, walkToForm } from "./support/c3-flow";
import {
  mockBookingSubmit,
  mockTurnstile,
  setupC3Fixture,
  teardownC3Fixture,
  type C3Fixture,
} from "./support/c3-submit-fixture";
import {
  collectMemberResponses,
  createMemberBooking,
  linkCustomerToMember,
  mockBookingCancel,
} from "./support/c4-member-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "../.project/notes/c4-shots";
const MEMBER_NAME = "會員王小明";
const LINE_NAME = "王小明的 LINE";
/** C4-F02 哨兵:店家手打的點數說明(客人不能看到)。 */
const POINT_NOTE_SENTINEL = "SENTINEL_POINT_NOTE_C4";
const ADDRESS_FROM_BACKEND = "新北市板橋區文化路一段 100 號";

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
const SUB = newLineSub();
let memberId = "";
let booking1 = "";
let booking2 = "";
let bookingDate = "";

function plusDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isSunday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
}

/** 1280 + 375 各一張(先把視窗拉到整頁高度再截,固定頁首 / 底部選單才不會蓋住內容)。 */
async function shot(page: Page, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(250);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(h, width === 375 ? 812 : 900) });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** 確認窗開著時截圖(不拉長視窗,避免視窗位置跳動)。 */
async function shotDialog(page: Page, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(SHOT_DIR, { recursive: true });
  try {
    fixture = await setupC3Fixture();
    const c1 = fixture.c2.c1;
    bookingDate = plusDays(c1.dateLeave, 1);
    while (isSunday(bookingDate)) bookingDate = plusDays(bookingDate, 1);
    const item = await serviceClient()
      .from("service_items")
      .select("id")
      .eq("merchant_id", c1.merchantAId)
      .eq("name", ITEM_INDOOR)
      .single();
    const itemId = item.data!.id as string;

    const session = await createCustomerSession(fixture.c2, SUB, LINE_NAME);
    memberId = await linkCustomerToMember({
      session,
      slug: c1.slugA,
      merchantId: c1.merchantAId,
      phone: testPhone(fixture.c2, 71),
      name: MEMBER_NAME,
    });
    const base = {
      slug: c1.slugA,
      userId: session.user.id,
      itemId,
      staffId: c1.staffMingId,
      date: bookingDate,
      name: MEMBER_NAME,
    };
    booking1 = await createMemberBooking({ ...base, time: "10:00" });
    booking2 = await createMemberBooking({ ...base, time: "15:00" });
    // 店家手動加點(note = 哨兵,客人看不到)
    const adj = await c1.admin.rpc("adjust_member_points", {
      p_member_id: memberId,
      p_note: POINT_NOTE_SENTINEL,
      p_points_delta: 200,
    });
    if (adj.error) throw new Error(`加點失敗:${adj.error.message}`);
    console.log(`[c4 本機] fixture 建好(A=${c1.slugA},預約日 ${bookingDate})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(300_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC3Fixture(fixture);
  console.log("[c4 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

/** 帶著「已接上會員」的客人登入狀態(每次新的一份,避免 refresh token 被別頁用掉)。 */
async function asMember(page: Page): Promise<void> {
  const session = await createCustomerSession(fixture.c2, SUB, LINE_NAME);
  await injectCustomerSession(page, fixture.c2.c1.slugA, session);
}

async function asAdmin(page: Page): Promise<void> {
  await injectSession(page, fixture.c2.c1.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
}

async function setCancelDeadline(hours: number): Promise<void> {
  const r = await fixture.c2.c1.admin
    .from("merchant_booking_settings")
    .upsert(
      { merchant_id: fixture.c2.c1.merchantAId, customer_cancel_deadline_hours: hours } as never,
      { onConflict: "merchant_id" },
    );
  expect(r.error).toBeNull();
}

test("C4-B01 / B02:有 LINE 登入的店 ① 右上「會員登入」⇒ 會員中心登入頁;沒有 LINE 登入的店沒有入口、/me 沒有開放", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await page.goto(`/booking/${c1.slugA}`);
  const entry = page.getByTestId("public-booking-member-entry");
  await expect(entry).toHaveText("會員登入", { timeout: LOAD_TIMEOUT });
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/booking/${c1.slugA}/me$`));
  const login = page.getByTestId("member-center-login");
  await expect(login).toContainText(`登入「${SHOP_A_NAME}」會員中心`, { timeout: LOAD_TIMEOUT });
  await expect(login).toContainText("用 LINE 登入就能查看預約、取消預約、查看紅利點數。");
  await shot(page, "c4-01-login");

  await page.goto(`/booking/${c1.slugB}`);
  await expect(page.getByTestId("public-booking-start")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("public-booking-member-entry")).toHaveCount(0);
  await page.goto(`/booking/${c1.slugB}/me`);
  await expect(page.getByTestId("member-center-closed")).toContainText(
    "這間店目前沒有開放會員中心",
    { timeout: LOAD_TIMEOUT },
  );
  await shot(page, "c4-02-closed");
});

test("C4-B03:新客人從會員中心用 LINE 登入 ⇒ ⑥-2「加入會員」⇒ 會員中心首頁(沒有預約)+「已加入」", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  const login = await mockLineLogin(page, fixture.c2, {
    sub: newLineSub(),
    displayName: "新客人的 LINE",
  });
  await page.goto(`/booking/${c1.slugA}/me/bookings`);
  await page.getByTestId("member-center-login-button").click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(login.startBodies[0]).toMatchObject({ action: "start", purpose: "join" });
  expect(login.startBodies[0]!["draft"] ?? null).toBeNull();
  await expect(page.getByTestId("customer-profile-submit")).toHaveText("加入會員");
  await page.locator("#customer-profile-phone").fill(testPhone(fixture.c2, 72));
  await page.getByTestId("customer-profile-consent").click();
  await page.getByTestId("customer-profile-submit").click();
  await expect(page.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page).toHaveURL(new RegExp(`/booking/${c1.slugA}/me$`));
  await expect(page.getByText(`已加入「${SHOP_A_NAME}」會員`)).toBeVisible();
  await expect(page.getByTestId("member-home-empty")).toContainText("目前沒有即將到來的預約");
  await expect(page.getByText("LINE 通知")).toHaveCount(0);
  await page.waitForTimeout(4500); // 等提示消失再截圖
  await shot(page, "c4-03-home-empty");
});

test("C4-B03 / C02:已接上的客人登入 ⇒ /me +「已登入」;首頁最新的預約;① 入口變「會員中心」", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await mockLineLogin(page, fixture.c2, { sub: SUB, displayName: LINE_NAME });
  await page.goto(`/booking/${c1.slugA}/me`);
  await page.getByTestId("member-center-login-button").click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-home-greeting")).toHaveText(`${MEMBER_NAME}，你好`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText(`已登入「${SHOP_A_NAME}」會員中心`)).toBeVisible();
  const next = page.getByTestId("member-home-next");
  await expect(next).toContainText("最新的預約");
  await expect(next).toContainText("待確認");
  await expect(next).toContainText("室內機清洗 ×2");
  await expect(page.getByTestId("member-home-missing")).toContainText("補上生日、地址和 Email");
  await expect(page.getByTestId("member-center-nav")).toContainText("錢包");
  await page.waitForTimeout(4500);
  await shot(page, "c4-04-home");

  await page.getByTestId("member-center-book-link").click();
  // 頭像小圓(沒有 LINE 頭像時顯示名字縮寫)+「會員中心」
  await expect(page.getByTestId("public-booking-member-entry")).toContainText("會員中心", {
    timeout: LOAD_TIMEOUT,
  });
  await shot(page, "c4-05-booking-home-entry");
});

test("C4-C04 / D06 / D04:我的預約 ⇒ 取消 ⇒ 歷史;後台訂單已取消、操作紀錄「客人」、鈴鐺;回應不洩漏", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asMember(page);
  const cancel = await mockBookingCancel(page);
  const bodies = collectMemberResponses(page);
  await page.goto(`/booking/${c1.slugA}/me/bookings`);
  const cards = page.getByTestId("member-booking-card");
  await expect(cards).toHaveCount(2, { timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-bookings-tab-upcoming")).toContainText("2");
  await expect(cards.first().getByTestId("member-booking-deadline")).toContainText("以前可以取消");
  await expect(cards.first()).toContainText(STAFF_MING);
  await expect(cards.first()).toContainText("預約時間為預計抵達時間");
  await shot(page, "c4-06-bookings-upcoming");

  await cards.first().getByTestId("member-booking-cancel").click();
  const dialog = page.getByTestId("member-cancel-dialog");
  await expect(dialog).toContainText("的預約嗎？");
  await expect(dialog).toContainText(
    "取消後這個時段會開放給其他人預約，店家也會收到通知。想改時間的話，請取消後重新預約。",
  );
  await shotDialog(page, "c4-07-cancel-dialog");
  await dialog.getByTestId("member-cancel-confirm").click();
  await expect(page.getByText("已取消預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(cards).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await page.getByTestId("member-bookings-tab-history").click();
  await expect(page).toHaveURL(/\?tab=history$/);
  await expect(cards).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(cards.first()).toHaveAttribute("data-status", "cancelled");
  await expect(cards.first().getByTestId("member-booking-time")).toContainText("年");
  await page.waitForTimeout(4000);
  await shot(page, "c4-08-bookings-history");

  // 資料庫:訂單 / 操作紀錄 / 鈴鐺
  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("status,cancelled_reason")
    .eq("id", booking1)
    .single();
  expect(b.data).toEqual({ status: "cancelled", cancelled_reason: "客人線上取消" });
  const log = await svc
    .from("booking_status_change_logs")
    .select("to_status,actor_role_snapshot,actor_name_snapshot")
    .eq("booking_id", booking1)
    .eq("to_status", "cancelled")
    .single();
  expect(log.data).toMatchObject({
    actor_role_snapshot: "customer",
    actor_name_snapshot: `客人 ${MEMBER_NAME}`,
  });
  const bell = await svc
    .from("user_notifications")
    .select("id,target_type")
    .eq("booking_id", booking1)
    .eq("event_type", "customer_booking_cancelled");
  expect((bell.data ?? []).length).toBeGreaterThanOrEqual(1);
  expect(cancel.requests).toEqual([{ slug: c1.slugA, booking_id: booking1 }]);

  // C4-F02:回應原文不洩漏
  await expect.poll(() => bodies.length).toBeGreaterThan(1);
  const raw = bodies.join("\n") + cancel.responseBodies.join("\n");
  expect(raw).not.toContain("_internal");
  for (const s of [SENTINELS.staffRealName, SENTINELS.staffPhone, POINT_NOTE_SENTINEL, memberId]) {
    expect(raw).not.toContain(s);
  }
});

test("C4-D04:管理員鈴鐺「客人線上取消預約時」內文;點了到訂單管理;訂單詳細顯示取消原因", async ({
  page,
}) => {
  track(page);
  await asAdmin(page);
  await page.getByTestId("notification-bell").click();
  const row = page.getByTestId("notification-row").filter({ hasText: "客人線上取消預約時" });
  await expect(row).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(row).toContainText(`客人「${MEMBER_NAME}」取消了`);
  await expect(row).toContainText("的預約，服務人員：");
  await shot(page, "c4-09-bell-cancelled");
  await row.click();
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });

  // C4-D07:訂單詳細看得到「取消原因：客人線上取消」
  const search = page.getByLabel("搜尋訂單");
  await expect(search).toBeVisible({ timeout: LOAD_TIMEOUT });
  await search.fill(MEMBER_NAME);
  const cancelledCard = page
    .locator('[role="button"]')
    .filter({ hasText: MEMBER_NAME })
    .filter({ hasText: "已取消" });
  await expect(cancelledCard).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await cancelledCard.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByTestId("booking-cancel-reason")).toHaveText("取消原因：客人線上取消", {
    timeout: LOAD_TIMEOUT,
  });
  // 主腦 2026-10-09 裁決:「最後修改」是客人帳號 ⇒ 顯示「客人」,不是「(已移除的人員)」
  await expect(detail.getByText("最後修改")).toBeVisible();
  await expect(detail).toContainText("客人 ・");
  await expect(detail.getByText("(已移除的人員)")).toHaveCount(0);
  await shotDialog(page, "c4-20-backend-cancel-reason");
});

test("C4-D01:取消期限設成 168 小時 ⇒ 沒有取消鈕,改成聯絡店家", async ({ page }) => {
  track(page);
  await setCancelDeadline(168);
  try {
    await asMember(page);
    await page.goto(`/booking/${fixture.c2.c1.slugA}/me/bookings`);
    const card = page.getByTestId("member-booking-card");
    await expect(card).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(card.getByTestId("member-booking-no-cancel")).toHaveText(
      "服務前 168 小時內不能線上取消，請直接聯絡店家",
    );
    await expect(card.getByTestId("member-booking-cancel")).toHaveCount(0);
    await expect(card.getByTestId("public-booking-contacts")).toBeVisible();
    await shot(page, "c4-10-bookings-deadline-passed");
  } finally {
    await setCancelDeadline(24);
  }
  const b2 = await serviceClient().from("bookings").select("status").eq("id", booking2).single();
  expect(b2.data?.status).toBe("pending_confirmation");
});

test("C4-W01~W03:錢包(紅利開)餘額 + 明細、店家說明不外洩;紅利關 ⇒ 底部沒有錢包、/me/wallet 回 /me", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asMember(page);
  const bodies = collectMemberResponses(page);
  await page.goto(`/booking/${c1.slugA}/me/wallet`);
  await expect(page.getByTestId("member-wallet-balance")).toHaveText("200", {
    timeout: LOAD_TIMEOUT,
  });
  const entry = page.getByTestId("member-wallet-entry").first();
  await expect(entry).toContainText("店家調整");
  await expect(entry).toContainText("+200");
  await expect(page.getByTestId("member-wallet-points")).toContainText(
    "結帳時告訴店家要使用點數，就能折抵消費。",
  );
  await shot(page, "c4-11-wallet");
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  expect(bodies.join("\n")).not.toContain(POINT_NOTE_SENTINEL);
  await expect(page.getByText(POINT_NOTE_SENTINEL)).toHaveCount(0);

  const svc = serviceClient();
  const off = await svc
    .from("merchant_member_settings")
    .update({ points_feature_enabled: false })
    .eq("merchant_id", c1.merchantAId)
    .select("merchant_id");
  expect(off.data).toHaveLength(1);
  try {
    await page.goto(`/booking/${c1.slugA}/me`);
    await expect(page.getByTestId("member-nav-home")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId("member-nav-wallet")).toHaveCount(0);
    await expect(page.getByTestId("member-center-nav")).toContainText("我的資料");
    await shot(page, "c4-12-nav-no-wallet");
    await page.goto(`/booking/${c1.slugA}/me/wallet`);
    await expect(page).toHaveURL(new RegExp(`/booking/${c1.slugA}/me$`), {
      timeout: LOAD_TIMEOUT,
    });
  } finally {
    await svc
      .from("merchant_member_settings")
      .update({ points_feature_enabled: true })
      .eq("merchant_id", c1.merchantAId);
  }
});

test("C4-E02 / E03 / A04:我的資料改地址、Email、第一次填生日 ⇒ 生日鎖定;後台看得到;後台改地址 ⇒ 客人看到", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asMember(page);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(page.getByTestId("member-profile-save")).toBeDisabled({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-profile-unchanged")).toContainText("還沒有修改任何資料");
  await expect(page.getByTestId("member-profile-phone")).toContainText(testPhone(fixture.c2, 71));
  await expect(page.getByTestId("member-profile-line")).toContainText(LINE_NAME);
  await expect(page.getByText("LINE 通知")).toHaveCount(0);
  await shot(page, "c4-13-profile");

  await page.locator("#member-profile-address").fill("台北市信義區松仁路 58 號 12 樓");
  await page.locator("#member-profile-email").fill("wang@example.com");
  await page.locator("#member-profile-birthday").fill("1990-05-01");
  await expect(page.getByTestId("member-profile-birthday-note")).toBeVisible();
  await page.getByTestId("member-profile-save").click();
  await expect(page.getByText("已儲存會員資料")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const locked = page.getByTestId("member-profile-birthday-locked");
  await expect(locked).toContainText("1990-05-01", { timeout: LOAD_TIMEOUT });
  await expect(locked).toContainText("生日填寫後不能自行修改，要更改請聯絡店家。");
  await page.waitForTimeout(4000);
  await shot(page, "c4-14-profile-birthday-locked");

  const m = await serviceClient()
    .from("members")
    .select("name,address,email,birthday")
    .eq("id", memberId)
    .single();
  expect(m.data).toEqual({
    name: MEMBER_NAME,
    address: "台北市信義區松仁路 58 號 12 樓",
    email: "wang@example.com",
    birthday: "1990-05-01",
  });

  // 後台:會員詳細頁看得到地址;改地址 ⇒ 客人「我的資料」看到同一個值(C4-A04)
  await asAdmin(page);
  await page.goto(`/app/members/${memberId}`);
  await expect(page.getByText("台北市信義區松仁路 58 號 12 樓")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("button", { name: "編輯", exact: true }).click();
  await page.locator("#edit-member-address").fill(ADDRESS_FROM_BACKEND);
  await shot(page, "c4-15-backend-member-address");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.getByText("已更新會員資料")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(page.locator("#member-profile-address")).toHaveValue(ADDRESS_FROM_BACKEND, {
    timeout: LOAD_TIMEOUT,
  });
});

test("C4-E05:已登入會員預約 ⇒ ⑤ 地址欄自動帶入會員地址", async ({ page }) => {
  track(page);
  await asMember(page);
  await page.goto(`/booking/${fixture.c2.c1.slugA}`);
  await page.getByTestId("public-booking-start").click({ timeout: LOAD_TIMEOUT });
  await page.getByRole("checkbox", { name: new RegExp(ITEM_INDOOR) }).click();
  await page.getByTestId("public-booking-next").click();
  await page.getByTestId("public-booking-next").click();
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByTestId("public-booking-times").locator("button").first().click();
  await page.getByTestId("public-booking-next").click();
  await expect(page.locator("#public-booking-address")).toHaveValue(ADDRESS_FROM_BACKEND, {
    timeout: LOAD_TIMEOUT,
  });
});

test("C4-B04:⑦-1 / ⑦-2 會員完成頁新文案 +「前往會員中心」;⑦-3 訪客新文案", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  const svc = serviceClient();
  await asMember(page);
  await mockBookingSubmit(page);
  await walkToForm(page, c1.slugA, { item: ITEM_INDOOR, name: MEMBER_NAME });
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-linked-submit").click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("booking-complete")).toHaveAttribute(
    "data-kind",
    "member_pending",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.getByTestId("booking-complete-cancel-text")).toHaveText(
    "要取消可以在服務前 24 小時以前到會員中心操作；要改時間請取消後重新預約，或聯絡店家。",
  );
  await expect(page.getByTestId("booking-complete-member-center")).toHaveText("前往會員中心");
  await shot(page, "c4-16-complete-member-pending");
  await page.getByTestId("booking-complete-member-center").click();
  await expect(page).toHaveURL(new RegExp(`/booking/${c1.slugA}/me$`), { timeout: LOAD_TIMEOUT });

  // ⑦-2:服務人員開「客戶預約自動接受」
  const auto = await svc
    .from("merchant_staff")
    .update({ auto_accept_booking: true })
    .eq("id", c1.staffMingId)
    .select("id");
  expect(auto.data).toHaveLength(1);
  try {
    await walkToForm(page, c1.slugA, {
      item: ITEM_INDOOR,
      name: MEMBER_NAME,
      staffId: c1.staffMingId,
    });
    await page.getByTestId("public-booking-submit").click();
    await page.getByTestId("customer-linked-submit").click({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId("booking-complete")).toHaveAttribute(
      "data-kind",
      "member_accepted",
      { timeout: LOAD_TIMEOUT },
    );
    await expect(page.getByTestId("booking-complete-cancel-text")).toContainText("到會員中心操作");
    await shot(page, "c4-17-complete-member-accepted");
  } finally {
    await svc
      .from("merchant_staff")
      .update({ auto_accept_booking: false })
      .eq("id", c1.staffMingId);
  }

  // ⑦-3:訪客(另一個沒有登入的分頁)
  const ctx = await browser.newContext({ timezoneId: "Asia/Taipei" });
  const guest = await ctx.newPage();
  track(guest);
  try {
    await mockTurnstile(guest, "pass");
    await mockBookingSubmit(guest);
    await walkToForm(guest, c1.slugA, { item: ITEM_INDOOR, name: "林訪客" });
    await guest.getByTestId("public-booking-submit").click();
    await guest.getByTestId("customer-guest-button").click();
    await guest.locator("#customer-guest-phone").fill(testPhone(fixture.c2, 73));
    await guest.getByTestId("customer-guest-consent").click();
    await expect(guest.getByTestId("customer-guest-submit")).toBeEnabled({
      timeout: LOAD_TIMEOUT,
    });
    await guest.getByTestId("customer-guest-submit").click();
    await expect(guest.getByTestId("booking-complete")).toHaveAttribute("data-kind", "guest", {
      timeout: LOAD_TIMEOUT,
    });
    await expect(guest.getByTestId("booking-complete-join-text")).toHaveText(
      "用 LINE 登入加入會員後，可以在會員中心查看和取消這筆預約。",
    );
    await expect(guest.getByTestId("booking-complete-cancel-text")).toHaveText(
      "要取消或改時間請直接聯絡店家",
    );
    await expect(guest.getByTestId("booking-complete-member-center")).toHaveCount(0);
    await expect(guest.getByText("即將推出")).toHaveCount(0);
    await shot(guest, "c4-18-complete-guest");
  } finally {
    await ctx.close();
  }
});

test("C4-K01:商家設定「客人自己取消的期限」;改 36 存檔;沒啟用 LINE 登入 ⇒ 灰字提示", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asAdmin(page);
  await page.goto("/app/settings");
  const input = page.locator("#settings-customer-cancel-deadline-hours");
  await expect(input).toHaveValue("24", { timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("settings-cancel-deadline-line-hint")).toHaveCount(0);
  await input.scrollIntoViewIfNeeded();
  await input.fill("36");
  await page.getByRole("button", { name: "儲存變更" }).first().click();
  await expect(page.getByText("商家設定已儲存")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const saved = await serviceClient()
    .from("merchant_booking_settings")
    .select("customer_cancel_deadline_hours")
    .eq("merchant_id", c1.merchantAId)
    .single();
  expect(saved.data?.customer_cancel_deadline_hours).toBe(36);

  const off = await c1.admin.rpc("set_merchant_line_login_enabled", {
    p_merchant_id: c1.merchantAId,
    p_enabled: false,
  });
  expect(off.error).toBeNull();
  try {
    await page.reload();
    await expect(page.getByTestId("settings-cancel-deadline-line-hint")).toHaveText(
      "啟用 LINE 登入後才會生效",
      { timeout: LOAD_TIMEOUT },
    );
    await page.locator("#settings-customer-cancel-deadline-hours").scrollIntoViewIfNeeded();
    await shot(page, "c4-19-settings-cancel-deadline");
  } finally {
    await c1.admin.rpc("set_merchant_line_login_enabled", {
      p_merchant_id: c1.merchantAId,
      p_enabled: true,
    });
    await setCancelDeadline(24);
  }
});
