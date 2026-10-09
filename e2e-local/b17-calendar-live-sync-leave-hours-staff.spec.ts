// SPECS-INDEX #1011(第 17 批):請假 / 營業時間 / 服務人員資料變動也即時同步到行事曆 —— 本機 e2e。
// 執行:`npm run test:e2e:local -- b17-calendar-live-sync-leave-hours-staff`(只連本機 Docker Supabase)。
//
//   L1 請假:管理員新增 / 取消服務人員 A 今天的請假 ⇒ 開著的商家端行事曆、A 本人的服務人員端時間軸,
//      不重整,5 秒內出現 / 消失「休假：假別」
//   L2 營業時間:管理員把今天改成 08:00~12:00 ⇒ 商家端 A 那一欄格數、服務人員端時間軸高度 5 秒內跟著變
//   L3 不影響行事曆的欄位(自我介紹)⇒ 商家端 3 秒內收不到任何 calendar_changed 訊號
//   L4 服務人員資料:關掉 A「後台無時段限制」⇒ A 的格子變不可預約;B 改名 ⇒ 欄名變;B 離職 ⇒ B 那欄消失
//   全部:訊號 payload 只有 {id, reason, v},WebSocket 原文搜不到假別名稱、請假備註、客戶資料
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts(一店 A / B、別家店 E)。本檔另外把 A 改成月薪制
// (create_staff_leave 只收月薪制),全部走前端同一條路(管理員身分的 RPC / 表格寫入)。
// teardown 沿用 fixture 的(硬刪除 + 清本次商家 / 服務人員頻道的 realtime.messages 列)。
//
// 用語:一律「服務人員」。
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { merchantCalendarTopic } from "../src/modules/booking/merchantCalendarChannel";
import { getCurrentMerchantStorageKey } from "../src/modules/merchant/constants";
import { staffScheduleTopic } from "../src/modules/staff-portal/staffScheduleChannel";
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
  injectSession,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
/** 使用者要的是 1~2 秒;本機 Docker 抖動留 5 秒(同 #904 / b14)。 */
const REALTIME_TIMEOUT = 5_000;
const NO_RELOAD_MARK = "__e2eB17NoReload";
/** fixture 營業時間 08:00~21:00,半小時一格 ⇒ 26 格;L2 改成 08:00~12:00 ⇒ 8 格。 */
const FULL_SLOTS = 26;
const SHORT_SLOTS = 8;

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

function broadcastPayloads(log: RealtimeLog, topic: string, event: string): unknown[] {
  return log.received
    .filter((f) => f.topic === wireTopic(topic) && f.event === "broadcast")
    .map((f) => f.payload as { event?: unknown; payload?: unknown } | null)
    .filter((env) => env?.event === event)
    .map((env) => env!.payload);
}

let fixture: LiveSyncFixture;
let setupFailed = false;
let adminSessionM1: Session;
let leaveTypeId: string;
let leaveTypeName: string;
let dayOfWeek: number;
const LEAVE_NOTE = `E2E第17批祕密請假備註${Date.now()}`;
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];

let merchantPage: Page;
let merchantRt: RealtimeLog;
let staffPage: Page;
let staffRt: RealtimeLog;

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
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

/** #1049:格線改成 00:00~24:00 之後,「營業時間內」的格子 = 不是 outside-business-hours 的那些(格數跟改版前一樣)。 */
const INSIDE_SLOT = ':scope > [data-slot-state]:not([data-slot-state="outside-business-hours"])';

function slotsOf(p: Page, staffId: string) {
  return p.getByTestId(`staff-grid-${staffId}`).locator(INSIDE_SLOT);
}

/** #1049:時間軸固定 24 小時高,改量「營業時間內格子的總高度」(= 改版前的格線高度)。 */
async function timelineHeight(p: Page): Promise<number> {
  return (await p.getByTestId("my-timeline-grid").locator(INSIDE_SLOT).count()) * 30;
}

function expectCleanPayloads(log: RealtimeLog, topic: string, event: string, reason: string) {
  for (const payload of broadcastPayloads(log, topic, event)) {
    expect(Object.keys(payload as object).sort()).toEqual(["id", "reason", "v"]);
    expect((payload as { reason: string }).reason).toBe(reason);
  }
  const all = log.texts.join("\n");
  for (const s of [...fixture.secrets, LEAVE_NOTE, leaveTypeName]) {
    expect(all.includes(s), `WebSocket 不可以出現「${s}」`).toBe(false);
  }
}

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    fixture = await setupLiveSyncFixture();
    const s = await fixture.m1.admin.auth.getSession();
    if (!s.data.session) throw new Error("讀不到管理員甲的 session");
    adminSessionM1 = s.data.session;
    // create_staff_leave 只收月薪制服務人員
    const upd = await fixture.m1.admin
      .from("merchant_staff")
      .update({ compensation_type: "monthly_salary" })
      .eq("id", fixture.staffA.staffId)
      .select("id");
    if (upd.error || upd.data?.length !== 1)
      throw new Error(`改 A 為月薪制失敗:${upd.error?.message}`);
    const lt = await fixture.m1.admin
      .from("merchant_leave_types")
      .select("id,name")
      .eq("merchant_id", fixture.m1.merchantId)
      .eq("status", "active")
      .order("name")
      .limit(1)
      .single();
    if (lt.error || !lt.data) throw new Error(`讀假別失敗:${lt.error?.message}`);
    leaveTypeId = lt.data.id as string;
    leaveTypeName = lt.data.name as string;
    // 台北中午 = 同一天 UTC 04:00 ⇒ getUTCDay() 就是台北的星期幾
    dayOfWeek = new Date(`${fixture.dateKey}T12:00:00+08:00`).getUTCDay();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  for (const c of contexts) await c.close();
  for (const r of recorders) expectOnlyLocalRequests(r);
  expect(pageErrors, "頁面沒有任何未處理的錯誤").toEqual([]);
  if (setupFailed || !fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  console.log("[b17 本機] 清理結果:\n" + actions.map((x) => `  - ${x}`).join("\n"));
});

test("L0 開好兩個畫面:商家端行事曆(一店)+ 服務人員 A 的時間軸,兩邊都訂到頻道", async ({
  browser,
}) => {
  merchantPage = await newPage(browser);
  merchantRt = watchRealtime(merchantPage);
  await injectSession(merchantPage, adminSessionM1);
  await merchantPage.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [
    getCurrentMerchantStorageKey(fixture.m1.adminUserId),
    fixture.m1.merchantId,
  ] as [string, string]);
  await merchantPage.goto(`/app/calendar?date=${fixture.dateKey}`);
  await merchantPage
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(merchantPage.getByTestId(`staff-grid-${fixture.staffA.staffId}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  staffPage = await newPage(browser);
  staffRt = watchRealtime(staffPage);
  await injectSession(staffPage, fixture.staffA.session);
  await primeStaffCurrentMerchant(staffPage, LOAD_TIMEOUT);
  await staffPage.goto("/app/calendar");
  await expect(staffPage.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await staffPage.getByRole("button", { name: "時間軸格線" }).click();
  await expect(staffPage.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await expect
    .poll(() => joinOkCount(merchantRt, merchantCalendarTopic(fixture.m1.merchantId)), {
      message: "商家端訂到一店的行事曆頻道",
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => joinOkCount(staffRt, staffScheduleTopic(fixture.staffA.staffId)), {
      message: "服務人員端訂到 A 的班表頻道",
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  await markNoReload(merchantPage);
  await markNoReload(staffPage);
});

test("L1 🔴 新增 / 取消請假 ⇒ 商家端與服務人員 A 本人的行事曆 5 秒內自己出現 / 消失「休假」", async () => {
  const header = merchantPage.getByTestId(`staff-column-${fixture.staffA.staffId}`);
  const leaveText = `休假：${leaveTypeName}`;
  await expect(header.getByText(leaveText)).toHaveCount(0);
  await expect(staffPage.getByText(leaveText)).toHaveCount(0);

  const created = await fixture.m1.admin.rpc("create_staff_leave", {
    p_staff_id: fixture.staffA.staffId,
    p_leave_type_id: leaveTypeId,
    p_start_date: fixture.dateKey,
    p_end_date: fixture.dateKey,
    p_notes: LEAVE_NOTE,
  });
  expect(created.error, "管理員新增請假").toBeNull();
  const leaveId = (created.data as { id: string }).id;

  await expect(header.getByText(leaveText), "商家端 5 秒內自己出現休假").toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  await expect(staffPage.getByText(leaveText).first(), "服務人員端 5 秒內自己出現休假").toBeVisible(
    {
      timeout: REALTIME_TIMEOUT,
    },
  );

  const cancelled = await fixture.m1.admin.rpc("cancel_staff_leave", { p_leave_id: leaveId });
  expect(cancelled.error, "管理員取消請假").toBeNull();
  await expect(header.getByText(leaveText), "商家端 5 秒內自己拿掉休假").toHaveCount(0, {
    timeout: REALTIME_TIMEOUT,
  });
  await expect(staffPage.getByText(leaveText), "服務人員端 5 秒內自己拿掉休假").toHaveCount(0, {
    timeout: REALTIME_TIMEOUT,
  });

  expect(await stillNoReload(merchantPage)).toBe(true);
  expect(await stillNoReload(staffPage)).toBe(true);
  expectCleanPayloads(
    merchantRt,
    merchantCalendarTopic(fixture.m1.merchantId),
    "calendar_changed",
    "calendar_changed",
  );
  expectCleanPayloads(
    staffRt,
    staffScheduleTopic(fixture.staffA.staffId),
    "schedule_changed",
    "schedule_changed",
  );
});

test("L2 🔴 改營業時間 ⇒ 商家端格數、服務人員端時間軸 5 秒內自己跟著變", async () => {
  await expect(slotsOf(merchantPage, fixture.staffA.staffId)).toHaveCount(FULL_SLOTS);
  const fullHeight = await timelineHeight(staffPage);
  expect(fullHeight).toBeGreaterThan(0);

  const shorten = await fixture.m1.admin
    .from("merchant_business_hours")
    .update({ close_time: "12:00" })
    .eq("merchant_id", fixture.m1.merchantId)
    .eq("day_of_week", dayOfWeek)
    .select("id");
  expect(shorten.error).toBeNull();
  expect(shorten.data?.length).toBe(1);

  await expect(slotsOf(merchantPage, fixture.staffA.staffId), "商家端 5 秒內變成 8 格").toHaveCount(
    SHORT_SLOTS,
    { timeout: REALTIME_TIMEOUT },
  );
  await expect
    .poll(() => timelineHeight(staffPage), {
      message: "服務人員端時間軸 5 秒內變矮",
      timeout: REALTIME_TIMEOUT,
    })
    .toBeLessThan(fullHeight);

  const restore = await fixture.m1.admin
    .from("merchant_business_hours")
    .update({ close_time: "21:00" })
    .eq("merchant_id", fixture.m1.merchantId)
    .eq("day_of_week", dayOfWeek)
    .select("id");
  expect(restore.error).toBeNull();
  await expect(slotsOf(merchantPage, fixture.staffA.staffId)).toHaveCount(FULL_SLOTS, {
    timeout: REALTIME_TIMEOUT,
  });
  await expect
    .poll(() => timelineHeight(staffPage), { timeout: REALTIME_TIMEOUT })
    .toBe(fullHeight);
  expect(await stillNoReload(merchantPage)).toBe(true);
  expect(await stillNoReload(staffPage)).toBe(true);
});

test("L3 🔴 改行事曆沒顯示的欄位(自我介紹)⇒ 不發訊號", async () => {
  const topic = merchantCalendarTopic(fixture.m1.merchantId);
  // 先等前一段的訊號都落地
  await merchantPage.waitForTimeout(1_500);
  const before = broadcastPayloads(merchantRt, topic, "calendar_changed").length;
  const upd = await fixture.m1.admin
    .from("merchant_staff")
    .update({ intro: "E2E第17批自我介紹(行事曆沒顯示)" })
    .eq("id", fixture.staffA.staffId)
    .select("id");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);
  await merchantPage.waitForTimeout(3_000);
  expect(broadcastPayloads(merchantRt, topic, "calendar_changed").length - before).toBe(0);
});

test("L4 🔴 改服務人員資料(後台無時段限制 / 名字 / 離職)⇒ 商家端 5 秒內自己更新", async () => {
  const cell = slotsOf(merchantPage, fixture.staffA.staffId).nth(2);
  await expect(cell, "前提:A 開著後台無時段限制 ⇒ 09:00 可預約").toHaveAttribute(
    "data-slot-state",
    "available",
  );
  const off = await fixture.m1.admin
    .from("merchant_staff")
    .update({ unlimited_backend_edit: false })
    .eq("id", fixture.staffA.staffId)
    .select("id");
  expect(off.error).toBeNull();
  await expect(cell, "A 沒有每週時段 ⇒ 關掉後 5 秒內變不可預約").toHaveAttribute(
    "data-slot-state",
    "unavailable",
    { timeout: REALTIME_TIMEOUT },
  );

  const newName = `E2E第17批改名B${fixture.runId}`;
  const rename = await fixture.m1.admin
    .from("merchant_staff")
    .update({ name: newName })
    .eq("id", fixture.staffB.staffId)
    .select("id");
  expect(rename.error).toBeNull();
  await expect(
    merchantPage.getByTestId(`staff-column-${fixture.staffB.staffId}`).getByText(newName),
    "B 的欄名 5 秒內自己變",
  ).toBeVisible({ timeout: REALTIME_TIMEOUT });

  const removed = await fixture.m1.admin
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffB.staffId)
    .select("id");
  expect(removed.error).toBeNull();
  await expect(
    merchantPage.getByTestId(`staff-column-${fixture.staffB.staffId}`),
    "B 離職 ⇒ 那一欄 5 秒內自己消失",
  ).toHaveCount(0, { timeout: REALTIME_TIMEOUT });

  expect(await stillNoReload(merchantPage)).toBe(true);
  expectCleanPayloads(
    merchantRt,
    merchantCalendarTopic(fixture.m1.merchantId),
    "calendar_changed",
    "calendar_changed",
  );
});
