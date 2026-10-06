// SPECS-INDEX #874「服務人員端行事曆即時同步」—— 本機 e2e(規格書 #904 第三層 E1 ~ E13)。
// 執行:`npm run test:e2e:local`(只連本機 Docker Supabase;預設的 `npm run test:e2e` 連正式庫,不收這支)。
//
// 做法:服務人員 A / B 各自一個瀏覽器情境(browser context)登入,停在 /app/calendar **不重新載入**;
//      Node 端以**商家管理員**身分呼叫真正的 RPC 改單(不是 service_role),斷言服務人員的畫面在 5 秒內自己變。
//      另外記錄每一個 Realtime WebSocket frame(e2e-local/support/realtime-frames.ts 解碼),用來驗
//      「有沒有訂到 / 有沒有收到 / 有沒有退訂 / 訊號裡有沒有客戶資料」。
//
// 「真的是即時同步讓畫面變,不是別的觸發點」的保證:
//   ・每次都斷言頁面沒有重新載入(window 上的記號還在);
//   ・測試期間不切換分頁、不觸發視窗聚焦(refetchOnWindowFocus 不會跑),也沒有推播;
//   ・E13b 刻意讓瀏覽器保持「在線」、只切斷 Realtime 那條 WebSocket(React Query 的 refetchOnReconnect 不會跑),
//     證明補漏真的是 #897「重連 SUBSCRIBED 就重查」做到的。
//   ・故障注入(回報裡有紀錄):把 MyCalendarPage 的 useStaffScheduleLiveSync 拿掉 → E1 就轉紅(連頻道都訂不到);
//     因為整支是 serial 依序執行,E1 一紅,後面的測試就不會再跑(顯示為 did not run),不是「各自轉紅」。
//   ・故障注入:把 staffScheduleChannel.ts 的 isTransportChannelError 改成永遠回 false → E13b 轉紅
//     (傳輸層斷線被算進「連續被拒就放棄」,放行後不會再 SUBSCRIBED)。
//
// 用語:一律「服務人員」。
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import {
  STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS,
  staffScheduleTopic,
} from "../src/modules/staff-portal/staffScheduleChannel";
import {
  decodeRealtimeFrame,
  frameText,
  scheduleBroadcastPayload,
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
  adminRpc,
  adminSetAssistants,
  anonClient,
  injectSession,
  setCalendarView,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type CreatedBooking,
  type LiveSyncFixture,
  type LiveSyncStaff,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
/** 規格書 #904:「斷言 A 的畫面在 5 秒內自己變化」。 */
const REALTIME_TIMEOUT = 5_000;
/** 「應該收不到」的觀察時間:去抖 400ms + 一次 RPC 綽綽有餘。 */
const QUIET_MS = 3_000;
const NO_RELOAD_MARK = "__e2eLiveSyncNoReload";

test.describe.configure({ mode: "serial", timeout: 120_000 });

// =========================================================================
// WebSocket frame 記錄
// =========================================================================

interface RealtimeLog {
  sockets: number;
  closed: number;
  sent: RealtimeFrame[];
  received: RealtimeFrame[];
  /** 收發的所有 frame 原文(二進位用 UTF-8 解),E10 用來整包搜字串。 */
  texts: string[];
}

function watchRealtime(page: Page): RealtimeLog {
  const log: RealtimeLog = { sockets: 0, closed: 0, sent: [], received: [], texts: [] };
  page.on("websocket", (ws) => {
    if (!/\/realtime\/v1\/websocket/.test(ws.url())) return;
    log.sockets += 1;
    ws.on("framesent", (f) => {
      const raw = f.payload as string | Uint8Array;
      log.texts.push(frameText(raw));
      const frame = decodeRealtimeFrame(raw);
      if (frame) log.sent.push(frame);
    });
    ws.on("framereceived", (f) => {
      const raw = f.payload as string | Uint8Array;
      log.texts.push(frameText(raw));
      const frame = decodeRealtimeFrame(raw);
      if (frame) log.received.push(frame);
    });
    ws.on("close", () => {
      log.closed += 1;
    });
  });
  return log;
}

/** 這個頻道收到幾次「加入成功」的回覆(join 的 phx_reply:ref === join_ref,status = ok)。 */
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

function joinSentCount(log: RealtimeLog, topic: string): number {
  return log.sent.filter((f) => f.topic === wireTopic(topic) && f.event === "phx_join").length;
}

function leaveSentCount(log: RealtimeLog, topic: string): number {
  return log.sent.filter((f) => f.topic === wireTopic(topic) && f.event === "phx_leave").length;
}

function schedulePayloads(log: RealtimeLog, topic: string): unknown[] {
  return log.received.map((f) => scheduleBroadcastPayload(f, topic)).filter((p) => p !== undefined);
}

async function waitJoinOk(log: RealtimeLog, topic: string, atLeast: number): Promise<void> {
  await expect
    .poll(() => joinOkCount(log, topic), {
      message: `頻道 ${topic} 應該收到第 ${atLeast} 次 SUBSCRIBED`,
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

// =========================================================================
// 共用狀態
// =========================================================================

let fixture: LiveSyncFixture;
let setupFailed = false;

interface StaffView {
  staff: LiveSyncStaff;
  topic: string;
  context: BrowserContext;
  page: Page;
  rt: RealtimeLog;
  requests: RequestRecorder;
  pageErrors: string[];
  liveSyncErrorLogs: string[];
}

let viewA: StaffView;
let viewB: StaffView;

/** 商家二的服務人員 E:用 Node 端 supabase-js 訂自己的頻道(驗「別家店不收」)。 */
let clientE: SupabaseClient | null = null;
let channelE: RealtimeChannel | null = null;
const receivedE: unknown[] = [];

function isEnvironmentNoise(text: string): boolean {
  return (
    /ServiceWorker|sw\.js|unsupported MIME type \('text\/html'\)/.test(text) ||
    text.includes("net::ERR_NAME_NOT_RESOLVED")
  );
}

async function openStaffView(browser: Browser, staff: LiveSyncStaff): Promise<StaffView> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const view: StaffView = {
    staff,
    topic: staffScheduleTopic(staff.staffId),
    context,
    page,
    rt: watchRealtime(page),
    requests: recordRequestHosts(page),
    pageErrors: [],
    liveSyncErrorLogs: [],
  };
  page.on("pageerror", (err) => {
    if (!isEnvironmentNoise(err.message)) view.pageErrors.push(err.message);
  });
  page.on("console", (msg) => {
    // #899:即時同步只准記 warn / info;error 等級出現我們的前綴就是寫錯了。
    if (msg.type() === "error" && msg.text().includes("[staff-schedule-live-sync]")) {
      view.liveSyncErrorLogs.push(msg.text());
    }
  });
  // 本機沒有跑 Edge Function;頁面若呼叫(例如推播訂閱檢查)一律回 200,避免無關雜訊。
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, staff.session);
  // 全新 session 第一次深連結受保護頁面,先訪問 /app 讓「目前商家」寫進 localStorage(既有已知問題,
  // 見 e2e/staff-portal-v2.spec.ts beforeEach 的說明)。
  await page.goto("/app");
  await page.goto("/app/calendar");
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.evaluate((mark) => {
    (window as unknown as Record<string, unknown>)[mark] = true;
  }, NO_RELOAD_MARK);
  return view;
}

async function expectNoReload(view: StaffView): Promise<void> {
  const still = await view.page.evaluate(
    (mark) => (window as unknown as Record<string, unknown>)[mark] === true,
    NO_RELOAD_MARK,
  );
  expect(still, "畫面是自己更新的,頁面沒有重新載入").toBe(true);
}

async function markNoReload(view: StaffView): Promise<void> {
  await view.page.evaluate((mark) => {
    (window as unknown as Record<string, unknown>)[mark] = true;
  }, NO_RELOAD_MARK);
}

function card(view: StaffView, customerName: string) {
  return view.page.locator("li", { hasText: customerName });
}

async function expectNoToast(view: StaffView): Promise<void> {
  await expect(view.page.locator("[data-sonner-toast]")).toHaveCount(0);
}

let counter = 0;
function customer(label: string): string {
  counter += 1;
  return `E2E即時客戶${label}-${fixture.runId}-${counter}`;
}

function bookingFor(staff: LiveSyncStaff, booking: CreatedBooking) {
  return { ...booking, staffId: staff.staffId };
}

// =========================================================================
// 生命週期
// =========================================================================

test.beforeAll(async ({ browser }) => {
  try {
    fixture = await setupLiveSyncFixture();
    viewA = await openStaffView(browser, fixture.staffA);
    viewB = await openStaffView(browser, fixture.staffB);

    // 服務人員 E(別家店)用 Node 端 client 訂自己的頻道。
    clientE = anonClient();
    const signIn = await clientE.auth.signInWithPassword({
      email: fixture.staffE.email,
      password: fixture.password,
    });
    if (signIn.error) throw new Error(`服務人員 E 登入失敗:${signIn.error.message}`);
    const topicE = staffScheduleTopic(fixture.staffE.staffId);
    channelE = clientE.channel(topicE, { config: { private: true } });
    channelE.on("broadcast", { event: "schedule_changed" }, (m) => receivedE.push(m));
    const statusE = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMEOUT"), 15_000);
      channelE!.subscribe((status) => {
        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR") {
          clearTimeout(timer);
          resolve(status);
        }
      });
    });
    if (statusE !== "SUBSCRIBED") throw new Error(`服務人員 E 訂自己的頻道失敗:${statusE}`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  try {
    if (clientE) await clientE.removeAllChannels();
  } catch {
    /* 已斷線 */
  }
  const guardErrors: unknown[] = [];
  for (const v of [viewA, viewB]) {
    if (!v) continue;
    try {
      expectOnlyLocalRequests(v.requests);
    } catch (err) {
      guardErrors.push(err);
    }
    await v.context.close();
  }
  if (!setupFailed && fixture) {
    const actions = await teardownLiveSyncFixture(fixture);
    console.log(
      "[staff-schedule-live-sync 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
    );
  }
  // 清理一定先做完,再把守門失敗丟出來。
  if (guardErrors.length > 0) throw guardErrors[0];
});

// =========================================================================
// E1 ~ E13
// =========================================================================

let e2Booking: CreatedBooking;

test("E1 進入行事曆就訂到自己的私有頻道(SUBSCRIBED;順便驗 #898:token 帶的是本人的 JWT)", async () => {
  await waitJoinOk(viewA.rt, viewA.topic, 1);
  await waitJoinOk(viewB.rt, viewB.topic, 1);

  // 同一個頻道只訂一次(Strict Mode 下也不會留兩條)—— 這裡看「加入成功」次數,不含別人的頻道。
  expect(joinOkCount(viewA.rt, viewA.topic)).toBe(1);

  const join = viewA.rt.sent.find(
    (f) => f.topic === wireTopic(viewA.topic) && f.event === "phx_join",
  );
  const payload = join?.payload as {
    config?: { private?: boolean };
    access_token?: string;
  } | null;
  expect(payload?.config?.private, "前端一定要用 private: true(#889 提醒 1)").toBe(true);
  const token = payload?.access_token ?? "";
  expect(token.split("."), "realtime 收到的是 JWT,不是 publishable key").toHaveLength(3);
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
    sub?: string;
    role?: string;
  };
  expect(claims.sub, "JWT 是服務人員 A 本人").toBe(fixture.staffA.userId);
  expect(claims.role).toBe("authenticated");
});

test("E2 建一張指派給 A 的單 ⇒ A 的畫面自己出現那格;B 與別家店 E 都沒收到訊號", async () => {
  const bBefore = schedulePayloads(viewB.rt, viewB.topic).length;
  const eBefore = receivedE.length;
  e2Booking = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "09:00",
    customerName: customer("E2"),
  });
  await expect(card(viewA, e2Booking.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(card(viewA, e2Booking.customerName)).toContainText("待確認");
  await expectNoReload(viewA);
  expect(schedulePayloads(viewA.rt, viewA.topic).length).toBeGreaterThanOrEqual(1);

  await viewA.page.waitForTimeout(1_000);
  expect(schedulePayloads(viewB.rt, viewB.topic).length - bBefore, "同店 B 不在這張單上").toBe(0);
  expect(receivedE.length - eBefore, "別家店的服務人員 E 收不到").toBe(0);
  await expect(card(viewB, e2Booking.customerName)).toHaveCount(0);
});

test("E3 改狀態(待確認 → 已確認 → 已完成)⇒ A 的狀態標籤自己跟著變", async () => {
  await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: e2Booking.id });
  await expect(card(viewA, e2Booking.customerName)).toContainText("已確認", {
    timeout: REALTIME_TIMEOUT,
  });
  await adminRpc(fixture.m1, "complete_booking", { p_booking_id: e2Booking.id });
  await expect(card(viewA, e2Booking.customerName)).toContainText("已完成", {
    timeout: REALTIME_TIMEOUT,
  });
  await expectNoReload(viewA);
});

test("E4 #844 還原完成 ⇒ 變回已確認;再完成後「取消已完成」⇒ 那格消失", async () => {
  await adminRpc(fixture.m1, "revert_completed_booking", {
    p_booking_id: e2Booking.id,
    p_reason: "e2e 即時同步:還原完成",
  });
  await expect(card(viewA, e2Booking.customerName)).toContainText("已確認", {
    timeout: REALTIME_TIMEOUT,
  });
  await adminRpc(fixture.m1, "complete_booking", { p_booking_id: e2Booking.id });
  await expect(card(viewA, e2Booking.customerName)).toContainText("已完成", {
    timeout: REALTIME_TIMEOUT,
  });
  await adminRpc(fixture.m1, "cancel_completed_booking", {
    p_booking_id: e2Booking.id,
    p_reason: "e2e 即時同步:取消已完成",
    p_notify_requested: false,
  });
  await expect(card(viewA, e2Booking.customerName)).toHaveCount(0, { timeout: REALTIME_TIMEOUT });
  await expectNoReload(viewA);
});

test("E5 改時間(move_booking mode=time)⇒ 那格自己移到新時間", async () => {
  const b = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "10:00",
    customerName: customer("E5"),
  });
  await expect(card(viewA, b.customerName)).toContainText("10:00 - 10:30", {
    timeout: REALTIME_TIMEOUT,
  });
  await adminRpc(fixture.m1, "move_booking", {
    p_booking_id: b.id,
    p_dragged_staff_id: fixture.staffA.staffId,
    p_target_staff_id: fixture.staffA.staffId,
    p_target_start_at: `${fixture.dateKey}T14:00:00+08:00`,
    p_expected_start_at: b.startAt,
    p_expected_staff_id: fixture.staffA.staffId,
  });
  await expect(card(viewA, b.customerName)).toContainText("14:00 - 14:30", {
    timeout: REALTIME_TIMEOUT,
  });
  await expectNoReload(viewA);
});

test("E6 轉派給 B(move_booking reassign_main)⇒ A 那格消失、B 那格出現", async () => {
  const b = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "11:00",
    customerName: customer("E6"),
  });
  await expect(card(viewA, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(card(viewB, b.customerName)).toHaveCount(0);
  await adminRpc(fixture.m1, "move_booking", {
    p_booking_id: b.id,
    p_dragged_staff_id: fixture.staffA.staffId,
    p_target_staff_id: fixture.staffB.staffId,
    p_target_start_at: b.startAt,
    p_expected_start_at: b.startAt,
    p_expected_staff_id: fixture.staffA.staffId,
  });
  await expect(card(viewA, b.customerName)).toHaveCount(0, { timeout: REALTIME_TIMEOUT });
  await expect(card(viewB, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(card(viewB, b.customerName)).toContainText("主要服務人員");
  await expectNoReload(viewA);
  await expectNoReload(viewB);
});

test("E7 🔴 納編:把 A 加成 B 那張單的助手 ⇒ A 出現(協助);移除 ⇒ A 消失", async () => {
  const created = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffB.staffId,
    time: "12:00",
    customerName: customer("E7"),
  });
  const b = bookingFor(fixture.staffB, created);
  await expect(card(viewB, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(card(viewA, b.customerName)).toHaveCount(0);

  await adminSetAssistants(fixture, fixture.m1, b, [fixture.staffA.staffId]);
  await expect(card(viewA, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(card(viewA, b.customerName)).toContainText("協助");

  await adminSetAssistants(fixture, fixture.m1, b, []);
  await expect(card(viewA, b.customerName)).toHaveCount(0, { timeout: REALTIME_TIMEOUT });
  // 主要服務人員 B 那邊一直都在。
  await expect(card(viewB, b.customerName)).toBeVisible();
  await expectNoReload(viewA);
});

test("E8 取消一張 A 的單 ⇒ 那格自己消失", async () => {
  const b = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "13:00",
    customerName: customer("E8"),
  });
  await expect(card(viewA, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await adminRpc(fixture.m1, "cancel_booking", {
    p_booking_id: b.id,
    p_reason: "e2e 即時同步:取消",
  });
  await expect(card(viewA, b.customerName)).toHaveCount(0, { timeout: REALTIME_TIMEOUT });
  await expectNoReload(viewA);
});

test("E9 🔴 IDOR:在 A 的頁面訂 B 的頻道 ⇒ CHANNEL_ERROR,B 的單變動時一則都收不到", async () => {
  const topicB = viewB.topic;
  await viewA.page.evaluate(async (topic) => {
    const path = "/src/integrations/supabase/client.ts";
    const mod = (await import(/* @vite-ignore */ path)) as {
      supabase: {
        channel: (
          t: string,
          o: unknown,
        ) => {
          on: (type: string, filter: unknown, cb: () => void) => unknown;
          subscribe: (cb: (s: string) => void) => unknown;
        };
      };
    };
    const w = window as unknown as Record<string, unknown>;
    const state = { statuses: [] as string[], received: 0 };
    w["__idor"] = state;
    const ch = mod.supabase.channel(topic, { config: { private: true } });
    ch.on("broadcast", { event: "schedule_changed" }, () => {
      state.received += 1;
    });
    ch.subscribe((s) => state.statuses.push(s));
    w["__idorChannel"] = ch;
  }, topicB);

  await expect
    .poll(
      () =>
        viewA.page.evaluate(
          () =>
            (window as unknown as Record<string, { statuses: string[] }>)["__idor"]?.statuses ?? [],
        ),
      { timeout: 15_000, message: "訂別人的頻道要拿到 CHANNEL_ERROR" },
    )
    .toContain("CHANNEL_ERROR");
  const statuses = await viewA.page.evaluate(
    () => (window as unknown as Record<string, { statuses: string[] }>)["__idor"]!.statuses,
  );
  expect(statuses).not.toContain("SUBSCRIBED");

  // 正向對照:B 自己真的收到了(B 的畫面出現),A 偷訂的那條一則都沒有。
  const b = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffB.staffId,
    time: "15:00",
    customerName: customer("E9"),
  });
  await expect(card(viewB, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await viewA.page.waitForTimeout(1_000);
  const received = await viewA.page.evaluate(
    () => (window as unknown as Record<string, { received: number }>)["__idor"]!.received,
  );
  expect(received).toBe(0);
  expect(schedulePayloads(viewA.rt, topicB), "A 的 WebSocket 上沒有任何 B 頻道的訊號").toEqual([]);

  // 收掉偷訂的那條(不影響 A 自己的頻道),A 的頁面照常、沒有任何錯誤提示。
  await viewA.page.evaluate(async () => {
    const path = "/src/integrations/supabase/client.ts";
    const mod = (await import(/* @vite-ignore */ path)) as {
      supabase: { removeChannel: (c: unknown) => Promise<unknown> };
    };
    await mod.supabase.removeChannel(
      (window as unknown as Record<string, unknown>)["__idorChannel"],
    );
  });
  await expectNoToast(viewA);
  await expect(viewA.page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible();
});

test("E10 🔴 訊號原文:A / B 收發的所有 frame 搜不到任何客戶資料;payload 只有 v / reason / id", async () => {
  const forbidden = [
    ...fixture.secrets,
    `E2E即時客戶`, // 所有客戶姓名的共同前綴
    fixture.runId,
  ];
  for (const view of [viewA, viewB]) {
    const all = view.rt.texts.join("\n");
    expect(all.length, "正向對照:確實有錄到 frame").toBeGreaterThan(0);
    for (const s of forbidden) {
      expect(all.includes(s), `${view.staff.name} 的 WebSocket 裡不可以出現「${s}」`).toBe(false);
    }
    const payloads = schedulePayloads(view.rt, view.topic);
    expect(payloads.length, `${view.staff.name} 確實收過訊號`).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(Object.keys(p as object).sort()).toEqual(["id", "reason", "v"]);
      expect((p as { reason: string }).reason).toBe("schedule_changed");
    }
  }
  // 別家店 E:商家一的所有變動都沒有送到 E。
  expect(receivedE, "別家店的服務人員 E 從頭到尾收不到商家一的訊號").toEqual([]);
});

test("E11 關掉 A 的行事曆檢視 ⇒ 再改單 A 收不到訊號;重新整理後顯示既有空狀態、沒有錯誤彈窗、也不訂閱", async () => {
  await setCalendarView(fixture.staffA.staffId, false);
  try {
    const aBefore = schedulePayloads(viewA.rt, viewA.topic).length;
    const bBefore = schedulePayloads(viewB.rt, viewB.topic).length;
    // A 主要、B 助手:B 收得到(正向對照,證明訊號系統是活的),A 收不到(#885 發送端過濾)。
    const b = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffA.staffId,
      time: "16:00",
      customerName: customer("E11"),
      assistantIds: [fixture.staffB.staffId],
    });
    await expect(card(viewB, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
    expect(schedulePayloads(viewB.rt, viewB.topic).length).toBeGreaterThan(bBefore);
    await viewA.page.waitForTimeout(QUIET_MS);
    expect(
      schedulePayloads(viewA.rt, viewA.topic).length - aBefore,
      "權限關掉後 A 不再收到訊號",
    ).toBe(0);

    // 重新整理:頁面顯示既有的「尚未開放」空狀態,沒有錯誤彈窗,也不再訂閱 A 的頻道。
    const joinsBefore = joinSentCount(viewA.rt, viewA.topic);
    await viewA.page.reload();
    await expect(
      viewA.page.getByText("尚未開放此功能，請洽商家管理員開通「行事曆檢視」權限。"),
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    await viewA.page.waitForTimeout(QUIET_MS);
    expect(joinSentCount(viewA.rt, viewA.topic) - joinsBefore, "沒有權限就不訂閱").toBe(0);
    await expectNoToast(viewA);
  } finally {
    await setCalendarView(fixture.staffA.staffId, true);
  }

  // 權限打開後重新進入:重新訂閱,而且剛剛那張單看得到。
  const okBefore = joinOkCount(viewA.rt, viewA.topic);
  await viewA.page.reload();
  await expect(viewA.page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await waitJoinOk(viewA.rt, viewA.topic, okBefore + 1);
  await expect(viewA.page.getByText(/E2E即時客戶E11-/)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await markNoReload(viewA);
});

test("E12 離開行事曆頁 ⇒ 頻道被退訂(phx_leave),之後的變動不再送來;回來會重新訂閱並補上", async () => {
  const leavesBefore = leaveSentCount(viewA.rt, viewA.topic);
  await viewA.page.locator('nav a[href="/app/my-availability"]').click();
  await expect(viewA.page).toHaveURL(/\/app\/my-availability/);
  await expect
    .poll(() => leaveSentCount(viewA.rt, viewA.topic), {
      timeout: 10_000,
      message: "離開行事曆頁要送出 phx_leave",
    })
    .toBeGreaterThan(leavesBefore);

  const aBefore = schedulePayloads(viewA.rt, viewA.topic).length;
  const b = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "17:00",
    customerName: customer("E12"),
  });
  await viewA.page.waitForTimeout(QUIET_MS);
  expect(schedulePayloads(viewA.rt, viewA.topic).length - aBefore, "退訂後收不到").toBe(0);

  const okBefore = joinOkCount(viewA.rt, viewA.topic);
  await viewA.page.locator('nav a[href="/app/calendar"]').click();
  await expect(viewA.page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await waitJoinOk(viewA.rt, viewA.topic, okBefore + 1);
  await expect(card(viewA, b.customerName)).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expectNoReload(viewA);
});

test("E13 斷線補漏:setOffline(true) → 期間改單 → setOffline(false) ⇒ 連回後畫面自己補上", async () => {
  await viewA.context.setOffline(true);
  let b: CreatedBooking;
  try {
    await viewA.page.waitForTimeout(1_500);
    b = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffA.staffId,
      time: "18:00",
      customerName: customer("E13"),
    });
    await viewA.page.waitForTimeout(2_000);
    await expect(card(viewA, b.customerName), "離線期間畫面不可能自己變").toHaveCount(0);
  } finally {
    await viewA.context.setOffline(false);
  }
  await expect(card(viewA, b!.customerName)).toBeVisible({ timeout: 30_000 });
  await expectNoReload(viewA);
  await expectNoToast(viewA);
});

test("E13b 只切斷 Realtime 那條 WebSocket(瀏覽器保持在線、重連時 join 連續被斷線達放棄門檻以上)⇒ 放行後重連 SUBSCRIBED 自己補上(#897)", async ({
  browser,
}) => {
  // 新開一個 A 的情境,Realtime WebSocket 經過可控的轉接:可以隨時「從伺服器端」切斷,並暫時讓重連失敗。
  // 瀏覽器全程在線 ⇒ React Query 的 refetchOnReconnect 不會跑;不切分頁 ⇒ refetchOnWindowFocus 也不會跑。
  // 所以畫面補上只可能來自 #897「每次 SUBSCRIBED 都重查」。
  //
  // 🔴 阻擋期間的做法(為什麼不是一連上就直接關):phoenix 只對「不在 errored 狀態」的頻道回報錯誤。
  //    如果每次重連一連上就關,頻道一直停在 errored,整段只會收到第 1 次 CHANNEL_ERROR,鎖不住下面要鎖的坑。
  //    所以阻擋時先**接受**連線(不轉給伺服器),等瀏覽器送出這個頻道的 phx_join(此時頻道處於 joining 狀態)
  //    再關掉 ⇒ 每一輪重連都會回報一次 CHANNEL_ERROR(socket closed: 4001)。
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = recordRequestHosts(page);
  const topic = wireTopic(staffScheduleTopic(fixture.staffA.staffId));
  const liveSyncLogs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("[staff-schedule-live-sync]")) liveSyncLogs.push(msg.text());
  });
  let blocked = false;
  let connections = 0;
  /** 阻擋期間「收到 phx_join 才關掉」的次數 = 頻道在 joining 狀態被斷線的次數(每次各一個 CHANNEL_ERROR)。 */
  let joinsCut = 0;
  const live: WebSocketRoute[] = [];
  await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    connections += 1;
    if (blocked) {
      let cut = false;
      ws.onMessage((m) => {
        if (cut) return;
        const frame = decodeRealtimeFrame(m as string | Uint8Array);
        if (frame?.topic === topic && frame.event === "phx_join") {
          cut = true;
          joinsCut += 1;
          void ws.close({ code: 4001, reason: "e2e: 模擬斷線" });
        }
      });
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => server.close());
    server.onClose(() => ws.close());
    live.push(ws);
  });
  try {
    await page.route("**/functions/v1/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await injectSession(page, fixture.staffA.session);
    await page.goto("/app");
    await page.goto("/app/calendar");
    await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });

    // 先確認這個情境的即時同步是活的。
    const warm = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffA.staffId,
      time: "19:00",
      customerName: customer("E13b暖身"),
    });
    await expect(page.locator("li", { hasText: warm.customerName })).toBeVisible({
      timeout: REALTIME_TIMEOUT,
    });

    // 切斷,並讓之後的重連都在 join 時被斷線。
    blocked = true;
    const before = connections;
    for (const ws of live.splice(0)) await ws.close({ code: 4001, reason: "e2e: 模擬斷線" });
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(before);

    const b = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffA.staffId,
      time: "19:30",
      customerName: customer("E13b"),
    });
    // 🔴 刻意讓傳輸層 CHANNEL_ERROR **連續達到「連續錯誤就放棄」的門檻**(手機飛航模式 30 秒、切背景
    //    2 分鐘就是這種情況):一開始切斷算 1 次,之後每次重連在 join 時被斷線各再 1 次
    //    ⇒ 總數 = joinsCut + 1,這裡等到 >= STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS。
    //    如果把這種「傳輸層斷線」也算進「連續被拒就放棄」,頻道會在第 3 次被退掉,網路一恢復也不會再同步 ——
    //    這條就是在鎖住這個坑(故障注入:isTransportChannelError 永遠回 false ⇒ 下面「放行後補上」轉紅)。
    //    (不多等一輪:故障時頻道已被退掉,不會再送 join,多等只會卡在這裡,看不出是哪個斷言在擋。)
    await expect
      .poll(() => joinsCut + 1, {
        timeout: 45_000,
        message: `傳輸層 CHANNEL_ERROR 至少 ${STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS} 次(初次切斷 + 重連 join 被斷線)`,
      })
      .toBeGreaterThanOrEqual(STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS);
    await expect(page.locator("li", { hasText: b.customerName }), "斷線期間收不到").toHaveCount(0);

    // 放行重連 ⇒ 重新 join ⇒ SUBSCRIBED ⇒ 重查 ⇒ 補上。
    blocked = false;
    await expect(
      page.locator("li", { hasText: b.customerName }),
      "放行後要重新 SUBSCRIBED 並補查(傳輸層斷線不可以算進放棄次數)",
    ).toBeVisible({ timeout: 30_000 });
    expect(
      liveSyncLogs.filter((t) => t.includes("連續被拒")),
      "傳輸層斷線不可以讓即時同步放棄",
    ).toEqual([]);
    // 佐證 hook 真的收到了門檻次數以上的傳輸層 CHANNEL_ERROR(每次都以 info 記一筆 socket closed)。
    expect(
      liveSyncLogs.filter((t) => t.includes("CHANNEL_ERROR") && t.includes("socket closed")).length,
      "hook 收到的傳輸層 CHANNEL_ERROR 次數",
    ).toBeGreaterThanOrEqual(STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS);
    expect(await page.evaluate(() => navigator.onLine), "瀏覽器全程在線").toBe(true);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expectOnlyLocalRequests(requests);
  } finally {
    await context.close();
  }
});

test("收尾:全程沒有 pageerror、沒有 error 等級的即時同步 log", async () => {
  for (const v of [viewA, viewB]) {
    expect(v.pageErrors, `${v.staff.name} 的頁面不可以有未處理的錯誤`).toEqual([]);
    expect(v.liveSyncErrorLogs, `${v.staff.name} 即時同步只准記 warn / info`).toEqual([]);
  }
});
