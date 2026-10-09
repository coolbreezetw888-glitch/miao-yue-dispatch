// 客戶端第 5 批 5-B(#1047)本機 e2e:提醒 / 完成 / 聯絡人通知開關、本月額度、每月上限、優惠通知開關、行銷確認窗。
// 規格書:.project/specs/客戶端第5批-LINE通知與綁定.md(第五節 5-B:N07~N12、Q01~Q04、P01、K02 上限欄位);
// 介面 .project/notes/c5-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c5b-line-notify`
// 🔴 不真的呼叫 LINE:瀏覽器只打本機(request-guard);行銷確認窗只看數字、按「再想想」,不送出。
// 設定表 / 好友表 / 發送記錄 / 鈴鐺用 docker psql(本機限定)準備與核對。
// 截圖:E2E_SHOT_DIR(預設 ../.project/notes/c5-shots),檔名 c5b-*,1280 / 375 各一。
//
// 涵蓋:
//   1. 沒接上官方帳號:管理員看得到上限欄、看不到本月用量;客服整個額度區不出現
//   2. 接上後:9 種通知(提醒預設關、完成預設關、聯絡人預設開);服務前 N 小時改了寫進資料庫;提醒範本預覽「明天」
//   3. 本月額度(秒約統計)+ 每月上限存 150 / 清空;停發中紅字;客服視角沒有上限欄
//   4. 會員中心 ⑪-1 兩個開關(主要 / 第二聯絡人各改自己那列的「優惠通知」)、⑧ 文案加回「服務前提醒」
//   5. 後台會員聯絡人卡顯示「優惠通知」
//   6. 再行銷通知:名單「可收到 X 人」、確認窗「N 位會員，共 M 則訊息」
//   7. 兩種額度鈴鐺(80% / 用完)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { injectSession, SHOP_A_NAME } from "./support/c1-public-booking-fixture";
import { createCustomerSession, newLineSub, testPhone } from "./support/c2-line-login-fixture";
import { injectCustomerSession, LOAD_TIMEOUT } from "./support/c3-flow";
import { setupC3Fixture, teardownC3Fixture, type C3Fixture } from "./support/c3-submit-fixture";
import { linkCustomerToMember } from "./support/c4-member-fixture";
import { readLocalSupabaseTarget } from "./support/local-target";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "../.project/notes/c5-shots";
const MEMBER_NAME = "C5B會員林大同";
const LINE_A = "林大同的 LINE";
const LINE_B = "林太太的 LINE";
const BASIC_ID = "@c5be2etest";

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
const SUB_A = newLineSub();
const SUB_B = newLineSub();
let memberId = "";
let userA = "";
let userB = "";

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

function uuid(v: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`不是 uuid:${v}`);
  return v;
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

/** 某個元素的截圖(長頁面只截那一塊),1280 + 375 各一。 */
async function shotElement(page: Page, testId: string, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    await page.getByTestId(testId).screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
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

async function asAgent(page: Page): Promise<void> {
  await injectSession(page, fixture.c2.agent.session);
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
    values ('${m}', 'C5BE2ECHANNEL', 'C5BE2E-FAKE-SECRET', 'C5BE2E-FAKE-TOKEN', '${BASIC_ID}', 'C5B 測試官方帳號', true)
    on conflict (merchant_id) do update
      set is_connected = true, line_bot_basic_id = excluded.line_bot_basic_id,
          channel_access_token = excluded.channel_access_token;
  `);
}

function settingOf(column: string): string {
  if (!/^[a-z_]+$/.test(column)) throw new Error("欄位名稱不對");
  return psqlLocal(
    `select coalesce(${column}::text, 'NULL') from public.merchant_customer_line_settings where merchant_id = '${uuid(fixture.c2.c1.merchantAId)}';`,
  );
}

function contactPromo(): { user_id: string; notify_promo: boolean }[] {
  const out = psqlLocal(`
    select coalesce(json_agg(json_build_object('user_id', user_id, 'notify_promo', notify_promo)), '[]'::json)
    from public.member_customer_contacts where member_id = '${uuid(memberId)}' and status = 'active';
  `);
  return JSON.parse(out || "[]") as { user_id: string; notify_promo: boolean }[];
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
    const sessionA = await createCustomerSession(fixture.c2, SUB_A, LINE_A);
    userA = sessionA.user.id;
    memberId = await linkCustomerToMember({
      session: sessionA,
      slug: c1.slugA,
      merchantId: c1.merchantAId,
      phone: testPhone(fixture.c2, 81),
      name: MEMBER_NAME,
    });
    // 第二聯絡人:本機直接加一列聯絡人(4-B 的加入流程在 c4b 已驗)。
    const sessionB = await createCustomerSession(fixture.c2, SUB_B, LINE_B);
    userB = sessionB.user.id;
    psqlLocal(`
      insert into public.member_customer_contacts (merchant_id, member_id, user_id, is_primary, contact_phone, joined_via, status)
      values ('${uuid(c1.merchantAId)}', '${uuid(memberId)}', '${uuid(userB)}', false, '${testPhone(fixture.c2, 82)}', 'store', 'active');
    `);
    // 客服給「LINE 通知」權限(客服視角用;只動本 fixture 的客服)。
    const perm = await c1.admin.rpc("set_agent_permission", {
      p_agent_id: fixture.c2.agent.agentId,
      p_section_key: "line_notification",
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 LINE 通知權限失敗:${perm.error.message}`);
    console.log(`[c5b 本機] fixture 建好(A=${c1.slugA})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(300_000);
  if (setupFailed || !fixture) return;
  const m = uuid(fixture.c2.c1.merchantAId);
  // 先用同一個條件 SELECT 核對都是本 fixture 商家的列,再刪(商家刪除時其餘一起 cascade)。
  const check = psqlLocal(`
    select (select count(*) from public.merchant_line_configs where merchant_id = '${m}' and channel_id = 'C5BE2ECHANNEL') || ',' ||
           (select count(*) from public.merchant_customer_line_settings where merchant_id = '${m}') || ',' ||
           (select count(*) from public.line_notification_log where merchant_id = '${m}') || ',' ||
           (select count(*) from public.user_notifications where merchant_id = '${m}' and event_type in ('line_quota_warning', 'line_quota_exhausted'));
  `);
  console.log(`[c5b 本機] 清理前(line_configs,settings,log,quota 鈴鐺)= ${check}`);
  psqlLocal(
    `delete from public.merchant_line_configs where merchant_id = '${m}' and channel_id = 'C5BE2ECHANNEL';`,
  );
  const actions = await teardownC3Fixture(fixture);
  const left = psqlLocal(`
    select (select count(*) from public.customer_line_outbox where merchant_id = '${m}') +
           (select count(*) from public.merchant_customer_line_settings where merchant_id = '${m}') +
           (select count(*) from public.line_notification_log where merchant_id = '${m}');
  `);
  actions.push(`第 5 批相關列剩 ${left} 列(商家刪除時一起刪)`);
  console.log("[c5b 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
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

test("沒接上官方帳號:管理員有上限欄、沒有本月用量;客服整個額度區不出現", async ({
  page,
  browser,
}) => {
  track(page);
  await asAdmin(page);
  await page.goto("/app/line-events");
  const card = page.getByTestId("customer-line-card");
  await expect(page.getByTestId("customer-line-not-connected")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByTestId("customer-line-monthly-cap")).toBeVisible();
  await expect(card.getByTestId("customer-line-quota-summary")).toHaveCount(0);
  await shotElement(page, "customer-line-card", "c5b-01-admin-not-connected");

  const agent = await newPage(browser);
  await asAgent(agent);
  await agent.goto("/app/line-events");
  await expect(agent.getByTestId("customer-line-not-connected")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(agent.getByTestId("customer-line-quota")).toHaveCount(0);
  await agent.context().close();
  connectLine();
});

test("C5-K02 9 種通知、服務前 N 小時、提醒範本預覽", async ({ page }) => {
  track(page);
  await asAdmin(page);
  await page.goto("/app/line-events");
  const card = page.getByTestId("customer-line-card");
  await expect(card.getByTestId("customer-line-kind-on_reminder")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByRole("switch")).toHaveCount(9);
  const sw = (key: string) => card.getByTestId(`customer-line-kind-${key}`).getByRole("switch");
  await expect(sw("on_reminder")).toHaveAttribute("aria-checked", "false");
  await expect(sw("on_completed")).toHaveAttribute("aria-checked", "false");
  await expect(sw("on_contact_events")).toHaveAttribute("aria-checked", "true");
  await expect(card).toContainText("客人可以在會員中心自己關掉預約通知或優惠通知。");

  // 打開服務前提醒、改成 6 小時 ⇒ 資料庫。
  await sw("on_reminder").click();
  await expect(sw("on_reminder")).toHaveAttribute("aria-checked", "true", {
    timeout: LOAD_TIMEOUT,
  });
  await expect.poll(() => settingOf("on_reminder")).toBe("true");
  const hours = card.getByTestId("customer-line-reminder-hours");
  await expect(hours).toHaveValue("24");
  await hours.selectOption("6");
  await expect.poll(() => settingOf("reminder_hours_before")).toBe("6");
  await page.reload();
  await expect(page.getByTestId("customer-line-reminder-hours")).toHaveValue("6", {
    timeout: LOAD_TIMEOUT,
  });

  // 提醒範本:預覽代入「明天」。
  const reminderRow = page.getByTestId("customer-line-kind-on_reminder");
  await reminderRow.getByTestId("customer-line-edit-toggle").click();
  const editor = reminderRow.getByTestId("customer-line-template-reminder");
  await expect(editor).toContainText("客人實際會收到");
  await expect(editor).toContainText(`提醒您：明天 10:00`);
  await expect(editor).toContainText(`在「${SHOP_A_NAME}」有預約。`);
  await reminderRow.scrollIntoViewIfNeeded();
  await shotElement(page, "customer-line-kind-on_reminder", "c5b-02-reminder-row-editor");

  // 聯絡人通知:4 段文字。
  const contactRow = page.getByTestId("customer-line-kind-on_contact_events");
  await contactRow.getByTestId("customer-line-edit-toggle").click();
  for (const code of [
    "contact_request",
    "contact_removed",
    "contact_approved",
    "contact_rejected",
  ]) {
    await expect(contactRow.getByTestId(`customer-line-template-${code}`)).toBeVisible();
  }
  await expect(contactRow.getByTestId("customer-line-template-contact_request")).toContainText(
    "王太太 申請成為您在",
  );
  await contactRow.getByTestId("customer-line-edit-toggle").click();
  await reminderRow.getByTestId("customer-line-edit-toggle").click();
  await shot(page, "c5b-03-admin-customer-card");
});

test("C5-Q01 / Q02 本月額度、每月上限、停發中;客服看不到上限", async ({ page, browser }) => {
  track(page);
  const c1 = fixture.c2.c1;
  const m = uuid(c1.merchantAId);
  // 本月的假發送記錄(本機;客人 2、員工 1、行銷 1)⇒ 本月用量的秒約統計。
  psqlLocal(`
    insert into public.line_notification_log (merchant_id, event_type, target_type, target_id, target_user_id, status)
    values
      ('${m}', 'customer_confirmed', 'member', '${uuid(memberId)}', '${uuid(userA)}', 'sent'),
      ('${m}', 'customer_reminder', 'member', '${uuid(memberId)}', '${uuid(userA)}', 'sent'),
      ('${m}', 'booking_created', 'admin', '${uuid(memberId)}', null, 'sent'),
      ('${m}', 'marketing_manual', 'member', '${uuid(memberId)}', null, 'sent');
  `);
  await asAdmin(page);
  await page.goto("/app/line-events");
  const quota = page.getByTestId("customer-line-quota");
  await expect(quota.getByTestId("customer-line-quota-summary")).toContainText(
    "（客人通知 2、員工通知 1、行銷 1）",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(quota.getByTestId("customer-line-quota-blocked")).toHaveCount(0);

  const input = quota.getByTestId("customer-line-monthly-cap-input");
  const save = quota.getByTestId("customer-line-monthly-cap-save");
  await expect(input).toHaveValue("");
  await expect(save).toBeDisabled();
  await input.fill("0");
  await expect(quota).toContainText("每月上限請填 1 到 100,000 的整數，留空代表不限制。");
  await expect(save).toBeDisabled();
  await input.fill("150");
  await save.click();
  await expect.poll(() => settingOf("monthly_cap")).toBe("150");
  await expect(save).toBeDisabled({ timeout: LOAD_TIMEOUT });
  await page.reload();
  await expect(page.getByTestId("customer-line-monthly-cap-input")).toHaveValue("150", {
    timeout: LOAD_TIMEOUT,
  });
  await shotElement(page, "customer-line-quota", "c5b-04-quota-cap");

  // 客服:看得到本月額度,看不到上限欄。
  const agent = await newPage(browser);
  await asAgent(agent);
  await agent.goto("/app/line-events");
  await expect(agent.getByTestId("customer-line-quota-summary")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(agent.getByTestId("customer-line-monthly-cap")).toHaveCount(0);
  await shotElement(agent, "customer-line-card", "c5b-05-agent-view");
  await agent.context().close();

  // 清空 = 不限制。
  const input2 = page.getByTestId("customer-line-monthly-cap-input");
  await input2.fill("");
  await page.getByTestId("customer-line-monthly-cap-save").click();
  await expect.poll(() => settingOf("monthly_cap")).toBe("NULL");

  // 停發中(LINE 回額度用完)⇒ 紅字。
  psqlLocal(`
    update public.merchant_customer_line_settings
    set quota_blocked_until = date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei' + interval '1 month'
    where merchant_id = '${m}';
  `);
  await page.reload();
  await expect(page.getByTestId("customer-line-quota-blocked")).toHaveText(
    "本月額度已用完，下個月 1 日恢復。",
    { timeout: LOAD_TIMEOUT },
  );
  await shotElement(page, "customer-line-quota", "c5b-06-quota-blocked");
  psqlLocal(
    `update public.merchant_customer_line_settings set quota_blocked_until = null where merchant_id = '${m}';`,
  );
});

test("C5-M01 / M02 會員中心:⑧ 文案(裁決 #7);⑪-1 主要 / 第二聯絡人各改自己的「優惠通知」", async ({
  page,
}) => {
  track(page);
  const c1 = fixture.c2.c1;
  await asCustomer(page, SUB_A, LINE_A);
  await page.goto(`/booking/${c1.slugA}/me`);
  const addFriend = page.getByTestId("member-home-add-friend");
  await expect(addFriend).toContainText("預約確認、改時間等消息都會用 LINE 通知您。", {
    timeout: LOAD_TIMEOUT,
  });
  await shot(page, "c5b-07-home-add-friend");

  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const section = page.getByTestId("member-line-notify");
  await expect(section).toContainText("優惠通知", { timeout: LOAD_TIMEOUT });
  await expect(section).toContainText("預約成立、確認、改時間、取消等通知，以及聯絡人申請。");
  await expect(section).toContainText("店家的優惠活動與生日禮通知。");
  const promo = section.getByRole("switch", { name: "優惠通知" });
  await expect(promo).toHaveAttribute("aria-checked", "true");
  await promo.click();
  await expect(promo).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() => contactPromo().find((c) => c.user_id === userA)?.notify_promo)
    .toBe(false);
  expect(contactPromo().find((c) => c.user_id === userB)?.notify_promo).toBe(true);
  await expect(section.getByRole("switch", { name: "預約通知" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.reload();
  await expect(
    page.getByTestId("member-line-notify").getByRole("switch", { name: "優惠通知" }),
  ).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await shot(page, "c5b-08-profile-primary-promo-off");

  // 第二聯絡人:看到的是自己的(開著);改了只動自己那列。
  await asCustomer(page, SUB_B, LINE_B);
  await page.goto(`/booking/${c1.slugA}/me/profile`);
  const promoB = page.getByTestId("member-line-notify").getByRole("switch", { name: "優惠通知" });
  await expect(promoB).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await shot(page, "c5b-09-profile-secondary");
  await promoB.click();
  await expect(promoB).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  await expect
    .poll(() => contactPromo().find((c) => c.user_id === userB)?.notify_promo)
    .toBe(false);
  await promoB.click();
  await expect(promoB).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await expect.poll(() => contactPromo().find((c) => c.user_id === userB)?.notify_promo).toBe(true);
});

test("C5-F03 後台聯絡人卡顯示「優惠通知」;C5-P01 行銷名單「可收到 X 人」與確認窗則數", async ({
  page,
}) => {
  track(page);
  await asAdmin(page);
  await page.goto(`/app/members/${memberId}`);
  const contactsCard = page.getByTestId("member-contacts-card");
  await expect(contactsCard).toContainText("優惠通知：關", { timeout: LOAD_TIMEOUT });
  await expect(contactsCard).toContainText("優惠通知：開");
  await shotElement(page, "member-contacts-card", "c5b-10-member-contacts-promo");

  // 主要聯絡人關了優惠通知、第二聯絡人開著 ⇒ 這位會員可收到 1 人。
  await page.goto("/app/line-marketing");
  const list = page.getByTestId("line-marketing-individual-list");
  const row = list.getByRole("button").filter({ hasText: MEMBER_NAME });
  await expect(row).toContainText("可收到 1 人", { timeout: LOAD_TIMEOUT });
  await row.click();
  await page.getByLabel("要發送的訊息").fill("週年慶全館九折");
  await page.getByRole("button", { name: "發送" }).click();
  const dialog = page.getByTestId("line-marketing-confirm");
  await expect(dialog.getByTestId("line-marketing-confirm-text")).toHaveText(
    "即將發送給 1 位會員，共 1 則訊息（會用掉 1 則官方帳號額度），確定要送出嗎？",
    { timeout: LOAD_TIMEOUT },
  );
  await shotOverlay(page, "c5b-11-marketing-confirm");
  await dialog.getByRole("button", { name: "再想想" }).click();
  await expect(dialog).toHaveCount(0);

  // 兩位都開 ⇒ 共 2 則(公司會員多聯絡人會多用額度)。
  psqlLocal(
    `update public.member_customer_contacts set notify_promo = true where member_id = '${uuid(memberId)}' and status = 'active';`,
  );
  await page.reload();
  const row2 = page
    .getByTestId("line-marketing-individual-list")
    .getByRole("button")
    .filter({ hasText: MEMBER_NAME });
  await expect(row2).toContainText("可收到 2 人", { timeout: LOAD_TIMEOUT });
  await row2.click();
  await page.getByLabel("要發送的訊息").fill("週年慶全館九折");
  await page.getByRole("button", { name: "發送" }).click();
  await expect(page.getByTestId("line-marketing-confirm-text")).toHaveText(
    "即將發送給 1 位會員，共 2 則訊息（會用掉 2 則官方帳號額度），確定要送出嗎？",
    { timeout: LOAD_TIMEOUT },
  );
  await page.getByRole("button", { name: "再想想" }).click();
});

test("C5-Q04 兩種額度鈴鐺(快用完 / 用完)", async ({ page }) => {
  track(page);
  const c1 = fixture.c2.c1;
  const m = uuid(c1.merchantAId);
  const adminId = psqlLocal(
    `select id from public.merchant_admins where merchant_id = '${m}' and user_id = '${uuid(c1.userId)}';`,
  );
  // 80% 提醒用資料庫真的那支函式寫(甲 5-B;同月只發一次,已經發過「用完」也不再發 ⇒ 先寫 80%)。
  expect(psqlLocal(`select public.internal_line_quota_warning('${m}', 160, 200);`)).toBe("t");
  psqlLocal(`
    insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body, created_at)
    values
      ('${uuid(c1.userId)}', '${m}', 'admin', '${uuid(adminId)}', 'line_quota_exhausted',
        'LINE 訊息額度已用完',
        'LINE 官方帳號本月訊息額度已用完，這個月的 LINE 通知（包含員工通知）都會發送失敗，下個月 1 日自動恢復。',
        now() + interval '2 minutes');
  `);
  await asAdmin(page);
  await page.goto("/app/orders");
  await page.getByTestId("notification-bell").click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("LINE 訊息額度快用完了", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    page.getByText("本月 LINE 訊息額度已用 80%（160／200 則）。", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("LINE 訊息額度已用完", { exact: true })).toBeVisible();
  await shotOverlay(page, "c5b-12-bell-quota");
  await page.getByText("LINE 訊息額度快用完了", { exact: true }).click();
  await expect(page).toHaveURL(/\/app\/line-events$/, { timeout: LOAD_TIMEOUT });
});
