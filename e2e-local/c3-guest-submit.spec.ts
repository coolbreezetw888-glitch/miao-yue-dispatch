// 客戶端第 3 批(C3)本機 e2e:訪客(不登入)送出預約。
// 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(🔴 零之零優先);介面 .project/notes/c3-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c3-guest-submit`
// Edge Function / Turnstile / LINE 登入用 page.route 模擬(fixture 見 support/c3-submit-fixture.ts)。
//
// 涵蓋:C3-D01(有 LINE ⇒ ⑥-1 → 不登入;沒有 LINE ⇒ 直接 ⑥-4;兩個都關 ⇒ 停用 + 常駐原因)、C3-D04(Turnstile token 送出)、
//       C3-D05 bot_check_failed(伺服器驗證沒過 / 瀏覽器端檢查失敗)、C3-D06 ⑦-3(有 / 沒有 LINE 登入)、
//       C3-D07 + C3-B04(⑦-3「用 LINE 登入加入會員」⇒ 填電話「加入會員」⇒ ① 登入列 + 提示)、
//       資料庫:訪客單 / 自動建立的未驗證會員 / 同意紀錄。
import { expect, test, type Page } from "@playwright/test";

import {
  ITEM_B,
  ITEM_INDOOR,
  serviceClient,
  SHOP_A_NAME,
} from "./support/c1-public-booking-fixture";
import { mockLineLogin, newLineSub, testPhone } from "./support/c2-line-login-fixture";
import { LOAD_TIMEOUT, shotBoth, walkToForm } from "./support/c3-flow";
import {
  mockBookingSubmit,
  mockTurnstile,
  setupC3Fixture,
  teardownC3Fixture,
  TURNSTILE_PASS_TOKEN,
  type C3Fixture,
} from "./support/c3-submit-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    fixture = await setupC3Fixture();
    console.log(`[c3-guest 本機] fixture 建好(A=${fixture.c2.c1.slugA},B=${fixture.c2.c1.slugB})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC3Fixture(fixture);
  console.log("[c3-guest 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
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

async function fillGuest(page: Page, phone: string): Promise<void> {
  await expect(page.getByTestId("customer-guest")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.locator("#customer-guest-phone").fill(phone);
  await page.getByTestId("customer-guest-consent").click();
  await expect(page.getByTestId("customer-guest-submit")).toBeEnabled({ timeout: LOAD_TIMEOUT });
}

const GUEST_NAME = "林訪客";

test("C3-D04 / D06 ⑦-3 / C4-B03:A 店訪客送出 ⇒ 完成頁;再用 LINE 登入加入會員 ⇒ 會員中心首頁", async ({
  page,
}) => {
  track(page);
  await mockTurnstile(page, "pass");
  const submit = await mockBookingSubmit(page);
  const phone = testPhone(fixture.c2, 51);

  await walkToForm(page, fixture.c2.c1.slugA, { item: ITEM_INDOOR, name: GUEST_NAME });
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-guest-button").click();
  await expect(page.getByTestId("customer-guest")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 5／5");
  // 沒勾同意 ⇒ 停用 + 常駐原因
  await expect(page.getByTestId("customer-guest-submit")).toBeDisabled();
  await expect(page.getByTestId("customer-guest-submit-reason")).toContainText("才能送出預約");
  await fillGuest(page, phone);
  await shotBoth(page, "guest-01-form");
  await page.getByTestId("customer-guest-submit").click();

  const done = page.getByTestId("booking-complete");
  await expect(done).toHaveAttribute("data-kind", "guest", { timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("booking-complete-message")).toHaveText("店家確認後會與您聯絡。");
  await expect(page.getByTestId("booking-complete-phone")).toHaveText(phone);
  await expect(page.getByTestId("booking-complete-join")).toBeVisible();
  await shotBoth(page, "guest-02-complete-with-line");

  // 送出內容:有 guest、Turnstile 測試 token、沒有 Authorization 的會員身分
  const req = submit.requests[0]!;
  expect(req["guest"]).toEqual({
    phone,
    agree_policy: true,
    turnstile_token: TURNSTILE_PASS_TOKEN,
  });
  expect(submit.responseBodies.join("\n")).not.toContain("_internal");

  // 資料庫:訪客單、待確認、自動建立未驗證會員、同意紀錄
  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("id,status,source,is_guest_booking,member_id,member_auto_created,created_by_user_id")
    .eq("customer_submission_id", String(req["submission_id"]))
    .single();
  expect(b.data).toMatchObject({
    status: "pending_confirmation",
    source: "customer",
    is_guest_booking: true,
    member_auto_created: true,
    created_by_user_id: null,
  });
  const memberId = b.data!.member_id as string;
  const consent = await svc
    .from("customer_policy_consents")
    .select("context,member_id")
    .eq("merchant_id", fixture.c2.c1.merchantAId)
    .eq("member_id", memberId);
  expect(consent.data).toEqual([{ context: "guest_booking", member_id: memberId }]);
  const log = await svc
    .from("booking_status_change_logs")
    .select("actor_role_snapshot,actor_name_snapshot")
    .eq("booking_id", b.data!.id)
    .single();
  expect(log.data).toEqual({
    actor_role_snapshot: "customer",
    actor_name_snapshot: `訪客 ${GUEST_NAME}`,
  });

  // C3-D07:⑦-3「用 LINE 登入加入會員」(purpose:'join',沒有草稿)⇒ 填同一支電話 ⇒ 接上剛剛那位會員
  const login = await mockLineLogin(page, fixture.c2, {
    sub: newLineSub(),
    displayName: "林訪客的 LINE",
  });
  await page.getByTestId("booking-complete-join-button").click();
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(login.startBodies[0]).toMatchObject({ action: "start", purpose: "join" });
  expect(login.startBodies[0]!["draft"] ?? null).toBeNull();
  await expect(page.getByTestId("customer-profile-submit")).toHaveText("加入會員");
  await page.locator("#customer-profile-phone").fill(phone);
  await page.getByTestId("customer-profile-consent").click();
  await shotBoth(page, "guest-03-join-profile");
  await page.getByTestId("customer-profile-submit").click();
  // 第 4 批(C4-B03 取代 C3-D07):加入會員完成 ⇒ 會員中心首頁 + 提示;訪客時期的單已經在會員中心
  await expect(page.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page).toHaveURL(new RegExp(`/booking/${fixture.c2.c1.slugA}/me$`));
  await expect(page.getByText(`已加入「${SHOP_A_NAME}」會員`)).toBeVisible();
  await expect(page.getByTestId("member-home-next")).toBeVisible();
  await shotBoth(page, "guest-04-joined-home");
  const linked = await svc.from("members").select("user_id").eq("id", memberId).single();
  expect(linked.data?.user_id).toBe(login.userIds[0]);
});

test("C3-D01 / D06:B 店(沒有 LINE 登入)⑤ 直接到 ⑥-4;⑦-3 沒有加入會員區塊", async ({ page }) => {
  track(page);
  await mockTurnstile(page, "pass");
  await mockBookingSubmit(page);
  await walkToForm(page, fixture.c2.c1.slugB, { item: ITEM_B, name: "陳小美" });
  await page.getByTestId("public-booking-submit").click();
  await fillGuest(page, testPhone(fixture.c2, 52));
  await expect(page.getByTestId("customer-line-login")).toHaveCount(0);
  await page.getByTestId("customer-guest-submit").click();
  await expect(page.getByTestId("booking-complete")).toHaveAttribute("data-kind", "guest", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("booking-complete-join")).toHaveCount(0);
  await shotBoth(page, "guest-05-complete-no-line");
});

test("C3-D05:伺服器的安全檢查沒過(bot_check_failed)⇒ 說明 + 聯絡按鈕,不建單", async ({ page }) => {
  track(page);
  await mockTurnstile(page, "bad_token");
  const submit = await mockBookingSubmit(page);
  await walkToForm(page, fixture.c2.c1.slugB, { item: ITEM_B, name: "壞機器人" });
  await page.getByTestId("public-booking-submit").click();
  await fillGuest(page, testPhone(fixture.c2, 53));
  await page.getByTestId("customer-guest-submit").click();
  const panel = page.getByTestId("customer-submit-error");
  await expect(panel).toContainText("安全檢查沒有通過，請重新整理後再試一次。", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(panel.getByTestId("public-booking-contacts")).toBeVisible();
  await shotBoth(page, "guest-06-bot-check-failed");
  expect(submit.requests).toHaveLength(1);
  const none = await serviceClient()
    .from("bookings")
    .select("id")
    .eq("customer_submission_id", String(submit.requests[0]!["submission_id"]));
  expect(none.data).toEqual([]);
});

test("C3-D04:Turnstile 在瀏覽器端失敗 ⇒ 不送出;連續 3 次 ⇒ 改顯示替代方案", async ({ page }) => {
  track(page);
  await mockTurnstile(page, "error");
  const submit = await mockBookingSubmit(page);
  await walkToForm(page, fixture.c2.c1.slugA, { item: ITEM_INDOOR, name: "瀏覽器不支援" });
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-guest-button").click();
  await fillGuest(page, testPhone(fixture.c2, 54));
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId("customer-guest-submit").click();
    if (i < 2) {
      await expect(page.getByTestId("customer-submit-error")).toContainText("安全檢查沒有通過");
      await expect(page.getByTestId("customer-guest-submit")).toBeEnabled();
    }
  }
  await expect(page.getByTestId("customer-guest-unsupported")).toContainText(
    "這個瀏覽器無法完成安全檢查",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.getByTestId("customer-guest-unsupported-line-login")).toBeVisible();
  await shotBoth(page, "guest-07-turnstile-unsupported");
  expect(submit.requests).toHaveLength(0);
});

test("C3-D01:沒有 LINE 登入也不允許不登入 ⇒ 停用按鈕 + 常駐原因 + 聯絡按鈕", async ({ page }) => {
  const admin = fixture.c2.c1.admin;
  const off = await admin
    .from("merchant_booking_settings")
    .upsert({ merchant_id: fixture.c2.c1.merchantBId, allow_guest_booking: false } as never, {
      onConflict: "merchant_id",
    });
  expect(off.error).toBeNull();
  try {
    track(page);
    await walkToForm(page, fixture.c2.c1.slugB, { item: ITEM_B, name: "陳小美" });
    await expect(page.getByTestId("public-booking-submit")).toBeDisabled();
    // 兩個都沒開 ⇒ 不顯示下一步提示(已有停用原因)
    await expect(page.getByTestId("public-booking-next-step-hint")).toHaveCount(0);
    await expect(page.getByTestId("public-booking-not-open")).toContainText(
      "這家店目前不開放線上預約，請透過下方方式聯絡店家。",
    );
    await shotBoth(page, "guest-08-closed");
  } finally {
    await admin
      .from("merchant_booking_settings")
      .update({ allow_guest_booking: true } as never)
      .eq("merchant_id", fixture.c2.c1.merchantBId);
  }
});
