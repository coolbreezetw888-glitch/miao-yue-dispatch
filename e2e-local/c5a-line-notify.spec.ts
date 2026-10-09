// 客戶端第 5 批 5-A 本機 e2e:LINE 通知客人(前端 + 待發清單)。
// 規格書:.project/specs/客戶端第5批-LINE通知與綁定.md(M01~M04、F03、K01~K03、T 表 e2e-local);介面 .project/notes/c5-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c5a-line-notify`
// 🔴 不真的呼叫 LINE:本機 Vault 沒有 customer_line_cron_secret ⇒ 排程不會叫 Edge,待發列停在 pending 給測試斷言;
//    瀏覽器只打本機(request-guard);加好友連結只檢查網址,不點開。
// 待發清單 / 好友狀態表沒有對外權限 ⇒ 用 docker psql(本機限定)讀寫。
// 截圖:E2E_SHOT_DIR(預設 ../.project/notes/c5-shots),檔名 c5a-*,1280 / 375 各一。
//
// 涵蓋:
//   1. 店家沒接上官方帳號 ⇒ 會員中心沒有加好友卡、沒有 LINE 通知區塊;後台「通知客人」卡黃色 !
//   2. 接上後 ⇒ ⑧ 加好友卡(網址 = line.me/R/ti/p/%40@ID)、稍後再說、已加好友就不出現
//   3. ⑪-1 主要聯絡人:沒加好友黃 !、切「預約通知」寫進自己那列、重新整理仍然是關;回應沒有 LINE userId
//   4. ⑪-1 第二聯絡人:只改到自己那列
//   5. 後台「通知客人」卡:改開關 / 範本 / 恢復預設;店家事件卡沒有「會員」;客服視角
//   6. 後台確認訂單 ⇒ 待發列(customer_confirmed)+ 收件人(主要下單 1 人 / 第二聯絡人下單 2 人);彈窗只列店家這邊
//   7. 後台改時間兩次 ⇒ 只有一筆待發(原本時間記第一次之前);服務人員端改時間 ⇒ 沒有待發
//   8. 發送記錄「通知客人」篩選與新原因;會員詳細頁聯絡人卡新欄位;額度用完鈴鐺
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  injectSession,
  ITEM_INDOOR,
  serviceClient,
  SHOP_A_NAME,
} from "./support/c1-public-booking-fixture";
import { createCustomerSession, newLineSub, testPhone } from "./support/c2-line-login-fixture";
import { injectCustomerSession, LOAD_TIMEOUT } from "./support/c3-flow";
import { setupC3Fixture, teardownC3Fixture, type C3Fixture } from "./support/c3-submit-fixture";
import {
  collectMemberResponses,
  createMemberBooking,
  linkCustomerToMember,
} from "./support/c4-member-fixture";
import { readLocalSupabaseTarget } from "./support/local-target";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "../.project/notes/c5-shots";
const MEMBER_NAME = "C5會員王大明";
const LINE_A = "王大明的 LINE";
const LINE_B = "王太太的 LINE";
const BASIC_ID = "@c5e2etest";
const ADD_FRIEND_URL = "https://line.me/R/ti/p/%40c5e2etest";

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
const SUB_A = newLineSub();
const SUB_B = newLineSub();
let memberId = "";
let userA = "";
let userB = "";
let booking1 = "";
let booking2 = "";
let bookingDate = "";
let itemId = "";

// -------------------------------------------------------------------------
// 工具
// -------------------------------------------------------------------------

function psqlLocal(sql: string): string {
  readLocalSupabaseTarget();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const projectId = readFileSync(resolve(root, "supabase/config.toml"), "utf8").match(
    /^project_id\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (!projectId) throw new Error("讀不到 supabase/config.toml 的 project_id");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      `supabase_db_${projectId}`,
      "psql",
      "-U",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: sql, encoding: "utf8" },
  ).trim();
}

/** 只接受 uuid(組 SQL 前檢查,避免把奇怪的字串拼進去)。 */
function uuid(v: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`不是 uuid:${v}`);
  return v;
}

function plusDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isSunday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}
function taipeiIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
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
    await page.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(h, width === 375 ? 812 : 900) });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** 視窗 / 面板開著時截圖(不拉長視窗)。 */
async function shotOverlay(page: Page, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

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

function connectLine(): void {
  const m = uuid(fixture.c2.c1.merchantAId);
  psqlLocal(`
    insert into public.merchant_line_configs
      (merchant_id, channel_id, channel_secret, channel_access_token, line_bot_basic_id, display_name, is_connected)
    values ('${m}', 'C5E2ECHANNEL', 'C5E2E-FAKE-SECRET', 'C5E2E-FAKE-TOKEN', '${BASIC_ID}', 'C5 測試官方帳號', true)
    on conflict (merchant_id) do update
      set is_connected = true, line_bot_basic_id = excluded.line_bot_basic_id,
          channel_access_token = excluded.channel_access_token;
  `);
}

function setFriend(sub: string, isFriend: boolean | null): void {
  const m = uuid(fixture.c2.c1.merchantAId);
  if (!/^U[0-9a-f]{32}$/.test(sub)) throw new Error("sub 格式不對");
  if (isFriend === null) {
    psqlLocal(
      `delete from public.customer_line_friendships where merchant_id = '${m}' and line_user_id = '${sub}';`,
    );
    return;
  }
  psqlLocal(`
    insert into public.customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at)
    values ('${m}', '${sub}', ${isFriend}, 'webhook', now())
    on conflict (merchant_id, line_user_id) do update set is_friend = excluded.is_friend, changed_at = now();
  `);
}

interface OutboxRow {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
}

function outboxOf(bookingId: string): OutboxRow[] {
  const out = psqlLocal(`
    select coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'status', status, 'payload', payload)
      order by created_at), '[]'::json)
    from public.customer_line_outbox where booking_id = '${uuid(bookingId)}';
  `);
  return JSON.parse(out || "[]") as OutboxRow[];
}

function recipientsOf(outboxId: string): { user_id: string }[] {
  // resolve 回 { recipients: [{ to, target_user_id, contact_id, ... }] };這裡只取帳號 id(不印 LINE userId)。
  const out = psqlLocal(
    `select private.resolve_customer_line_recipients('${uuid(outboxId)}')::text;`,
  );
  const parsed = JSON.parse(out) as { recipients?: { target_user_id: string }[] };
  return (parsed.recipients ?? []).map((r) => ({ user_id: r.target_user_id }));
}

function contactPrefs(): { user_id: string; notify_booking: boolean }[] {
  const out = psqlLocal(`
    select coalesce(json_agg(json_build_object('user_id', user_id, 'notify_booking', notify_booking)), '[]'::json)
    from public.member_customer_contacts where member_id = '${uuid(memberId)}' and status = 'active';
  `);
  return JSON.parse(out || "[]") as { user_id: string; notify_booking: boolean }[];
}

// -------------------------------------------------------------------------
// 準備 / 清理
// -------------------------------------------------------------------------

test.beforeAll(async () => {
  test.setTimeout(300_000);
  mkdirSync(SHOT_DIR, { recursive: true });
  try {
    fixture = await setupC3Fixture();
    const c1 = fixture.c2.c1;
    const svc = serviceClient();
    bookingDate = plusDays(c1.dateLeave, 1);
    while (isSunday(bookingDate)) bookingDate = plusDays(bookingDate, 1);
    const item = await svc
      .from("service_items")
      .select("id")
      .eq("merchant_id", c1.merchantAId)
      .eq("name", ITEM_INDOOR)
      .single();
    itemId = item.data!.id as string;
    // 客人單要「待確認」才能測後台確認 ⇒ 阿明不要自動接單(只動本 fixture 的服務人員)。
    const st = await svc
      .from("merchant_staff")
      .update({ auto_accept_booking: false })
      .eq("id", c1.staffMingId)
      .eq("merchant_id", c1.merchantAId)
      .select("id");
    if ((st.data ?? []).length !== 1) throw new Error("關閉阿明自動接單失敗");

    const sessionA = await createCustomerSession(fixture.c2, SUB_A, LINE_A);
    userA = sessionA.user.id;
    memberId = await linkCustomerToMember({
      session: sessionA,
      slug: c1.slugA,
      merchantId: c1.merchantAId,
      phone: testPhone(fixture.c2, 91),
      name: MEMBER_NAME,
    });
    // 第二聯絡人(王太太):本機直接加一列聯絡人(4-B 的加入流程在 c4b 已驗)。
    const sessionB = await createCustomerSession(fixture.c2, SUB_B, LINE_B);
    userB = sessionB.user.id;
    psqlLocal(`
      insert into public.member_customer_contacts (merchant_id, member_id, user_id, is_primary, contact_phone, joined_via, status)
      values ('${uuid(c1.merchantAId)}', '${uuid(memberId)}', '${uuid(userB)}', false, '${testPhone(fixture.c2, 92)}', 'store', 'active');
    `);
    // 店家還沒接上官方帳號時下的單 ⇒ 不會有待發列。
    booking1 = await createMemberBooking({
      slug: c1.slugA,
      userId: userA,
      itemId,
      staffId: c1.staffMingId,
      date: bookingDate,
      time: "10:00",
      name: MEMBER_NAME,
    });
    // 客服也給「LINE 通知」權限(客服視角截圖用;只動本 fixture 的客服)。
    const perm = await c1.admin.rpc("set_agent_permission", {
      p_agent_id: fixture.c2.agent.agentId,
      p_section_key: "line_notification",
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 LINE 通知權限失敗:${perm.error.message}`);
    console.log(`[c5a 本機] fixture 建好(A=${c1.slugA},預約日 ${bookingDate})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(300_000);
  if (setupFailed || !fixture) return;
  const m = uuid(fixture.c2.c1.merchantAId);
  // 先用同一個條件 SELECT 核對都是本 fixture 商家的列(第 5 批新表 + 我加的官方帳號設定),再交給商家刪除 cascade。
  const check = psqlLocal(`
    select (select count(*) from public.customer_line_outbox where merchant_id = '${m}') || ',' ||
           (select count(*) from public.customer_line_friendships where merchant_id = '${m}') || ',' ||
           (select count(*) from public.merchant_line_configs where merchant_id = '${m}' and channel_id = 'C5E2ECHANNEL') || ',' ||
           (select count(*) from public.line_notification_log where merchant_id = '${m}');
  `);
  console.log(`[c5a 本機] 清理前(outbox,friendships,line_configs,log)= ${check}`);
  psqlLocal(
    `delete from public.merchant_line_configs where merchant_id = '${m}' and channel_id = 'C5E2ECHANNEL';`,
  );
  const actions = await teardownC3Fixture(fixture);
  const left = psqlLocal(`
    select (select count(*) from public.customer_line_outbox where merchant_id = '${m}') +
           (select count(*) from public.customer_line_friendships where merchant_id = '${m}') +
           (select count(*) from public.merchant_customer_line_settings where merchant_id = '${m}') +
           (select count(*) from public.line_notification_log where merchant_id = '${m}');
  `);
  actions.push(`第 5 批相關列剩 ${left} 列(商家刪除時一起刪)`);
  console.log("[c5a 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  for (const r of recorders) expectOnlyLocalRequests(r);
});

// -------------------------------------------------------------------------
// 測試
// -------------------------------------------------------------------------

test("店家沒接上官方帳號 ⇒ 會員中心不承諾 LINE 通知;後台「通知客人」卡黃色 !", async ({
  page,
  browser,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  expect(outboxOf(booking1), "沒接上時下的單不寫待發列").toEqual([]);
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me`);
  await expect(page.getByTestId("member-home-greeting")).toHaveText(`${MEMBER_NAME}，你好`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("member-home-add-friend")).toHaveCount(0);
  await shot(page, "c5a-01-home-not-connected");
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(page.getByTestId("member-profile-line")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(800);
  await expect(page.getByTestId("member-line-notify")).toHaveCount(0);

  const admin = await newPage(browser);
  await asAdmin(admin);
  await admin.goto("/app/line-events");
  const note = admin.getByTestId("customer-line-not-connected");
  await expect(note).toContainText("還沒有接上 LINE 官方帳號，接上之後才會通知客人。", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(note.getByRole("link", { name: "去 LINE 串接設定" })).toBeVisible();
  await shot(admin, "c5a-02-admin-not-connected");
  await admin.context().close();
  connectLine();
});

test("C5-M01 ⑧ 加好友提示卡:網址、稍後再說、已加好友就不出現", async ({ page }) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me`);
  const card = page.getByTestId("member-home-add-friend");
  await expect(card).toContainText(`加入「${SHOP_A_NAME}」LINE 好友`, { timeout: LOAD_TIMEOUT });
  // 主腦裁決 #7:服務前提醒預設關,文案不承諾會發。
  await expect(card).toContainText("預約確認、改時間等消息都會用 LINE 通知你。");
  await expect(card.getByTestId("member-home-add-friend-go")).toHaveAttribute(
    "href",
    ADD_FRIEND_URL,
  );
  await shot(page, "c5a-03-home-add-friend");

  await card.getByTestId("member-home-add-friend-later").click();
  await expect(page.getByTestId("member-home-add-friend")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-home-add-friend")).toHaveCount(0);

  // 清掉「稍後再說」、改成已加好友 ⇒ 一樣不出現。
  await page.evaluate(() => window.localStorage.clear());
  setFriend(SUB_A, true);
  await page.reload();
  await expect(page.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(800);
  await expect(page.getByTestId("member-home-add-friend")).toHaveCount(0);
  await shot(page, "c5a-04-home-friend-no-card");
  setFriend(SUB_A, null);
});

test("C5-M02 ⑪-1 主要聯絡人:沒加好友黃 !、切預約通知寫進自己那列、回應沒有 LINE userId", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  const bodies = collectMemberResponses(page);
  setFriend(SUB_A, false);
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const section = page.getByTestId("member-line-notify");
  await expect(section).toContainText("預約通知", { timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-line-notify-not-friend")).toContainText(
    "你還沒有加入店家的 LINE 好友，開著也收不到通知。",
  );
  // 5-B(#1047)起「優惠通知」開關一起出現。
  await expect(section).toContainText("優惠通知");
  await shot(page, "c5a-05-profile-primary-not-friend");

  const sw = section.getByRole("switch", { name: "預約通知" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await expect(sw).toBeEnabled();
  await expect
    .poll(() => contactPrefs().find((c) => c.user_id === userA)?.notify_booking)
    .toBe(false);
  expect(contactPrefs().find((c) => c.user_id === userB)?.notify_booking).toBe(true);
  await page.reload();
  await expect(
    page.getByTestId("member-line-notify").getByRole("switch", { name: "預約通知" }),
  ).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  // 預約通知關掉 ⇒ 首頁不再出現加好友卡。
  await page.goto(`/booking/${c1.slugA}/me`);
  await expect(page.getByTestId("member-home-greeting")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(800);
  await expect(page.getByTestId("member-home-add-friend")).toHaveCount(0);

  // 開回來;好友狀態改回「不確定」⇒ 沒有黃 !
  setFriend(SUB_A, null);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const sw2 = page.getByTestId("member-line-notify").getByRole("switch", { name: "預約通知" });
  await sw2.click({ timeout: LOAD_TIMEOUT });
  await expect(sw2).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("member-line-notify-not-friend")).toHaveCount(0);
  await shot(page, "c5a-06-profile-primary");

  // C5-X03:客人函式回應搜不到 LINE userId。
  await page.waitForTimeout(500);
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) {
    expect(b).not.toContain(SUB_A);
    expect(b).not.toContain(SUB_B);
    expect(b).not.toContain("C5E2E-FAKE-TOKEN");
  }
});

test("C5-M02 ⑪-1 第二聯絡人:只改到自己那列", async ({ page }) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asCustomer(page, SUB_B, LINE_B);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  await expect(page.getByTestId("member-profile-readonly")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const sw = page.getByTestId("member-line-notify").getByRole("switch", { name: "預約通知" });
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await shot(page, "c5a-07-profile-secondary");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() => contactPrefs().find((c) => c.user_id === userB)?.notify_booking)
    .toBe(false);
  expect(contactPrefs().find((c) => c.user_id === userA)?.notify_booking).toBe(true);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
});

test("C5-K01 / K02 後台「通知客人」卡:改開關 / 範本 / 恢復預設;店家事件卡沒有「會員」;客服視角", async ({
  page,
  browser,
}) => {
  track(page);
  const m = uuid(fixture.c2.c1.merchantAId);
  await asAdmin(page);
  await page.goto("/app/line-events");
  const card = page.getByTestId("customer-line-card");
  await expect(card.getByTestId("customer-line-kind-on_confirmed")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("customer-line-not-connected")).toHaveCount(0);
  // 5-B(#1047)加服務前提醒、服務完成、聯絡人申請與移除 ⇒ 9 種。
  await expect(card.getByRole("switch")).toHaveCount(9);
  await expect(card).toContainText("服務前提醒");
  for (const t of ["booking_created", "booking_confirmed", "booking_cancelled"]) {
    await expect(
      page.getByTestId(`line-event-card-${t}`).getByRole("button", { name: /會員/ }),
    ).toHaveCount(0);
  }
  await shot(page, "c5a-08-admin-customer-card");

  // 開關:立即儲存
  const confirmedSwitch = card.getByTestId("customer-line-kind-on_confirmed").getByRole("switch");
  await confirmedSwitch.click();
  await expect(confirmedSwitch).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() =>
      psqlLocal(
        `select on_confirmed from public.merchant_customer_line_settings where merchant_id = '${m}';`,
      ),
    )
    .toBe("f");
  await confirmedSwitch.click();
  await expect(confirmedSwitch).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() =>
      psqlLocal(
        `select on_confirmed from public.merchant_customer_line_settings where merchant_id = '${m}';`,
      ),
    )
    .toBe("t");

  // 範本:改 ⇒ 存 ⇒ 恢復預設
  const row = card.getByTestId("customer-line-kind-on_confirmed");
  await row.getByTestId("customer-line-edit-toggle").click();
  const editor = row.getByTestId("customer-line-template-confirmed");
  const textarea = editor.getByRole("textbox");
  await expect(textarea).toHaveValue(/已確認你的預約/);
  await textarea.fill("「{{merchant_name}}」確認了，{{member_name}} 到時見！");
  await expect(editor).toContainText(`「${SHOP_A_NAME}」確認了，王小明 到時見！`);
  await shot(page, "c5a-09-admin-template-edit");
  await editor.getByTestId("customer-line-template-save").click();
  await expect
    .poll(() =>
      psqlLocal(
        `select templates->>'confirmed' from public.merchant_customer_line_settings where merchant_id = '${m}';`,
      ),
    )
    .toBe("「{{merchant_name}}」確認了，{{member_name}} 到時見！");
  const confirmedTemplate = () =>
    psqlLocal(
      `select coalesce(templates->>'confirmed', '(預設)') from public.merchant_customer_line_settings where merchant_id = '${m}';`,
    );
  // 恢復預設 ⇒ 確認窗(危險樣式)⇒ 確認 ⇒ 窗關閉、資料庫回預設。
  await editor.getByTestId("customer-line-template-restore").click();
  const restoreDialog = page.getByTestId("customer-line-template-restore-dialog");
  await expect(restoreDialog).toContainText(
    "你自訂的通知文字會被刪掉，改回系統預設文字，刪掉後無法還原。",
  );
  await shotOverlay(page, "c5a-09b-admin-template-restore-confirm");
  await restoreDialog.getByTestId("customer-line-template-restore-confirm").click();
  await expect(restoreDialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect.poll(confirmedTemplate).toBe("(預設)");
  await expect(textarea).toHaveValue(/已確認你的預約/);

  // 有自訂文字時,清空按「儲存文字」⇒ 一樣跳確認窗 ⇒ 確認 ⇒ 資料庫回預設。
  await textarea.fill("自訂文字，等一下清空");
  await editor.getByTestId("customer-line-template-save").click();
  await expect.poll(confirmedTemplate).toBe("自訂文字，等一下清空");
  await textarea.fill("");
  await editor.getByTestId("customer-line-template-save").click();
  await expect(restoreDialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(confirmedTemplate(), "按確認之前不送出").toBe("自訂文字，等一下清空");
  await restoreDialog.getByTestId("customer-line-template-restore-confirm").click();
  await expect(restoreDialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect.poll(confirmedTemplate).toBe("(預設)");
  await expect(textarea).toHaveValue(/已確認你的預約/);

  // 客服視角(有 LINE 通知權限):看得到同一張卡
  const agentPage = await newPage(browser);
  await injectSession(agentPage, fixture.c2.agent.session);
  await primeCurrentMerchant(agentPage, LOAD_TIMEOUT);
  await agentPage.goto("/app/line-events");
  await expect(
    agentPage.getByTestId("customer-line-card").getByTestId("customer-line-kind-on_confirmed"),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await shot(agentPage, "c5a-10-admin-customer-card-agent");
  await agentPage.context().close();
});

test("後台確認訂單 ⇒ 待發列 + 收件人正確;彈窗只列店家這邊", async ({ page }) => {
  track(page);
  const c1 = fixture.c2.c1;
  // 彈窗:預覽故意回服務人員 + 會員,畫面只能出現服務人員。
  await page.route(/\/rest\/v1\/rpc\/preview_line_notification_targets/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        has_any_target: true,
        targets: [
          { type: "staff", name: "阿明" },
          { type: "member", name: MEMBER_NAME },
        ],
      }),
    });
  });
  let dispatchCalls = 0;
  await page.route("**/functions/v1/line-notify-dispatch", async (route) => {
    dispatchCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await asAdmin(page);
  await page.goto("/app/orders");
  const search = page.getByLabel("搜尋訂單");
  await expect(search).toBeVisible({ timeout: LOAD_TIMEOUT });
  await search.fill(MEMBER_NAME);
  const cardRow = page.locator('[role="button"]').filter({ hasText: MEMBER_NAME }).first();
  await cardRow.click({ timeout: LOAD_TIMEOUT });
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await detail.getByRole("button", { name: "確認訂單" }).click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toContainText("要透過 LINE 通知這次確認嗎？", { timeout: LOAD_TIMEOUT });
  await expect(alert).toContainText("服務人員 阿明(LINE)");
  await expect(alert).not.toContainText(MEMBER_NAME);
  await expect(page.getByTestId("confirm-line-customer-note")).toBeVisible();
  await shotOverlay(page, "c5a-11-confirm-dialog-store-only");
  await alert.getByRole("button", { name: "否，只確認不通知" }).click();
  await expect
    .poll(async () => {
      const b = await serviceClient().from("bookings").select("status").eq("id", booking1).single();
      return b.data?.status;
    })
    .toBe("accepted");
  expect(dispatchCalls).toBe(0);

  const rows = outboxOf(booking1);
  const confirmed = rows.filter((r) => r.kind === "customer_confirmed");
  expect(confirmed, "確認後有一筆 customer_confirmed 待發").toHaveLength(1);
  expect(confirmed[0]!.status).toBe("pending");
  // 主要聯絡人自己下的單 ⇒ 只有主要聯絡人(第二聯絡人沒下這張單不收)。
  expect(recipientsOf(confirmed[0]!.id).map((r) => r.user_id)).toEqual([userA]);

  // 第二聯絡人下單 ⇒ 待發 customer_submitted;店家確認 ⇒ 下單的人 + 主要聯絡人 = 2 人。
  booking2 = await createMemberBooking({
    slug: c1.slugA,
    userId: userB,
    itemId,
    staffId: c1.staffMingId,
    date: bookingDate,
    time: "14:00",
    name: MEMBER_NAME,
  });
  expect(outboxOf(booking2).map((r) => r.kind)).toContain("customer_submitted");
  const conf = await c1.admin.rpc("confirm_booking", { p_booking_id: booking2 });
  expect(conf.error).toBeNull();
  const c2rows = outboxOf(booking2).filter((r) => r.kind === "customer_confirmed");
  expect(c2rows).toHaveLength(1);
  expect(
    recipientsOf(c2rows[0]!.id)
      .map((r) => r.user_id)
      .sort(),
  ).toEqual([userA, userB].sort());
});

test("後台改時間兩次 ⇒ 只有一筆待發(原本時間記第一次之前);服務人員改時間 ⇒ 沒有待發", async () => {
  const c1 = fixture.c2.c1;
  const svc = serviceClient();
  const before = await svc.from("bookings").select("start_at").eq("id", booking1).single();
  const original = before.data!.start_at as string;
  let current = original;
  // 搬到隔天(不跟 14:00 那張重疊),再改一次時間。
  let nextDay = plusDays(bookingDate, 1);
  while (isSunday(nextDay)) nextDay = plusDays(nextDay, 1);
  for (const time of ["10:00", "11:00"]) {
    const target = taipeiIso(nextDay, time);
    const moved = await c1.admin.rpc("move_booking", {
      p_booking_id: booking1,
      p_dragged_staff_id: c1.staffMingId,
      p_expected_staff_id: c1.staffMingId,
      p_target_staff_id: c1.staffMingId,
      p_expected_start_at: current,
      p_target_start_at: target,
    });
    expect(moved.error, `後台改到 ${time}`).toBeNull();
    const now = await svc.from("bookings").select("start_at").eq("id", booking1).single();
    current = now.data!.start_at as string;
  }
  const resched = outboxOf(booking1).filter(
    (r) => r.kind === "customer_rescheduled" && r.status === "pending",
  );
  expect(resched, "改兩次只有一筆待發").toHaveLength(1);
  expect(new Date(String(resched[0]!.payload["old_start_at"])).toISOString()).toBe(
    new Date(original).toISOString(),
  );

  // 服務人員端改時間(#986:不通知客人)⇒ 沒有新的 customer_rescheduled。
  // 阿明要能自己改單(#977:can_create_edit_orders + show_member_info + 行事曆檢視;只動本 fixture 的服務人員)。
  const opened = await svc
    .from("merchant_staff")
    .update({ can_create_edit_orders: true, show_member_info: true })
    .eq("id", c1.staffMingId)
    .eq("merchant_id", c1.merchantAId)
    .select("id");
  expect((opened.data ?? []).length).toBe(1);
  const calView = await c1.admin.rpc("set_staff_permission", {
    p_staff_id: c1.staffMingId,
    p_section_key: "staff_calendar_view",
    p_granted: true,
  });
  expect(calView.error).toBeNull();
  const staffClient = await (async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { url, publishableKey } = readLocalSupabaseTarget();
    const cl = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await cl.auth.setSession({
      access_token: fixture.staffUser.session.access_token,
      refresh_token: fixture.staffUser.session.refresh_token,
    });
    return cl;
  })();
  const b2 = await svc.from("bookings").select("start_at").eq("id", booking2).single();
  const staffMove = await staffClient.rpc("staff_move_booking", {
    p_booking_id: booking2,
    p_expected_start_at: b2.data!.start_at as string,
    p_target_start_at: taipeiIso(bookingDate, "15:00"),
  });
  expect(staffMove.error, "服務人員改時間").toBeNull();
  const after = await svc.from("bookings").select("start_at").eq("id", booking2).single();
  expect(new Date(after.data!.start_at as string).toISOString()).toBe(
    taipeiIso(bookingDate, "15:00"),
  );
  expect(outboxOf(booking2).filter((r) => r.kind === "customer_rescheduled")).toEqual([]);
});

test("C5-K03 發送記錄「通知客人」+ C5-F03 會員聯絡人卡 + 額度用完鈴鐺", async ({ page }) => {
  track(page);
  const c1 = fixture.c2.c1;
  const m = uuid(c1.merchantAId);
  // 假的發送記錄(本機;dispatcher 本機不會真的發)。
  psqlLocal(`
    insert into public.line_notification_log
      (merchant_id, event_type, booking_id, target_type, target_id, target_user_id, status, skip_reason, rendered_message)
    values
      ('${m}', 'customer_confirmed', '${uuid(booking1)}', 'member', '${uuid(memberId)}', '${uuid(userA)}', 'sent', null, '「${SHOP_A_NAME}」已確認你的預約。'),
      ('${m}', 'customer_confirmed', '${uuid(booking2)}', 'member', '${uuid(memberId)}', '${uuid(userB)}', 'skipped', 'customer_opted_out', null),
      ('${m}', 'customer_rescheduled', '${uuid(booking1)}', 'member', '${uuid(memberId)}', '${uuid(userA)}', 'skipped', 'not_friend', null);
  `);
  const adminRow = await serviceClient()
    .from("merchant_admins")
    .select("id")
    .eq("merchant_id", c1.merchantAId)
    .eq("user_id", c1.userId)
    .single();
  psqlLocal(`
    insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
    values ('${uuid(c1.userId)}', '${m}', 'admin', '${uuid(adminRow.data!.id as string)}', 'line_quota_exhausted',
      'LINE 訊息額度已用完',
      'LINE 官方帳號本月訊息額度已用完，這個月的 LINE 通知（包含員工通知）都會發送失敗，下個月 1 日自動恢復。');
  `);

  await asAdmin(page);
  await page.goto("/app/line-logs");
  await expect(page.getByRole("heading", { name: "LINE 發送記錄" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByLabel("篩選事件類型").click();
  await page.getByRole("option", { name: "通知客人（全部）" }).click();
  await expect(page.getByText("通知客人：店家確認").first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText(`會員${MEMBER_NAME}（聯絡人：${LINE_A}）`).first()).toBeVisible();
  // 兩筆跳過的各展開一次(一次只展開一筆)⇒ 看得到新原因中文。
  const optedOut = page.locator("li").filter({ hasText: "跳過" }).filter({ hasText: LINE_B });
  await optedOut.getByRole("button", { name: "查看詳情" }).click();
  await expect(optedOut).toContainText("客人關閉通知");
  const notFriend = page.locator("li").filter({ hasText: "通知客人：改時間" });
  await notFriend.getByRole("button", { name: "查看詳情" }).click();
  await expect(notFriend).toContainText("客人沒加好友");
  await shot(page, "c5a-12-line-logs-customer");

  await page.goto(`/app/members/${memberId}`);
  const contactsCard = page.getByTestId("member-contacts-card");
  await expect(contactsCard.getByTestId("member-contacts-card-notify").first()).toContainText(
    "LINE 好友：",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(contactsCard).toContainText("預約通知：開");
  await contactsCard.scrollIntoViewIfNeeded();
  await shot(page, "c5a-13-member-contacts-notify");

  await page.goto("/app/orders");
  await page.getByTestId("notification-bell").click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("LINE 訊息額度已用完")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await shotOverlay(page, "c5a-14-bell-quota-exhausted");
  await page.getByText("LINE 訊息額度已用完").click();
  await expect(page).toHaveURL(/\/app\/line-events$/, { timeout: LOAD_TIMEOUT });
});
