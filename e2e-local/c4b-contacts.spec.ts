// 客戶端第 4 批 4-B 本機 e2e:多位聯絡人(#1041)。
// 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md H 區、K03、K04;介面 .project/notes/c4-contract.md 4-B。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c4b-contacts`
// LINE 登入 Edge Function 用 page.route 模擬(邀請登入時在 Node 端呼叫真的 internal_customer_contact_invite_claim),
// 資料庫全部是本機真的。截圖:E2E_SHOT_DIR(預設 ../.project/notes/c4-shots),檔名 c4b-*,1280 / 375 各一。
//
// 涵蓋(規格 T 表 4-B 部分):
//   1. 邀請連結 ⇒ 第二位用 LINE 登入加入 ⇒ 兩人看到同一份預約(「由 〇〇 預約」);邀請碼進網址後立刻被拿掉(C4-F04)
//   2. 後台建單輸入第二聯絡人電話 ⇒ 面板提示;沒選直接送出 ⇒ 擋下;會員列表搜得到「聯絡人電話」(C4-K03)
//   3. 同一支電話申請 ⇒ 申請已送出畫面 ⇒ 主要聯絡人首頁提示 ⇒ 同意 ⇒ 申請人進得了會員中心;店家鈴鐺(C4-H04 / H05)
//   4. 主要聯絡人移除第三位 ⇒ 被移除的人等於被登出(C4-H10)
//   5. 後台會員詳細頁聯絡人卡 ⇒ 店家指定主要聯絡人 ⇒ members.user_id 同步、新主要聯絡人可以改資料(C4-K04)
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

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
import { injectCustomerSession, LOAD_TIMEOUT } from "./support/c3-flow";
import { setupC3Fixture, teardownC3Fixture, type C3Fixture } from "./support/c3-submit-fixture";
import { createMemberBooking, linkCustomerToMember } from "./support/c4-member-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "../.project/notes/c4-shots";
const MEMBER_NAME = "會員王小明";
const LINE_A = "王小明的 LINE";
const LINE_B = "小李的 LINE";
const LINE_C = "阿華的 LINE";

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
const SUB_A = newLineSub();
const SUB_B = newLineSub();
const SUB_C = newLineSub();
let memberId = "";
let memberPhone = "";
let phoneB = "";
let userA = "";
let userB = "";
let userC = "";
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

/** 1280 + 375 各一張(先把視窗拉到整頁高度再截)。 */
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

/** 視窗開著時截圖(不拉長視窗)。 */
async function shotDialog(page: Page, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * 模擬 customer-line-login 的「邀請登入」(c4-contract B4-4):start 收 purpose:'invite' + invite_token;
 * complete 時在 Node 端用 service role 呼叫真的 internal_customer_contact_invite_claim(只傳邀請碼雜湊),
 * 回 purpose:'invite'、invite.state,不回邀請碼。
 */
async function mockInviteLogin(
  page: Page,
  sub: string,
  displayName: string,
): Promise<{ startBodies: Record<string, unknown>[]; responseBodies: string[] }> {
  const record = { startBodies: [] as Record<string, unknown>[], responseBodies: [] as string[] };
  const states = new Map<string, string>();
  const svc = serviceClient();
  async function reply(route: Route, body: Record<string, unknown>) {
    const text = JSON.stringify(body);
    record.responseBodies.push(text);
    await route.fulfill({
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: text,
    });
  }
  await page.route("**/functions/v1/customer-line-login", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    if (body["action"] === "start") {
      record.startBodies.push(body);
      const state = randomBytes(24).toString("base64url");
      states.set(state, String(body["invite_token"] ?? ""));
      const origin = new URL(page.url()).origin;
      await reply(route, {
        status: "ok",
        authorize_url: `${origin}/auth/line/callback?code=MOCK&state=${state}`,
      });
      return;
    }
    const state = String(body["state"] ?? "");
    const token = states.get(state);
    if (token === undefined) {
      await reply(route, { status: "login_expired" });
      return;
    }
    states.delete(state);
    const session = await createCustomerSession(fixture.c2, sub, displayName);
    const link = await svc.auth.admin.generateLink({
      type: "magiclink",
      email: session.user.email ?? "",
    });
    const claimed = await svc.rpc("internal_customer_contact_invite_claim", {
      p_merchant_id: fixture.c2.c1.merchantAId,
      p_user_id: session.user.id,
      p_token_hash: createHash("sha256").update(token).digest("hex"),
    });
    const valid = !claimed.error && (claimed.data as { state?: string } | null)?.state === "valid";
    await reply(route, {
      status: "ok",
      slug: fixture.c2.c1.slugA,
      draft: null,
      purpose: "invite",
      invite: { state: valid ? "valid" : "invalid" },
      token_hash: link.data.properties?.hashed_token,
      verify_type: "email",
    });
  });
  return record;
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
    memberPhone = testPhone(fixture.c2, 81);
    phoneB = testPhone(fixture.c2, 82);
    const session = await createCustomerSession(fixture.c2, SUB_A, LINE_A);
    userA = session.user.id;
    memberId = await linkCustomerToMember({
      session,
      slug: c1.slugA,
      merchantId: c1.merchantAId,
      phone: memberPhone,
      name: MEMBER_NAME,
    });
    await createMemberBooking({
      slug: c1.slugA,
      userId: userA,
      itemId: item.data!.id as string,
      staffId: c1.staffMingId,
      date: bookingDate,
      time: "10:00",
      name: MEMBER_NAME,
    });
    console.log(`[c4b 本機] fixture 建好(A=${c1.slugA},預約日 ${bookingDate})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(300_000);
  if (setupFailed || !fixture) return;
  const svc = serviceClient();
  // 聯絡人相關列:先用同一個條件 SELECT 核對都屬於本 fixture 的會員,再刪(c4-contract B8 順序)。
  const own = await svc.from("members").select("id,merchant_id").eq("id", memberId).single();
  if (own.data?.merchant_id !== fixture.c2.c1.merchantAId) {
    throw new Error("teardown 中止:會員不屬於本 fixture 的商家");
  }
  for (const table of [
    "member_contact_invites",
    "member_contact_requests",
    "member_customer_contacts",
  ]) {
    const rows = await svc
      .from(table as never)
      .select("id,merchant_id")
      .eq("merchant_id", fixture.c2.c1.merchantAId);
    const bad = ((rows.data ?? []) as { merchant_id: string }[]).filter(
      (r) => r.merchant_id !== fixture.c2.c1.merchantAId,
    );
    if (bad.length > 0) throw new Error(`teardown 中止:${table} 有別的商家的列`);
  }
  const actions = await teardownC3Fixture(fixture);
  for (const table of [
    "member_customer_contacts",
    "member_contact_requests",
    "member_contact_invites",
  ]) {
    const left = await svc
      .from(table as never)
      .select("id")
      .eq("merchant_id", fixture.c2.c1.merchantAId);
    actions.push(`${table} 剩 ${(left.data ?? []).length} 列(商家刪除時一起刪)`);
  }
  console.log("[c4b 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
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

async function asCustomer(page: Page, sub: string, name: string): Promise<void> {
  const session = await createCustomerSession(fixture.c2, sub, name);
  await injectCustomerSession(page, fixture.c2.c1.slugA, session);
}

async function asAdmin(page: Page): Promise<void> {
  await injectSession(page, fixture.c2.c1.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const page = await ctx.newPage();
  track(page);
  return page;
}

async function contactsOf(): Promise<
  { user_id: string; is_primary: boolean; contact_phone: string | null; status: string }[]
> {
  const r = await serviceClient()
    .from("member_customer_contacts" as never)
    .select("user_id,is_primary,contact_phone,status")
    .eq("member_id", memberId);
  return (r.data ?? []) as never;
}

test("C4-H03 / H06 / H07:邀請連結 ⇒ 第二位用 LINE 登入加入 ⇒ 兩人看到同一份預約;邀請碼不留在網址", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const solo = page.getByTestId("member-contacts-solo");
  await expect(solo).toContainText("目前只有您一位聯絡人", { timeout: LOAD_TIMEOUT });
  await shot(page, "c4b-01-contacts-solo");

  await solo.getByTestId("member-contacts-invite").click();
  const message = page.getByTestId("member-contacts-invite-message");
  await expect(message).toContainText(
    `邀請您成為「${SHOP_A_NAME}」會員「${MEMBER_NAME}」的聯絡人：`,
    {
      timeout: LOAD_TIMEOUT,
    },
  );
  await expect(message).toContainText("（72 小時內有效）");
  const text = (await message.textContent()) ?? "";
  const url = /https?:\/\/\S+?\/booking\/[a-z0-9-]+\/invite\/[A-Za-z0-9_-]{32,}/.exec(text)?.[0];
  expect(url, "邀請訊息裡要有邀請網址").toBeTruthy();
  const share = page.getByTestId("member-contacts-invite-line");
  await expect(share).toHaveAttribute("href", /^https:\/\/line\.me\/R\/share\?text=/);
  await expect(page.getByTestId("member-contact-invite")).toHaveCount(1);
  await shot(page, "c4b-02-invite-created");

  // 第二位(小李)用另一個瀏覽器打開邀請連結
  const pageB = await newPage(browser);
  const login = await mockInviteLogin(pageB, SUB_B, LINE_B);
  await pageB.goto(url!);
  const landing = pageB.getByTestId("contact-invite-landing");
  await expect(landing).toContainText(`您被邀請成為「${SHOP_A_NAME}」會員的聯絡人`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(landing).toContainText("加入後可以一起查看預約、取消預約、查看紅利點數。");
  expect(new URL(pageB.url()).pathname).toBe(`/booking/${c1.slugA}/invite`);
  await expect(landing).not.toContainText(MEMBER_NAME);
  await shot(pageB, "c4b-03-invite-landing");

  await landing.getByTestId("contact-invite-login").click();
  const accept = pageB.getByTestId("contact-invite-accept-screen");
  await expect(accept).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(login.startBodies[0]).toMatchObject({ action: "start", purpose: "invite" });
  for (const body of login.responseBodies) {
    expect(body).not.toContain(String(login.startBodies[0]!["invite_token"]));
  }
  await expect(accept).toContainText("店家可以用這支電話找到您的會員資料。");
  await shot(pageB, "c4b-04-invite-accept");
  await pageB.locator("#contact-invite-phone").fill(phoneB);
  await pageB.getByTestId("contact-invite-consent").click();
  await pageB.getByTestId("contact-invite-accept").click();
  await expect(pageB.getByTestId("member-home-greeting")).toHaveText(`${MEMBER_NAME}，您好`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(pageB.getByText(`已加入「${SHOP_A_NAME}」會員`)).toBeVisible();
  userB = (await contactsOf()).find((c) => !c.is_primary)?.user_id ?? "";
  expect(userB).not.toBe("");

  // 兩人看到同一份預約;會員曾經有 2 位聯絡人 ⇒「由 〇〇 預約」
  await pageB.goto(`/booking/${c1.slugA}/me/bookings`);
  const cardB = pageB.getByTestId("member-booking-card");
  await expect(cardB).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(cardB.first()).toContainText(STAFF_MING);
  await expect(cardB.first()).toContainText(`由 ${LINE_A} 預約`);
  await page.goto(`/booking/${c1.slugA}/me/bookings`);
  await expect(page.getByTestId("member-booking-card")).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await pageB.waitForTimeout(4000);
  await shot(pageB, "c4b-05-secondary-bookings");

  // 第二聯絡人的「我的資料」:會員資料唯讀 + 聯絡人清單(看不到主要聯絡人的電話)+ 我的電話
  await pageB.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(pageB.getByTestId("member-profile-readonly")).toContainText(
    "只有主要聯絡人可以修改會員資料。",
    { timeout: LOAD_TIMEOUT },
  );
  const secondary = pageB.getByTestId("member-contacts-secondary");
  await expect(secondary.getByTestId("member-contact-row")).toHaveCount(2);
  await expect(pageB.locator("#member-contacts-my-phone")).toHaveValue(phoneB);
  await expect(secondary.getByTestId("member-contact-transfer")).toHaveCount(0);
  await shot(pageB, "c4b-06-profile-secondary");

  const rows = await contactsOf();
  expect(rows.filter((r) => r.status === "active")).toHaveLength(2);
  expect(rows.find((r) => r.user_id === userB)?.contact_phone).toBe(phoneB);
  // 店家鈴鐺:〇〇已加入成為會員「△△」的聯絡人
  const bell = await serviceClient()
    .from("user_notifications")
    .select("body")
    .eq("merchant_id", c1.merchantAId)
    .eq("event_type", "member_line_login_linked")
    .like("body", "%已加入成為會員%");
  expect((bell.data ?? []).length).toBeGreaterThanOrEqual(1);
  await pageB.context().close();
});

test("C4-K03:後台建單打第二聯絡人電話 ⇒ 面板提示;沒選直接送出 ⇒ 擋下;會員列表搜得到「聯絡人電話」", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asAdmin(page);
  let date = plusDays(bookingDate, 1);
  while (isSunday(date)) date = plusDays(date, 1);
  await page.goto(`/app/calendar?date=${date}`);
  await page.getByRole("button", { name: "新增預約" }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dialog.locator("#booking-staff").click();
  // 後台列的是服務人員本名(可能帶暱稱)⇒ 兩個都比對。
  await page
    .getByRole("option", { name: new RegExp(`${STAFF_MING}|${SENTINELS.staffRealName}`) })
    .first()
    .click();
  await dialog.locator("#booking-service-items").click();
  const picker = dialog.getByTestId("service-item-picker");
  await picker
    .getByRole("checkbox", { name: new RegExp(ITEM_INDOOR) })
    .first()
    .click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(picker).toHaveCount(0);
  await dialog.locator("#booking-customer-name").fill("客服打的新名字");
  await dialog.locator("#booking-customer-phone").fill(phoneB);
  const panel = dialog.getByTestId("member-phone-match-contact");
  await expect(panel).toContainText(`這支電話是會員「${MEMBER_NAME}」的聯絡人電話`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(panel.getByTestId("member-phone-match-contact-phone")).toContainText(phoneB);
  await expect(dialog.getByText("將連結既有客戶：")).toHaveCount(0);
  const address = dialog.locator("#booking-customer-address");
  if (await address.count()) await address.fill("台北市信義區松仁路 58 號");
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  // 紅利區塊(preview_booking_points 回 member_contact,本機真的資料庫):常駐提示,不顯示「自動建立會員」
  const pointsNote = dialog.getByTestId("booking-points-member-contact");
  await expect(pointsNote).toContainText(
    `這支電話是會員「${MEMBER_NAME}」的聯絡人電話，請在上方選擇這位會員。`,
    { timeout: LOAD_TIMEOUT },
  );
  await expect(dialog.getByText("新客戶(送出後自動建立會員)")).toHaveCount(0);
  await expect(dialog.getByText(/自動建立會員|新建會員/)).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();
  await shotDialog(page, "c4b-07-backend-booking-contact-phone");
  await pointsNote.scrollIntoViewIfNeeded();
  await shotDialog(page, "c4b-07b-backend-booking-points-contact");
  const before = await serviceClient()
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", c1.merchantAId);
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText("建立預約失敗")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(/聯絡人電話/).last()).toBeVisible();
  const after = await serviceClient()
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", c1.merchantAId);
  expect(after.count, "不可以另外建一位重複的會員").toBe(before.count);

  // 點選那位會員 ⇒ 電話換成會員電話(送出時後端依電話連結)
  await panel.getByRole("button", { name: new RegExp(MEMBER_NAME) }).click();
  await expect(dialog.locator("#booking-customer-phone")).toHaveValue(memberPhone);
  await expect(dialog.getByText("將連結既有客戶：")).toBeVisible();

  // 會員列表搜尋第二聯絡人電話
  await page.goto("/app/members");
  await page.getByPlaceholder(/搜尋姓名/).fill(phoneB.slice(0, 8));
  const hit = page.getByTestId("members-list-contact-phone");
  await expect(hit).toContainText(`聯絡人電話 ${phoneB}`, { timeout: LOAD_TIMEOUT });
  await shot(page, "c4b-08-members-search-contact-phone");
});

test("C4-H04 / H05:同一支電話申請 ⇒ 申請已送出 ⇒ 主要聯絡人首頁提示 ⇒ 同意 ⇒ 申請人進得了會員中心;店家鈴鐺", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  const pageC = await newPage(browser);
  await mockLineLogin(pageC, fixture.c2, { sub: SUB_C, displayName: LINE_C });
  await pageC.goto(`/booking/${c1.slugA}/me`);
  await pageC.getByTestId("member-center-login-button").click({ timeout: LOAD_TIMEOUT });
  await expect(pageC.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await pageC.locator("#customer-profile-phone").fill(memberPhone);
  await pageC.getByTestId("customer-profile-consent").click();
  await pageC.getByTestId("customer-profile-submit").click();
  const pending = pageC.getByTestId("customer-join-pending");
  await expect(pending).toContainText(
    "這支電話已經是會員。主要聯絡人打開會員中心時會看到您的申請，同意後您就能使用會員中心。",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(pending).not.toContainText(MEMBER_NAME);
  await shot(pageC, "c4b-09-join-pending");
  // 重新整理仍是同一個畫面(登入狀態 join_pending)
  await pageC.reload();
  await expect(pageC.getByTestId("customer-join-pending")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 店家鈴鐺「有人申請成為會員的聯絡人時」
  const admin = await newPage(browser);
  await asAdmin(admin);
  await admin.getByTestId("notification-bell").click();
  const row = admin.getByTestId("notification-row").filter({ hasText: "有人申請成為會員的聯絡人" });
  await expect(row.first()).toContainText(`會員「${MEMBER_NAME}」`, { timeout: LOAD_TIMEOUT });
  await shot(admin, "c4b-10-bell-contact-request");
  await admin.context().close();

  // 主要聯絡人首頁黃色提示 ⇒ 去處理 ⇒ 同意
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me`);
  const card = page.getByTestId("member-home-requests");
  await expect(card).toContainText("有 1 位想加入成為聯絡人", { timeout: LOAD_TIMEOUT });
  await shot(page, "c4b-11-home-request");
  await card.getByTestId("member-home-requests-go").click();
  const primary = page.getByTestId("member-contacts-primary");
  const request = primary.getByTestId("member-contact-request");
  await expect(request).toContainText(LINE_C, { timeout: LOAD_TIMEOUT });
  await expect(request).toContainText(memberPhone);
  await expect(primary.getByTestId("member-contact-row").nth(1)).toContainText(phoneB);
  await shot(page, "c4b-12-contacts-primary");
  await request.getByTestId("member-contact-request-approve").click();
  await expect(page.getByText("已同意，對方已加入成為聯絡人")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(primary.getByTestId("member-contact-row")).toHaveCount(3);

  await pageC.reload();
  await expect(pageC.getByTestId("member-home-greeting")).toHaveText(`${MEMBER_NAME}，您好`, {
    timeout: LOAD_TIMEOUT,
  });
  userC =
    (await contactsOf()).find((c) => c.user_id !== userA && c.user_id !== userB)?.user_id ?? "";
  expect(userC).not.toBe("");
  await pageC.context().close();
});

test("C4-H10:主要聯絡人移除第三位 ⇒ 被移除的人等於被登出;轉移主要確認窗文字", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  const pageC = await newPage(browser);
  await asCustomer(pageC, SUB_C, LINE_C);
  await pageC.goto(`/booking/${c1.slugA}/me`);
  await expect(pageC.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const rowB = page.getByTestId("member-contact-row").filter({ hasText: LINE_B });
  await rowB.getByTestId("member-contact-transfer").click({ timeout: LOAD_TIMEOUT });
  const confirm = page.getByTestId("member-contacts-confirm");
  await expect(confirm).toContainText(
    `把主要聯絡人轉給 ${LINE_B} 嗎？轉移後只有 ${LINE_B} 可以修改會員資料、管理聯絡人。`,
  );
  await shotDialog(page, "c4b-13-transfer-dialog");
  await confirm.getByRole("button", { name: "先不要" }).click();
  await expect(confirm).toHaveCount(0);

  const rowC = page.getByTestId("member-contact-row").filter({ hasText: LINE_C });
  await rowC.getByTestId("member-contact-remove").click();
  await expect(confirm).toContainText(`要把 ${LINE_C} 從聯絡人移除嗎？`);
  await confirm.getByTestId("member-contacts-confirm-ok").click();
  await expect(page.getByText("已移除這位聯絡人")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-contact-row")).toHaveCount(2);
  expect((await contactsOf()).find((c) => c.user_id === userC)?.status).toBe("removed");

  // 被移除的人(會員中心還開著):下一個會員中心呼叫回 not_linked ⇒ 登出、回登入頁(C4-H10「他就被登出」)
  await pageC.getByTestId("member-nav-bookings").click();
  await expect(pageC.getByTestId("member-center-login")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(pageC.getByTestId("member-center-login-notice")).toContainText("登入狀態已失效");
  await shot(pageC, "c4b-16-removed-logged-out");
  // 之後重新用 LINE 登入:伺服器回 needs_profile ⇒ ⑥-2;填同一支電話 ⇒ 被封鎖 ⇒「這支電話已經是會員」
  await mockLineLogin(pageC, fixture.c2, { sub: SUB_C, displayName: LINE_C });
  await pageC.getByTestId("member-center-login-button").click();
  await expect(pageC.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await pageC.locator("#customer-profile-phone").fill(memberPhone);
  await pageC.getByTestId("customer-profile-consent").click();
  await pageC.getByTestId("customer-profile-submit").click();
  await expect(pageC.getByTestId("customer-phone-taken")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await pageC.context().close();
});

test("C4-K04:後台會員詳細頁聯絡人卡 ⇒ 店家指定主要聯絡人 ⇒ members.user_id 同步;新主要聯絡人可以改資料", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asAdmin(page);
  await page.goto(`/app/members/${memberId}`);
  const card = page.getByTestId("member-contacts-card");
  await expect(card.getByTestId("member-contacts-card-row")).toHaveCount(2, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByTestId("member-contacts-card-row").first()).toContainText("主要聯絡人");
  await expect(card).toContainText(`聯絡人電話 ${phoneB}`);
  await expect(card).toContainText("邀請連結");
  await card.scrollIntoViewIfNeeded();
  await shot(page, "c4b-14-backend-contacts-card");

  const rowB = card.getByTestId("member-contacts-card-row").filter({ hasText: LINE_B });
  await rowB.getByTestId("member-contacts-card-set-primary").click();
  await page.getByTestId("member-contacts-card-confirm").click();
  await expect(page.getByText("已設為主要聯絡人")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const m = await serviceClient()
    .from("members")
    .select("user_id,line_bound")
    .eq("id", memberId)
    .single();
  expect(m.data?.user_id).toBe(userB);

  // 移除主要聯絡人(還有別人)⇒ 視窗裡先選新的主要
  const rowNewPrimary = card.getByTestId("member-contacts-card-row").filter({ hasText: LINE_B });
  await rowNewPrimary.getByTestId("member-contacts-card-remove").click();
  await expect(page.getByTestId("member-contacts-card-need-primary")).toBeVisible();
  await expect(page.getByTestId("member-contacts-card-confirm")).toBeDisabled();
  await shotDialog(page, "c4b-15-backend-remove-primary-dialog");
  await page.getByRole("button", { name: "取消" }).click();

  const pageB = await newPage(browser);
  await asCustomer(pageB, SUB_B, LINE_B);
  await pageB.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(pageB.getByTestId("member-profile-form")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(pageB.getByTestId("member-contacts-primary")).toBeVisible();
  await pageB.context().close();
});
