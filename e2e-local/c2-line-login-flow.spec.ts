// 客戶端第 2 批(C2)本機 e2e:按「確定預約」之後的 ⑥ 系列 + LINE 登入(模擬)+ 會員接上。
// 規格書:.project/specs/客戶端第2批-LINE登入與訪客預約.md(🔴 零之二優先)。fixture 見 support/c2-line-login-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c2-line-login-flow`
// (Playwright 自己開獨立的 headless Chromium;只連本機 Docker 的 Supabase;LINE 端點用 page.route 攔下模擬)。
//
// 🔴 客戶端第 3 批起:⑥-2 按鈕是「送出預約」—— 接上會員之後**自動送出預約**(C3-D02)⇒ 成功時直接到 ⑦ 完成頁;
//    ⑥-4 / 沒有 LINE 登入的店可以真的送出。customer-booking-submit 照 c3 fixture 的做法攔截
//    (Node 端用本機 service role 呼叫 internal_customer_submit_booking,回給頁面前刪掉 _internal)。
// 涵蓋:C2-E01(後台登入不被踢)、C2-E02(四種組合)、C2-E03、C2-B02(callback 清網址)、C2-B04(草稿救回)、
//       C2-E04 + 零之二(新電話直接建會員 / 既有會員直接接上 + 鈴鐺 / phone_taken)、C2-E06、C2-E07、C2-F01、C2-H03。
// 截圖:E2E_SHOT_DIR(預設 test-results/c2-shots),1280 與 375 各一張。
import { expect, test, type Page, type Response } from "@playwright/test";

import {
  injectSession,
  ITEM_B,
  ITEM_INDOOR,
  SHOP_A_NAME,
} from "./support/c1-public-booking-fixture";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./support/local-target";
import {
  CHANNEL_ID_A,
  createCustomerSession,
  createMemberA,
  mockLineLogin,
  newLineSub,
  SECRET_SENTINEL,
  setupC2Fixture,
  teardownC2Fixture,
  testPhone,
  type C2Fixture,
} from "./support/c2-line-login-fixture";
import { serviceClient } from "./support/c1-public-booking-fixture";
import { mockBookingSubmit, mockTurnstile } from "./support/c3-submit-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results/c2-shots";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 150_000 });

let fixture: C2Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    fixture = await setupC2Fixture();
    console.log(`[c2-line-login 本機] fixture 建好(A=${fixture.c1.slugA},B=${fixture.c1.slugB})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC2Fixture(fixture);
  console.log("[c2-line-login 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

/** /rest/v1/rpc/ 與 /functions/v1/ 的回應原文(C2-F01 搜哨兵)。 */
function collectBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (res: Response) => {
    const url = res.url();
    if (!url.includes("/rest/v1/rpc/") && !url.includes("/functions/v1/")) return;
    void res
      .text()
      .then((t) => bodies.push(`${new URL(url).pathname} ${t}`))
      .catch(() => undefined);
  });
  return bodies;
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
}

/** 1280 + 375 各一張,375 時順便檢查沒有橫向捲動。 */
async function shotBoth(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOT_DIR}/${name}_1280.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page, name);
  await page.screenshot({ path: `${SHOT_DIR}/${name}_375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** ①→⑤:室內機清洗 ×1、不指定、第一個能約的時間,填好姓名 / 地址 / 備註。 */
async function walkToForm(
  page: Page,
  slug: string,
  name = "王小明",
  item: string = ITEM_INDOOR,
): Promise<void> {
  await page.goto(`/booking/${slug}`);
  await page.getByTestId("public-booking-start").click({ timeout: LOAD_TIMEOUT });
  await page.getByRole("checkbox", { name: new RegExp(item) }).click();
  await page.getByTestId("public-booking-next").click();
  await page.getByTestId("public-booking-next").click(); // 不指定
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByTestId("public-booking-times").locator("button").first().click();
  await page.getByTestId("public-booking-next").click();
  await page.locator("#public-booking-name").fill(name);
  const address = page.locator("#public-booking-address");
  if (await address.count()) await address.fill("台北市信義區松仁路 58 號 12 樓");
  await page.locator("#public-booking-note").fill("門口有狗");
}

async function loginWithLine(page: Page): Promise<void> {
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-line-login-button").click();
}

test("C2-E01 / E03 / B02 / B04 / E04:新客人 LINE 登入 ⇒ 填新電話直接成為會員;後台登入不被踢;秘密搜不到", async ({
  page,
}) => {
  track(page);
  const bodies = collectBodies(page);
  // C2-E01:同一個瀏覽器先登入後台。
  await injectSession(page, fixture.c1.adminSession);
  const sub = newLineSub();
  const mock = await mockLineLogin(page, fixture, { sub, displayName: "王小明的 LINE" });
  const submit = await mockBookingSubmit(page);

  await walkToForm(page, fixture.c1.slugA);
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-line-login")).toContainText("最後一步：登入會員");
  await expect(page.getByTestId("customer-guest-button")).toBeVisible();
  await shotBoth(page, "01_line_login_with_guest");

  // C2-B02:callback 頁一進來網址參數就清掉(complete 回來前截一張轉圈)。
  let releaseComplete: () => void = () => {};
  const completeGate = new Promise<void>((r) => {
    releaseComplete = r;
  });
  await page.route("**/functions/v1/customer-line-login", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (body?.["action"] === "complete") await completeGate;
    await route.fallback();
  });
  await page.getByTestId("customer-line-login-button").click();
  await expect(page.getByTestId("line-callback-working")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(new URL(page.url()).pathname).toBe("/auth/line/callback");
  expect(new URL(page.url()).search).toBe("");
  await shotBoth(page, "02_callback_working");
  releaseComplete();

  // C2-B04:回來直接到 ⑥-2,草稿還在。
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(new URL(page.url()).pathname).toBe(`/booking/${fixture.c1.slugA}`);
  await expect(page.getByTestId("customer-line-name")).toHaveText("王小明的 LINE");
  await expect(page.getByTestId("customer-profile-submit")).toBeDisabled();
  await expect(page.getByTestId("customer-profile-blocked")).toContainText(
    "請先勾選同意會員政策與隱私權政策",
  );
  const draft = mock.startBodies[0]?.["draft"] as Record<string, unknown>;
  expect(draft["name"]).toBe("王小明");
  expect(draft["notes"]).toBe("門口有狗");
  expect((draft["items"] as unknown[]).length).toBe(1);
  await page
    .locator("#customer-profile-phone")
    .fill(testPhone(fixture, 1).replace(/^(\d{4})(\d{3})/, "$1-$2-"));
  await page.getByTestId("customer-profile-consent").click();
  await shotBoth(page, "03_profile_new_customer");

  // 系統上一頁 = ⑤(草稿在)
  await page.goBack();
  await expect(page.locator("#public-booking-note")).toHaveValue("門口有狗");
  await page.goForward();
  await page.locator("#customer-profile-phone").fill(testPhone(fixture, 1));
  await page.getByTestId("customer-profile-consent").click();
  await page.getByTestId("customer-profile-submit").click();
  // 第 3 批(C3-D02):新電話直接成為會員 ⇒ 接著自動送出預約 ⇒ ⑦-1 完成頁(會員、待確認)。
  await expect(page.getByTestId("booking-complete")).toHaveAttribute(
    "data-kind",
    "member_pending",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.getByTestId("booking-complete-title")).toHaveText("已送出，等待店家確認");
  expect(submit.requests).toHaveLength(1);
  expect(submit.requests[0]!["guest"]).toBeUndefined();
  await shotBoth(page, "04_linked_and_submitted");

  // 資料庫:新會員接上這個客戶帳號、LINE 已綁定。
  const svc = serviceClient();
  const m = await svc
    .from("members")
    .select("id,name,user_id,line_bound,line_user_id")
    .eq("merchant_id", fixture.c1.merchantAId)
    .eq("user_id", mock.userIds[0]!)
    .single();
  expect(m.error).toBeNull();
  expect(m.data).toMatchObject({ name: "王小明", line_bound: true, line_user_id: sub });
  // 自動送出的那張單掛在這位新會員身上
  const created = await svc
    .from("bookings")
    .select("member_id,source,customer_name")
    .eq("customer_submission_id", String(submit.requests[0]!["submission_id"]))
    .single();
  expect(created.data).toEqual({
    member_id: m.data!.id,
    source: "customer",
    customer_name: "王小明",
  });

  // C2-E01:兩邊登入狀態分開存;後台仍是原本的管理員。
  const keys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(keys).toContain(`miaoyue-customer-${fixture.c1.slugA}`);
  await page.goto("/app/line-settings");
  await expect(page.getByTestId("line-login-settings-card")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // C2-E07:重新整理 ⇒ 回 ①;已登入的人走到 ⑤ 按確定預約 ⇒ 直接到已登入確認畫面(沒有「剛接上」提示)。
  await walkToForm(page, fixture.c1.slugA);
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-linked")).toContainText("已用 LINE 登入：王小明");
  await expect(page.getByTestId("customer-linked-created")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("public-booking-start")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // C2-F01:瀏覽器收到的回應原文搜不到 Channel Secret,也搜不到 Channel ID。
  await expect.poll(() => bodies.some((b) => b.includes("get_customer_session_state"))).toBe(true);
  const all = bodies.join("\n") + mock.responseBodies.join("\n");
  expect(all).not.toContain(SECRET_SENTINEL);
  expect(bodies.filter((b) => b.includes("get_public_booking_page")).join("\n")).not.toContain(
    CHANNEL_ID_A,
  );
  expect(await page.content()).not.toContain(SECRET_SENTINEL);
});

test("零之二:既有會員(沒人接上)⇒ 直接接上 + 店家鈴鐺;會員詳細頁顯示客戶端已連結;別人再用同一支 ⇒ phone_taken", async ({
  page,
  browser,
}) => {
  track(page);
  const phone = testPhone(fixture, 2);
  const memberId = await createMemberA(fixture, "既有會員老張", phone);
  await mockLineLogin(page, fixture, { sub: newLineSub(), displayName: "張先生" });
  const submit = await mockBookingSubmit(page);
  await walkToForm(page, fixture.c1.slugA, "張先生");
  await loginWithLine(page);
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.locator("#customer-profile-phone").fill(phone);
  await page.getByTestId("customer-profile-consent").click();
  await page.getByTestId("customer-profile-submit").click();
  // 第 3 批(C3-D02):直接接上既有會員 ⇒ 自動送出 ⇒ ⑦-1。
  await expect(page.getByTestId("booking-complete")).toHaveAttribute(
    "data-kind",
    "member_pending",
    { timeout: LOAD_TIMEOUT },
  );
  await shotBoth(page, "05_linked_existing_member_submitted");
  // 接上的是原本那位會員;姓名不覆蓋(#931):會員姓名不變,訂單留這次填的姓名。
  const linkedRow = await serviceClient()
    .from("members")
    .select("name,user_id")
    .eq("id", memberId)
    .single();
  expect(linkedRow.data?.name).toBe("既有會員老張");
  expect(linkedRow.data?.user_id).not.toBeNull();
  const created = await serviceClient()
    .from("bookings")
    .select("member_id,customer_name")
    .eq("customer_submission_id", String(submit.requests[0]!["submission_id"]))
    .single();
  expect(created.data).toEqual({ member_id: memberId, customer_name: "張先生" });

  // 店家鈴鐺(管理員)
  const svc = serviceClient();
  const notes = await svc
    .from("user_notifications")
    .select("event_type,body,target_type")
    .eq("merchant_id", fixture.c1.merchantAId)
    .eq("event_type", "member_line_login_linked");
  expect(notes.error).toBeNull();
  expect((notes.data ?? []).length).toBeGreaterThanOrEqual(1);

  // 後台:鈴鐺標籤是中文;會員詳細頁「客戶端登入：已連結」。
  const adminCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const adminPage = await adminCtx.newPage();
  track(adminPage);
  await injectSession(adminPage, fixture.c1.adminSession);
  await adminPage.goto(`/app/members/${memberId}`);
  const row = adminPage.getByTestId("member-customer-login-row");
  await expect(row).toContainText("已連結", { timeout: LOAD_TIMEOUT });
  await expect(row).toContainText("最後登入");
  await row.scrollIntoViewIfNeeded();
  await shotBoth(adminPage, "06_member_detail_customer_login");
  await adminPage.getByRole("button", { name: /通知/ }).first().click();
  await expect(adminPage.getByText("會員用 LINE 登入接上時").first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await adminCtx.close();

  // 另一位客人(另一個 LINE)填同一支電話 ⇒ phone_taken(不帶任何會員資料)。
  const otherCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const other = await otherCtx.newPage();
  track(other);
  const otherBodies = collectBodies(other);
  await mockLineLogin(other, fixture, { sub: newLineSub(), displayName: "陌生人" });
  const otherSubmit = await mockBookingSubmit(other);
  await walkToForm(other, fixture.c1.slugA, "陌生人");
  await loginWithLine(other);
  await expect(other.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await other.locator("#customer-profile-phone").fill(phone);
  await other.getByTestId("customer-profile-consent").click();
  await other.getByTestId("customer-profile-submit").click();
  const taken = other.getByTestId("customer-phone-taken");
  await expect(taken).toContainText("這支電話已經是會員，請改用其他電話，或聯繫店家。");
  await expect(taken.getByTestId("public-booking-contacts")).toBeVisible();
  await expect(other.getByTestId("customer-phone-taken-guest")).toBeVisible();
  await shotBoth(other, "07_phone_taken");
  await expect
    .poll(() => otherBodies.some((b) => b.includes("customer_complete_profile")))
    .toBe(true);
  expect(otherBodies.join("\n")).not.toContain("既有會員老張");
  await expect(other.locator("body")).not.toContainText("既有會員老張");
  // phone_taken ⇒ 沒有接上會員,也不會送出預約
  expect(otherSubmit.requests).toHaveLength(0);
  await otherCtx.close();
});

test("主腦複查:店家解除綁定 ⇒ 同一位客人再填同一支電話看到 phone_taken;店家按「允許重新接上」⇒ 客人可以接上", async ({
  page,
  browser,
}) => {
  track(page);
  const phone = testPhone(fixture, 3);
  await mockLineLogin(page, fixture, { sub: newLineSub(), displayName: "重接測試" });
  const submit = await mockBookingSubmit(page);
  await walkToForm(page, fixture.c1.slugA, "重接測試");
  await loginWithLine(page);
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.locator("#customer-profile-phone").fill(phone);
  await page.getByTestId("customer-profile-consent").click();
  await page.getByTestId("customer-profile-submit").click();
  // 第 3 批:新會員建立後自動送出預約 ⇒ ⑦ 完成頁。
  await expect(page.getByTestId("booking-complete")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(submit.requests).toHaveLength(1);
  const svc = serviceClient();
  const member = await svc
    .from("members")
    .select("id")
    .eq("merchant_id", fixture.c1.merchantAId)
    .eq("name", "重接測試")
    .single();
  const memberId = member.data!.id as string;

  // 店家在會員詳細頁按「解除綁定」。
  const adminCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const admin = await adminCtx.newPage();
  track(admin);
  await injectSession(admin, fixture.c1.adminSession);
  await admin.goto(`/app/members/${memberId}`);
  await admin.getByRole("button", { name: "解除綁定" }).click({ timeout: LOAD_TIMEOUT });
  const row = admin.getByTestId("member-customer-login-row");
  await expect(row).toContainText("未連結", { timeout: LOAD_TIMEOUT });
  await expect(admin.getByTestId("member-customer-relink-button")).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await shotBoth(admin, "13_member_detail_relink_blocked");

  // 同一位客人(還在登入中)再走一次、填同一支電話 ⇒ phone_taken。
  await walkToForm(page, fixture.c1.slugA, "重接測試");
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.locator("#customer-profile-phone").fill(phone);
  await page.getByTestId("customer-profile-consent").click();
  await page.getByTestId("customer-profile-submit").click();
  await expect(page.getByTestId("customer-phone-taken")).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(submit.requests).toHaveLength(1); // phone_taken ⇒ 不送出

  // 店家按「允許重新接上」(確認窗)。
  await admin.getByTestId("member-customer-relink-button").click();
  await expect(admin.getByText(/這位會員的 LINE 綁定先前被你解除過/)).toBeVisible();
  await admin.waitForTimeout(400); // 等確認窗進場動畫結束再截圖
  await admin.screenshot({ path: `${SHOT_DIR}/14_relink_confirm_1280.png` });
  await admin.getByRole("button", { name: "允許", exact: true }).click();
  await expect(admin.getByTestId("member-customer-relink-button")).toHaveCount(0, {
    timeout: LOAD_TIMEOUT,
  });
  await adminCtx.close();

  // 客人再送一次 ⇒ 接上原本的會員,並送出這次的預約(第 3 批)。
  await page.getByTestId("customer-profile-submit").click();
  await expect(page.getByTestId("booking-complete")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  expect(submit.requests).toHaveLength(2);
  const relinked = await svc.from("members").select("user_id").eq("id", memberId).single();
  expect(relinked.data?.user_id).not.toBeNull();
  const second = await svc
    .from("bookings")
    .select("member_id")
    .eq("customer_submission_id", String(submit.requests[1]!["submission_id"]))
    .single();
  expect(second.data?.member_id).toBe(memberId);
});

test("C2-H01:後台 client 拿到客人帳號 ⇒ 顯示「這是客人帳號，不能進入後台」,只登出後台 client,客戶端登入不受影響", async ({
  page,
}) => {
  track(page);
  const session = await createCustomerSession(fixture, newLineSub(), "誤闖後台的客人");
  const backendKey = localAuthStorageKey(readLocalSupabaseTarget().url);
  const customerKey = `miaoyue-customer-${fixture.c1.slugA}`;
  await page.addInitScript(
    ([bk, ck, v]) => {
      // 只在第一次載入時塞(之後重新整理不再塞,才看得出後台那份真的被清掉)。
      if (window.sessionStorage.getItem("c2-h01-seeded")) return;
      window.sessionStorage.setItem("c2-h01-seeded", "1");
      window.localStorage.setItem(bk, v);
      window.localStorage.setItem(ck, v);
    },
    [backendKey, customerKey, JSON.stringify(session)] as [string, string, string],
  );
  await page.goto("/app");
  await expect(page.getByTestId("customer-account-blocked")).toContainText(
    "這是客人帳號，不能進入後台",
    { timeout: LOAD_TIMEOUT },
  );
  await shotBoth(page, "15_customer_account_blocked");
  await expect
    .poll(() => page.evaluate((k) => window.localStorage.getItem(k), backendKey))
    .toBeNull();
  expect(await page.evaluate((k) => window.localStorage.getItem(k), customerKey)).not.toBeNull();

  // 超級管理員頁同樣擋下(後台已登出 ⇒ 改成導去登入頁)。
  await page.goto("/platform-admin");
  await expect(page).toHaveURL(/\/signin$/, { timeout: LOAD_TIMEOUT });
});

test("C2-B04:在 LINE 按取消 ⇒ 回到 ⑤,資料都在 + 提示", async ({ page }) => {
  track(page);
  await mockLineLogin(page, fixture, { sub: newLineSub(), displayName: "x", outcome: "cancelled" });
  await walkToForm(page, fixture.c1.slugA, "取消測試");
  await loginWithLine(page);
  await expect(page.getByTestId("public-booking-line-cancelled")).toContainText(
    "你取消了 LINE 登入",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.locator("#public-booking-name")).toHaveValue("取消測試");
  await expect(page.locator("#public-booking-note")).toHaveValue("門口有狗");
});

test("C2-B03:LINE 那邊沒成功(line_error)⇒ 回到 ⑤,資料都在 + 提示", async ({ page }) => {
  track(page);
  await mockLineLogin(page, fixture, {
    sub: newLineSub(),
    displayName: "x",
    outcome: "line_error",
  });
  await walkToForm(page, fixture.c1.slugA, "失敗測試");
  await loginWithLine(page);
  await expect(page.getByTestId("public-booking-line-failed")).toContainText(
    "LINE 登入沒有成功，請再試一次。",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.locator("#public-booking-name")).toHaveValue("失敗測試");
});

test("C2-E02 / E06 + C3-D01 / D04:⑥-4 沒勾 / 沒填 ⇒ 停用 + 原因,填好可送出;沒有 LINE 登入的店 ⑤ 直接到 ⑥-4;不允許不登入 ⇒ ⑥-1 沒有那顆", async ({
  page,
}) => {
  track(page);
  // 第 3 批:⑥-4 會載 Turnstile(本機瀏覽器連不到外網 ⇒ 換成假的,行為同官方必過測試 sitekey)。
  await mockTurnstile(page, "pass");
  // A:⑥-1 →「不登入，直接預約」→ ⑥-4
  await walkToForm(page, fixture.c1.slugA);
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-guest-button").click();
  await expect(page.getByTestId("customer-guest")).toContainText(
    "店家會用這支電話跟你聯絡服務細節（公司可填市話）。",
  );
  // 沒勾同意 / 沒填電話 ⇒ 停用 + 常駐原因(C3-D04)
  await expect(page.getByTestId("customer-guest-submit")).toBeDisabled();
  await expect(page.getByTestId("customer-guest-submit-reason")).toContainText(
    "請先勾選同意會員政策與隱私權政策，才能送出預約。",
  );
  await page.locator("#customer-guest-phone").fill("02-2345-6789");
  await page.getByTestId("customer-guest-consent").click();
  // 市話也收;填好 ⇒ 可以送出,原因消失
  await expect(page.getByTestId("customer-guest-submit")).toBeEnabled({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-guest-submit-reason")).toHaveCount(0);
  await shotBoth(page, "08_guest_ready");

  // B:沒有 LINE 登入(允許不登入)⇒ ⑤「確定預約」可以按,直接到 ⑥-4(C3-D01)
  await walkToForm(page, fixture.c1.slugB, "王小明", ITEM_B);
  await expect(page.getByTestId("public-booking-submit")).toBeEnabled();
  await expect(page.getByTestId("public-booking-submit")).toHaveText("確定預約");
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-guest")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-line-login")).toHaveCount(0);

  // A 關掉「允許不登入」⇒ ⑥-1 只有 LINE 登入
  const svc = serviceClient();
  const off = await svc
    .from("merchant_booking_settings")
    .upsert({ merchant_id: fixture.c1.merchantAId, allow_guest_booking: false })
    .select("merchant_id");
  expect(off.error).toBeNull();
  try {
    await walkToForm(page, fixture.c1.slugA);
    await page.getByTestId("public-booking-submit").click();
    await expect(page.getByTestId("customer-line-login")).toBeVisible();
    await expect(page.getByTestId("customer-guest-button")).toHaveCount(0);
    await shotBoth(page, "09_line_login_no_guest");
  } finally {
    await svc
      .from("merchant_booking_settings")
      .update({ allow_guest_booking: true })
      .eq("merchant_id", fixture.c1.merchantAId);
  }
});
