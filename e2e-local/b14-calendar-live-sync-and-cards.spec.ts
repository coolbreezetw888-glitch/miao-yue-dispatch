// SPECS-INDEX #1003~#1008(第 14 批):行事曆即時同步、時段框殘留、時間軸卡片改版、兩個小提示 —— 本機 e2e。
// 執行:`npm run test:e2e:local -- b14-calendar-live-sync-and-cards`(只連本機 Docker Supabase)。
//
//   L1 #1003 商家端開著行事曆(不重整),服務人員本人用自己的帳號新增「每週固定可預約時段」⇒ 5 秒內格子自己變成可預約;
//      商家行事曆頻道收到的訊號 payload 只有 {id, reason, v},WebSocket 原文搜不到客戶資料
//   L2 #1004 商家端點格子「關閉時段 → 開啟時段」⇒ 回到 available(白色),資料庫不留例外紀錄;重整後一樣
//   L2b(第 22 批 #1023 改寫)時段外灰格沒有「開啟時段」;舊資料留下的時段外「例外開啟」可以「關閉」⇒ 回到灰色
//   L3 #1006 同集團二店替同一個人建單 / 拖拉改時間(move_booking)⇒ 一店**商家端**與**服務人員端**時間軸
//      的灰色「外店預約中」5 秒內自己出現 / 跟著移動
//   L4 #1005 卡片:一小時「時間 / 虛線 / 名字」、半小時一行;商家端與服務人員端 1280 / 375 截圖
//      (#1012 第 18 批起底色改成整張填色 + 白字,外觀細節在 b18-timeline-filled-cards)
//   L5 #1007 只開「店家報表」的客服點「服務人員報表」⇒ 導回 + 「你沒有「服務人員報表」的權限…」提示
//   L6 #1008 服務人員按「確認接單」⇒ 提示 + 詳情自動關閉,回到行事曆
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts(一店 A / B、別家店 E),本檔另外:
//   ・在一店的集團下開二店 + 一列跟 A 同電話的服務人員(同 staff-schedule-cross-store-live-sync)
//   ・B 改成「商家後台編輯有時段限制」+ 按件計酬 + 排班自助權限(才能自己改每週時段)
//   ・一店多一位只開「店家報表」的客服(L5)
// 截圖存 B14_SHOTS(預設 test-results/b14-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { merchantCalendarTopic } from "../src/modules/booking/merchantCalendarChannel";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { getCurrentMerchantStorageKey } from "../src/modules/merchant/constants";
import {
  decodeRealtimeFrame,
  frameText,
  wireTopic,
  type RealtimeFrame,
} from "./support/realtime-frames";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  adminCreateBooking,
  anonClient,
  injectSession,
  MERCHANT_NAME_PREFIX,
  SERVICE_ITEM_NAME,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type CreatedBooking,
  type LiveSyncFixture,
  type LiveSyncMerchant,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
/** 使用者要的是 1~2 秒;CI / 本機 Docker 抖動留 5 秒(同 #904)。 */
const REALTIME_TIMEOUT = 5_000;
const NO_RELOAD_MARK = "__e2eB14NoReload";
const SHOTS = process.env["B14_SHOTS"] ?? "test-results/b14-shots";
/** #1049:格線一律 00:00 開始,半小時一格 ⇒ HH:MM 是第幾格。 */
const slotIndex = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return (h * 60 + m) / 30;
};

test.describe.configure({ mode: "serial", timeout: 150_000 });

interface RealtimeLog {
  received: RealtimeFrame[];
  texts: string[];
}

function watchRealtime(page: Page): RealtimeLog {
  const log: RealtimeLog = { received: [], texts: [] };
  page.on("websocket", (ws) => {
    if (!/\/realtime\/v1\/websocket/.test(ws.url())) return;
    const onFrame = (raw: string | Uint8Array, received: boolean) => {
      log.texts.push(frameText(raw));
      const frame = decodeRealtimeFrame(raw);
      if (frame && received) log.received.push(frame);
    };
    ws.on("framesent", (f) => onFrame(f.payload as string | Uint8Array, false));
    ws.on("framereceived", (f) => onFrame(f.payload as string | Uint8Array, true));
  });
  return log;
}

function joinOkCount(log: RealtimeLog, topic: string): number {
  return log.received.filter(
    (f) =>
      f.topic === wireTopic(topic) &&
      f.event === "phx_reply" &&
      f.ref !== null &&
      f.ref === f.joinRef &&
      (f.payload as { status?: string } | null)?.status === "ok",
  ).length;
}

function calendarPayloads(log: RealtimeLog, topic: string): unknown[] {
  return log.received
    .filter((f) => f.topic === wireTopic(topic) && f.event === "broadcast")
    .map((f) => f.payload as { event?: unknown; payload?: unknown } | null)
    .filter((env) => env?.event === "calendar_changed")
    .map((env) => env!.payload);
}

let fixture: LiveSyncFixture;
let setupFailed = false;
let branch: LiveSyncMerchant;
let branchStaffId: string;
let agentUserId: string | null = null;
let agentSession: Session;
let adminSessionM1: Session;
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];

async function newPage(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport, timezoneId: "Asia/Taipei" });
  contexts.push(context);
  const p = await context.newPage();
  recorders.push(recordRequestHosts(p));
  p.on("pageerror", (err) => {
    if (!/ServiceWorker|sw\.js|unsupported MIME type|ERR_NAME_NOT_RESOLVED/.test(err.message)) {
      pageErrors.push(err.message);
    }
  });
  await p.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return p;
}

/** 商家管理員甲(管一店與二店)開一店的行事曆 → 週檢視 → 今天。目前操作中商家直接寫進 localStorage。 */
async function openMerchantCalendar(p: Page): Promise<void> {
  await injectSession(p, adminSessionM1);
  await p.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [
    getCurrentMerchantStorageKey(fixture.m1.adminUserId),
    fixture.m1.merchantId,
  ] as [string, string]);
  await p.goto(`/app/calendar?date=${fixture.dateKey}`);
  await p
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(p.getByTestId(`staff-grid-${fixture.staffA.staffId}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

/** 某位服務人員欄裡第 i 格背景格(DaySlotCell 按鈕或純顯示的 div,都帶 data-slot-state)。 */
function merchantSlot(p: Page, staffId: string, hhmm: string) {
  return p
    .getByTestId(`staff-grid-${staffId}`)
    .locator(":scope > [data-slot-state]")
    .nth(slotIndex(hhmm));
}

async function markNoReload(p: Page): Promise<void> {
  await p.evaluate((mark) => {
    (window as unknown as Record<string, unknown>)[mark] = true;
  }, NO_RELOAD_MARK);
}
async function stillNoReload(p: Page): Promise<boolean> {
  return p.evaluate(
    (mark) => (window as unknown as Record<string, unknown>)[mark] === true,
    NO_RELOAD_MARK,
  );
}

async function openStaffTimeline(p: Page, session: Session): Promise<void> {
  await injectSession(p, session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.getByRole("button", { name: "時間軸格線" }).click();
  await expect(p.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

/** 一店集團底下開二店 + 一列跟 A 同電話的服務人員(同 staff-schedule-cross-store-live-sync)。 */
async function createBranchWithSamePerson(f: LiveSyncFixture): Promise<void> {
  const admin = f.m1.admin;
  const created = await admin.rpc("create_merchant_in_group", {
    p_group_id: f.m1.groupId,
    p_name: `${MERCHANT_NAME_PREFIX}二店${f.runId}`,
    p_industry_type: "on_site_dispatch",
    p_address: "E2E第14批跨店測試地址",
    p_intro: "#1006 第 14 批本機 e2e 測試分店,測試完硬刪除。",
  });
  if (created.error || !created.data) throw new Error(`建立二店失敗:${created.error?.message}`);
  const merchantId = created.data as string;
  const hours = await admin.from("merchant_business_hours").upsert(
    Array.from({ length: 7 }, (_, d) => ({
      merchant_id: merchantId,
      day_of_week: d,
      is_closed: false,
      open_time: "08:00",
      close_time: "21:00",
    })),
    { onConflict: "merchant_id,day_of_week" },
  );
  if (hours.error) throw new Error(`二店營業時間失敗:${hours.error.message}`);
  const item = await admin
    .from("service_items")
    .insert({
      merchant_id: merchantId,
      name: SERVICE_ITEM_NAME,
      price: 500,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (item.error || !item.data) throw new Error(`二店服務項目失敗:${item.error?.message}`);
  const pm = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  if (pm.error || !pm.data) throw new Error(`二店付款方式失敗:${pm.error?.message}`);
  const a = await serviceClient()
    .from("merchant_staff")
    .select("phone")
    .eq("id", f.staffA.staffId)
    .single();
  if (a.error || !a.data?.phone) throw new Error(`讀服務人員 A 電話失敗:${a.error?.message}`);
  const staff = await admin
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: "E2E即時服務人員A(二店)",
      phone: a.data.phone as string,
      is_listed: true,
      unlimited_backend_edit: true,
    })
    .select("id")
    .single();
  if (staff.error || !staff.data) throw new Error(`二店服務人員失敗:${staff.error?.message}`);
  branch = {
    merchantId,
    groupId: f.m1.groupId,
    adminUserId: f.m1.adminUserId,
    admin,
    serviceItemId: item.data.id as string,
    paymentMethodId: pm.data.id as string,
  };
  branchStaffId = staff.data.id as string;
}

/** B 改成「有時段限制」+ 按件計酬 + 排班自助權限(才能用自己的帳號改每週時段)。 */
async function prepareStaffB(f: LiveSyncFixture): Promise<void> {
  const upd = await f.m1.admin
    .from("merchant_staff")
    .update({ unlimited_backend_edit: false, compensation_type: "piece_rate" })
    .eq("id", f.staffB.staffId)
    .select("id");
  if (upd.error || upd.data?.length !== 1) throw new Error(`改 B 設定失敗:${upd.error?.message}`);
  const perm = await serviceClient()
    .from("merchant_staff_permissions")
    .upsert(
      { staff_id: f.staffB.staffId, section_key: "staff_availability_self_manage", granted: true },
      { onConflict: "staff_id,section_key" },
    )
    .select("granted");
  if (perm.error) throw new Error(`開 B 排班自助權限失敗:${perm.error.message}`);
}

/** 一店多一位只開「店家報表」的客服(service_role 建 active 客服列,權限走正式的 set_agent_permission)。 */
async function createBillingOnlyAgent(f: LiveSyncFixture): Promise<void> {
  const email = `e2e-b14-agent-${f.runId}@example-local-test.test`;
  const signUp = await anonClient().auth.signUp({ email, password: f.password });
  if (signUp.error || !signUp.data.session)
    throw new Error(`建立客服帳號失敗:${signUp.error?.message}`);
  agentSession = signUp.data.session;
  agentUserId = signUp.data.session.user.id;
  const seed = Number(f.runId.slice(-7)) * 10;
  const agentRes = await serviceClient()
    .from("merchant_agents")
    .insert({
      merchant_id: f.m1.merchantId,
      user_id: agentUserId,
      name: `E2E第14批報表客服${f.runId}`,
      phone: `09${String((seed + 55) % 100_000_000).padStart(8, "0")}`,
      invited_email: email,
      status: "active",
      activated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (agentRes.error || !agentRes.data) throw new Error(`建立客服失敗:${agentRes.error?.message}`);
  const perm = await f.m1.admin.rpc("set_agent_permission", {
    p_agent_id: agentRes.data.id,
    p_section_key: "billing",
    p_granted: true,
  });
  if (perm.error) throw new Error(`開客服店家報表權限失敗:${perm.error.message}`);
}

async function adminSession(f: LiveSyncFixture): Promise<Session> {
  const s = await f.m1.admin.auth.getSession();
  if (!s.data.session) throw new Error("讀不到管理員甲的 session");
  return s.data.session;
}

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await setupLiveSyncFixture();
    adminSessionM1 = await adminSession(fixture);
    await createBranchWithSamePerson(fixture);
    await prepareStaffB(fixture);
    await createBillingOnlyAgent(fixture);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  for (const c of contexts) await c.close();
  for (const r of recorders) expectOnlyLocalRequests(r);
  if (setupFailed || !fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  // 本檔另外建的客服帳號:先核對 email 是本檔格式再刪,刪後再查一次。
  if (agentUserId) {
    const svc = serviceClient();
    const u = await svc.auth.admin.getUserById(agentUserId);
    const email = u.data.user?.email ?? "";
    if (!/^e2e-b14-agent-\d+@example-local-test\.test$/.test(email)) {
      throw new Error(`teardown 中止:客服帳號 email 不是本檔格式(${email})`);
    }
    const del = await svc.auth.admin.deleteUser(agentUserId);
    if (del.error) throw new Error(`刪客服帳號失敗:${del.error.message}`);
    const after = await svc.auth.admin.getUserById(agentUserId);
    if (after.data.user) throw new Error("客服帳號刪後仍存在");
    actions.push("已硬刪除本檔的客服帳號 1 個,刪後 0 個");
  }
  console.log("[b14 本機] 清理結果:\n" + actions.map((x) => `  - ${x}`).join("\n"));
});

test("L1 🔴 #1003 服務人員用自己的帳號新增每週固定可預約時段 ⇒ 開著的商家端行事曆 5 秒內自己更新", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const rt = watchRealtime(page);
  await openMerchantCalendar(page);
  const topic = merchantCalendarTopic(fixture.m1.merchantId);
  await expect
    .poll(() => joinOkCount(rt, topic), { message: "商家端訂到一店的行事曆頻道", timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  const cell = merchantSlot(page, fixture.staffB.staffId, "09:00");
  await expect(cell, "前提:B 還沒設每週時段 ⇒ 09:00 不可預約").toHaveAttribute(
    "data-slot-state",
    "unavailable",
    { timeout: LOAD_TIMEOUT },
  );
  await markNoReload(page);
  const before = calendarPayloads(rt, topic).length;

  // 服務人員 B 本人(跟「我的休假設定」頁同一條路:直接寫 staff_availability_windows,RLS 放行自己)
  const b: SupabaseClient = anonClient();
  const set = await b.auth.setSession({
    access_token: fixture.staffB.session.access_token,
    refresh_token: fixture.staffB.session.refresh_token,
  });
  expect(set.error).toBeNull();
  // 台北中午 = 同一天 UTC 04:00 ⇒ getUTCDay() 就是台北的星期幾
  const dayOfWeek = new Date(`${fixture.dateKey}T12:00:00+08:00`).getUTCDay();
  const ins = await b
    .from("staff_availability_windows")
    .insert({
      staff_id: fixture.staffB.staffId,
      day_of_week: dayOfWeek,
      start_time: "09:00",
      end_time: "12:00",
    })
    .select("id");
  expect(ins.error, "服務人員本人可以寫自己的每週時段").toBeNull();

  await expect(cell, "5 秒內自己變成可預約(不重整)").toHaveAttribute(
    "data-slot-state",
    "available",
    { timeout: REALTIME_TIMEOUT },
  );
  expect(await stillNoReload(page), "畫面是自己更新的,頁面沒有重新載入").toBe(true);
  const payloads = calendarPayloads(rt, topic);
  expect(payloads.length - before).toBeGreaterThanOrEqual(1);
  for (const p of payloads) {
    expect(Object.keys(p as object).sort()).toEqual(["id", "reason", "v"]);
    expect((p as { reason: string }).reason).toBe("calendar_changed");
  }
  const all = rt.texts.join("\n");
  for (const s of fixture.secrets) {
    expect(all.includes(s), `商家端 WebSocket 不可以出現「${s}」`).toBe(false);
  }
});

test("L2 🔴 #1004 點格子「關閉時段 → 開啟時段」⇒ 回到白色(available),資料庫不留例外;重整後一樣", async ({
  browser,
}) => {
  const page = await newPage(browser);
  await openMerchantCalendar(page);
  const cell = () => merchantSlot(page, fixture.staffB.staffId, "10:00");
  await expect(cell()).toHaveAttribute("data-slot-state", "available", { timeout: LOAD_TIMEOUT });

  await cell().click();
  await page.getByRole("menuitem", { name: "關閉時段" }).click();
  await expect(cell()).toHaveAttribute("data-slot-state", "override-closed", {
    timeout: LOAD_TIMEOUT,
  });
  await cell().click();
  await page.getByRole("menuitem", { name: "開啟時段" }).click();
  await expect(cell()).toHaveAttribute("data-slot-state", "available", { timeout: LOAD_TIMEOUT });
  const neighbour = merchantSlot(page, fixture.staffB.staffId, "10:30");
  expect(await cell().getAttribute("class")).toBe(await neighbour.getAttribute("class"));
  await page.screenshot({ path: `${SHOTS}/L2-reopened-1280.png` });

  const rows = await serviceClient()
    .from("staff_availability_overrides")
    .select("id")
    .eq("staff_id", fixture.staffB.staffId)
    .eq("override_date", fixture.dateKey);
  expect(rows.error).toBeNull();
  expect(rows.data, "資料庫沒有留下任何單日例外").toEqual([]);

  await page.reload();
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(cell()).toHaveAttribute("data-slot-state", "available", { timeout: LOAD_TIMEOUT });
});

test("L2b 🔴 #1004 反方向(#1023 起改寫):時段外灰格不能開;舊資料留下的「例外開啟」可以「關閉」⇒ 回到灰色、不留例外;衝突筆數照樣提醒", async ({
  browser,
}) => {
  const page = await newPage(browser);
  await openMerchantCalendar(page);
  // B 的每週時段只有 09:00–12:00(L1 建的)⇒ 15:00 本來就是灰色
  const cell = () => merchantSlot(page, fixture.staffB.staffId, "15:00");
  await expect(cell()).toHaveAttribute("data-slot-state", "unavailable", { timeout: LOAD_TIMEOUT });
  const neighbourClass = await merchantSlot(page, fixture.staffB.staffId, "15:30").getAttribute(
    "class",
  );
  // 第 22 批 #1023:時段外的灰格點了沒有「開啟時段」(不是按鈕、沒有選單)
  expect(await cell().evaluate((el) => el.tagName)).toBe("DIV");
  await cell().click({ force: true });
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  // 改用「#1023 之前留下的既有資料」模擬淡紫框:直接寫一筆 15:00 的例外開啟(畫面已經開不出來)
  const seeded = await serviceClient().from("staff_availability_overrides").insert({
    staff_id: fixture.staffB.staffId,
    override_date: fixture.dateKey,
    slot_start_time: "15:00",
    is_available: true,
  });
  expect(seeded.error).toBeNull();
  // 開著的時候約一張單(15:00–15:30),關閉時要照樣提醒「還有 1 筆既有預約」
  const booked = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffB.staffId,
    time: "15:00",
    customerName: "E2E第14批反方向客戶",
  });
  expect(booked.id).toBeTruthy();
  await page.reload();
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(cell()).toHaveAttribute("data-slot-state", "override-open", {
    timeout: LOAD_TIMEOUT,
  });

  // 這張半小時的單整個蓋在格子上面(畫面上點不到底下的格子)⇒ 直接對格子本身送一次「按下 / 放開」
  // (DaySlotCell 的點擊判斷就是 pointerdown + pointerup 沒有移動),驗的是關閉之後的提醒與狀態。
  const box = await cell().boundingBox();
  if (!box) throw new Error("量不到 15:00 那一格");
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 0 };
  await cell().dispatchEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true });
  await cell().dispatchEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true });
  await page.getByRole("menuitem", { name: "關閉時段" }).click();
  await expect(
    page.getByText(
      "這個時段目前還有 1 筆既有預約，系統不會自動取消或搬移，請自行確認是否需要另外處理。",
    ),
    "刪例外時衝突筆數由前端自己算,提醒照舊",
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(cell(), "回到原本的灰色,不是斜線「時段排休」").toHaveAttribute(
    "data-slot-state",
    "unavailable",
    { timeout: LOAD_TIMEOUT },
  );
  expect(await cell().getAttribute("class")).toBe(neighbourClass);
  await page.screenshot({ path: `${SHOTS}/L2b-reclosed-1280.png` });

  const rows = await serviceClient()
    .from("staff_availability_overrides")
    .select("id")
    .eq("staff_id", fixture.staffB.staffId)
    .eq("override_date", fixture.dateKey);
  expect(rows.error).toBeNull();
  expect(rows.data, "資料庫沒有留下任何單日例外").toEqual([]);
});

test("L3 🔴 #1006 二店替同一個人建單、拖拉改時間 ⇒ 一店商家端與服務人員端的灰格 5 秒內出現 / 移動", async ({
  browser,
}) => {
  const merchantPage = await newPage(browser);
  const mrt = watchRealtime(merchantPage);
  await openMerchantCalendar(merchantPage);
  const staffPage = await newPage(browser);
  await openStaffTimeline(staffPage, fixture.staffA.session);
  await expect
    .poll(() => joinOkCount(mrt, merchantCalendarTopic(fixture.m1.merchantId)), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  // 服務人員端頻道訂好之前改單會漏掉 —— 等「時間軸」那一格出現後再多等一下 join。
  await staffPage.waitForTimeout(1_500);

  const m15 = merchantSlot(merchantPage, fixture.staffA.staffId, "15:00");
  const m16 = merchantSlot(merchantPage, fixture.staffA.staffId, "16:00");
  await expect(m15).not.toHaveAttribute("data-slot-state", "cross-store-occupied");
  await expect(staffPage.getByText("15:00・外店預約中")).toHaveCount(0);
  await markNoReload(merchantPage);
  await markNoReload(staffPage);

  const created: CreatedBooking = await adminCreateBooking(fixture, branch, {
    staffId: branchStaffId,
    time: "15:00",
    customerName: `E2E第14批跨店客戶-${fixture.runId}`,
  });
  await expect(m15, "商家端:灰格 5 秒內自己出現").toHaveAttribute(
    "data-slot-state",
    "cross-store-occupied",
    { timeout: REALTIME_TIMEOUT },
  );
  await expect(
    staffPage.getByText("15:00・外店預約中"),
    "服務人員端:灰格 5 秒內自己出現",
  ).toBeVisible({ timeout: REALTIME_TIMEOUT });

  // 拖拉改時間 = move_booking(bookings UPDATE)
  const moved = await branch.admin.rpc("move_booking", {
    p_booking_id: created.id,
    p_dragged_staff_id: branchStaffId,
    p_target_staff_id: branchStaffId,
    p_target_start_at: buildTaipeiIso(fixture.dateKey, "16:00"),
    p_expected_start_at: created.startAt,
    p_expected_staff_id: branchStaffId,
  });
  expect(moved.error).toBeNull();
  await expect(m16, "商家端:改時間後灰格 5 秒內移到 16:00").toHaveAttribute(
    "data-slot-state",
    "cross-store-occupied",
    { timeout: REALTIME_TIMEOUT },
  );
  await expect(m15).not.toHaveAttribute("data-slot-state", "cross-store-occupied", {
    timeout: REALTIME_TIMEOUT,
  });
  await expect(staffPage.getByText("16:00・外店預約中")).toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  await expect(staffPage.getByText("15:00・外店預約中")).toHaveCount(0, {
    timeout: REALTIME_TIMEOUT,
  });
  expect(await stillNoReload(merchantPage)).toBe(true);
  expect(await stillNoReload(staffPage)).toBe(true);
});

test("L4 #1005 卡片:一小時「時間 / 虛線 / 名字」、半小時一行;商家端與服務人員端 1280 / 375 截圖", async ({
  browser,
}) => {
  const long = await fixture.m1.admin.rpc("create_booking", {
    p_merchant_id: fixture.m1.merchantId,
    p_staff_id: fixture.staffA.staffId,
    p_service_items: [{ service_item_id: fixture.m1.serviceItemId, quantity: 2, unit_price: 500 }],
    p_start_at: buildTaipeiIso(fixture.dateKey, "10:00"),
    p_customer_name: "李思賢",
    p_customer_phone: fixture.secrets[3],
    p_customer_address: fixture.secrets[2],
    p_assistant_staff_ids: [],
    p_payment_method_id: fixture.m1.paymentMethodId,
  });
  expect(long.error).toBeNull();
  const longId = (long.data as { id: string }).id;
  const short = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "12:00",
    customerName: "王半時",
  });
  const lengths = await serviceClient()
    .from("bookings")
    .select("id,start_at,end_at")
    .in("id", [longId, short.id]);
  const minutes = Object.fromEntries(
    (lengths.data ?? []).map((r) => [
      r.id,
      (new Date(r.end_at as string).getTime() - new Date(r.start_at as string).getTime()) / 60000,
    ]),
  );
  expect(minutes[longId], "前提:長卡片是一小時").toBe(60);
  expect(minutes[short.id], "前提:短卡片是半小時").toBe(30);

  for (const width of [1280, 375]) {
    const page = await newPage(browser, { width, height: 900 });
    await openMerchantCalendar(page);
    const longBlock = page.getByTestId(`booking-block-${longId}-main`);
    const shortBlock = page.getByTestId(`booking-block-${short.id}-main`);
    await expect(longBlock).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(longBlock.locator("[data-booking-block-layout]")).toHaveAttribute(
      "data-booking-block-layout",
      "stacked",
    );
    await expect(longBlock.locator("[data-booking-block-divider]")).toHaveCount(1);
    await expect(longBlock.locator("[data-booking-block-time]")).toHaveText("10:00");
    await expect(shortBlock.locator("[data-booking-block-layout]")).toHaveAttribute(
      "data-booking-block-layout",
      "inline",
    );
    await expect(shortBlock.locator("[data-booking-block-divider]")).toHaveCount(0);
    // 左側 4px 狀態色條(跟服務人員端同一種)。
    // #1012(第 18 批)起卡片改成整張填滿狀態色 + 白字(原本 #1005 的白底作廢);完整檢查在 b18。
    const style = await longBlock.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, left: cs.borderLeftWidth };
    });
    expect(style.left).toBe("4px");
    expect(style.bg, "背景 = 待確認的狀態色(#ebaa2d)").toBe("rgb(235, 170, 45)");
    expect(style.color, "白字").toBe("rgb(255, 255, 255)");
    // 名字沒有被截成空(三層都放得下)
    const nameBox = await longBlock.getByText("李思賢").boundingBox();
    expect(nameBox && nameBox.height > 0).toBe(true);
    await longBlock.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/L4-merchant-timeline-${width}.png` });

    const staffPage = await newPage(browser, { width, height: 900 });
    await openStaffTimeline(staffPage, fixture.staffA.session);
    const grid = staffPage.getByTestId("my-timeline-grid");
    const staffLong = grid.getByRole("button", { name: /李思賢/ });
    await expect(staffLong.locator("[data-booking-block-layout]")).toHaveAttribute(
      "data-booking-block-layout",
      "stacked",
      { timeout: LOAD_TIMEOUT },
    );
    await expect(
      grid.getByRole("button", { name: /王半時/ }).locator("[data-booking-block-layout]"),
    ).toHaveAttribute("data-booking-block-layout", "inline");
    await staffLong.scrollIntoViewIfNeeded();
    await staffPage.screenshot({ path: `${SHOTS}/L4-staff-timeline-${width}.png` });
    // 375 寬不橫向捲出
    const overflow = await staffPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "服務人員端沒有橫向捲出").toBeLessThanOrEqual(0);
  }
});

test("L5 #1007 只開店家報表的客服點服務人員報表 ⇒ 導回 + 提示", async ({ browser }) => {
  const page = await newPage(browser);
  await injectSession(page, agentSession);
  await page.goto("/app/manage");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto("/app/staff-report");
  await expect(
    page.getByText("你沒有「服務人員報表」的權限，如需使用請聯絡商家管理員。"),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page).not.toHaveURL(/\/app\/staff-report/);
  await page.screenshot({ path: `${SHOTS}/L5-permission-toast-1280.png` });
});

test("L6 #1008 服務人員按「確認接單」⇒ 提示 + 詳情自動關閉,回到行事曆", async ({ browser }) => {
  const booking = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "18:00",
    customerName: "E2E第14批待確認客戶",
  });
  const page = await newPage(browser);
  await injectSession(page, fixture.staffA.session);
  await primeStaffCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/calendar");
  await page.getByText("E2E第14批待確認客戶", { exact: true }).click({ timeout: LOAD_TIMEOUT });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dialog.getByTestId("staff-confirm-booking-button").click();
  await expect(page.getByText("已確認接單")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog"), "詳情自動關閉").toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page).toHaveURL(/\/app\/calendar$/);
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible();
  const b = await serviceClient().from("bookings").select("status").eq("id", booking.id).single();
  expect(b.data?.status).toBe("accepted");
  await page.screenshot({ path: `${SHOTS}/L6-after-confirm-1280.png` });
  expect(pageErrors, "全程沒有 pageerror").toEqual([]);
});
