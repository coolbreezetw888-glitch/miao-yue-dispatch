// SPECS-INDEX #964 / #906「跨店佔用灰色格子的即時同步」—— 本機 e2e(批次 5)。
// 執行:`npm run test:e2e:local`(只連本機 Docker Supabase;預設的 `npm run test:e2e` 連正式庫,不收這支)。
//
// 情境:同一個人(同一集團、電話相同)在一店、二店各有一列 merchant_staff。他用一店那一列登入,
//      停在 /app/calendar 的「時間軸格線」**不重新載入**;Node 端以商家管理員身分(不是 service_role)
//      在**二店**替二店那一列建單 ⇒ 一店畫面上那個時段要在 5 秒內自己變成「外店預約中」的灰色格。
//      批次 1~4 只通知二店那一列的頻道,這條在 migration 20261001160000(fan-out)之前一定是紅的。
//
// 同時斷言:
//   ・畫面是自己變的(頁面沒有重新載入的記號還在);
//   ・一店那一列的頻道確實收到 schedule_changed,payload 只有 {id, reason, v};
//   ・WebSocket 全部 frame 原文搜不到客戶姓名 / 電話 / 備註 / 地址 / 二店店名;
//   ・同一店的另一位服務人員 B(不同人)沒收到這次跨店變動。
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts(兩間商家、A / B / E 三位服務人員),
// 本檔只多做一件事:用商家一的管理員在**同一集團**下開一間二店(create_merchant_in_group,前端同一支 RPC),
// 並在二店新增一列跟 A 同電話的服務人員(不開通登入 —— 跨店收件看的是一店那一列的狀態)。
// 二店店名用 fixture 的前綴 ⇒ teardownLiveSyncFixture 會把整個集團(含二店)一起硬刪、刪後核對為 0。
//
// 用語:一律「服務人員」。
import { expect, test, type Page } from "@playwright/test";

import { staffScheduleTopic } from "../src/modules/staff-portal/staffScheduleChannel";
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
  injectSession,
  MERCHANT_NAME_PREFIX,
  SERVICE_ITEM_NAME,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
  type LiveSyncMerchant,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
/** 規格書 #904:「斷言畫面在 5 秒內自己變化」。 */
const REALTIME_TIMEOUT = 5_000;
const NO_RELOAD_MARK = "__e2eCrossStoreNoReload";
const CROSS_STORE_TIME = "15:00";

test.describe.configure({ mode: "serial", timeout: 120_000 });

interface RealtimeLog {
  received: RealtimeFrame[];
  sent: RealtimeFrame[];
  texts: string[];
}

function watchRealtime(page: Page): RealtimeLog {
  const log: RealtimeLog = { received: [], sent: [], texts: [] };
  page.on("websocket", (ws) => {
    if (!/\/realtime\/v1\/websocket/.test(ws.url())) return;
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

function schedulePayloads(log: RealtimeLog, topic: string): unknown[] {
  return log.received.map((f) => scheduleBroadcastPayload(f, topic)).filter((p) => p !== undefined);
}

let fixture: LiveSyncFixture;
let setupFailed = false;
let branch: LiveSyncMerchant;
let branchStaffId: string;
let page: Page;
let pageB: Page;
let rtA: RealtimeLog;
let rtB: RealtimeLog;
let requestsA: RequestRecorder;
let requestsB: RequestRecorder;
const pageErrors: string[] = [];
const closers: (() => Promise<void>)[] = [];

/** 在商家一的集團底下開二店,並新增一列跟服務人員 A 同電話的服務人員(同一個人在二店的那一列)。 */
async function createBranchWithSamePerson(f: LiveSyncFixture): Promise<void> {
  const admin = f.m1.admin;
  const name = `${MERCHANT_NAME_PREFIX}二店${f.runId}`;
  const created = await admin.rpc("create_merchant_in_group", {
    p_group_id: f.m1.groupId,
    p_name: name,
    p_industry_type: "on_site_dispatch",
    p_address: "E2E跨店測試地址",
    p_intro: "#964 跨店即時同步本機 e2e 測試分店,測試完硬刪除。",
  });
  if (created.error || !created.data) {
    throw new Error(`建立二店失敗:${created.error?.message ?? "沒有回傳 id"}`);
  }
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

  // A 的電話(service_role 只用來讀 fixture 自己建的那一列)
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
      no_time_slot_limit: true,
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

async function openCalendar(
  browserNewContext: () => Promise<import("@playwright/test").BrowserContext>,
  session: LiveSyncFixture["staffA"]["session"],
  log: (p: Page) => RealtimeLog,
): Promise<{ page: Page; rt: RealtimeLog; requests: RequestRecorder }> {
  const context = await browserNewContext();
  closers.push(() => context.close());
  const p = await context.newPage();
  const rt = log(p);
  const requests = recordRequestHosts(p);
  p.on("pageerror", (err) => {
    if (!/ServiceWorker|sw\.js|unsupported MIME type|ERR_NAME_NOT_RESOLVED/.test(err.message)) {
      pageErrors.push(err.message);
    }
  });
  await p.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(p, session);
  await p.goto("/app");
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  return { page: p, rt, requests };
}

test.beforeAll(async ({ browser }) => {
  try {
    fixture = await setupLiveSyncFixture();
    await createBranchWithSamePerson(fixture);
    const a = await openCalendar(() => browser.newContext(), fixture.staffA.session, watchRealtime);
    page = a.page;
    rtA = a.rt;
    requestsA = a.requests;
    const b = await openCalendar(() => browser.newContext(), fixture.staffB.session, watchRealtime);
    pageB = b.page;
    rtB = b.rt;
    requestsB = b.requests;
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  const guardErrors: unknown[] = [];
  for (const r of [requestsA, requestsB]) {
    if (!r) continue;
    try {
      expectOnlyLocalRequests(r);
    } catch (err) {
      guardErrors.push(err);
    }
  }
  for (const close of closers) await close();
  if (!setupFailed && fixture) {
    const actions = await teardownLiveSyncFixture(fixture);
    console.log(
      "[staff-schedule-cross-store-live-sync 本機] 清理結果:\n" +
        actions.map((x) => `  - ${x}`).join("\n"),
    );
  }
  if (guardErrors.length > 0) throw guardErrors[0];
});

test("X1 🔴 二店替同一個人建單 ⇒ 正在看一店行事曆(時間軸格線)的他,灰色「外店預約中」格子即時出現", async () => {
  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  const topicB = staffScheduleTopic(fixture.staffB.staffId);
  await expect
    .poll(() => joinOkCount(rtA, topicA), {
      message: "A 先訂到自己(一店那一列)的頻道",
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => joinOkCount(rtB, topicB), { message: "B 也訂到自己的頻道", timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: "時間軸格線" }).click();
  const greyCell = page.getByText(`${CROSS_STORE_TIME}・外店預約中`);
  await expect(page.getByText(`${CROSS_STORE_TIME}`, { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(greyCell, "前提:建單前一店畫面沒有灰色格").toHaveCount(0);
  await page.evaluate((mark) => {
    (window as unknown as Record<string, unknown>)[mark] = true;
  }, NO_RELOAD_MARK);
  const aBefore = schedulePayloads(rtA, topicA).length;
  const bBefore = schedulePayloads(rtB, topicB).length;

  await adminCreateBooking(fixture, branch, {
    staffId: branchStaffId,
    time: CROSS_STORE_TIME,
    customerName: `E2E跨店客戶-${fixture.runId}`,
  });

  await expect(greyCell, "灰色跨店佔用格要在 5 秒內自己出現").toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  const still = await page.evaluate(
    (mark) => (window as unknown as Record<string, unknown>)[mark] === true,
    NO_RELOAD_MARK,
  );
  expect(still, "畫面是自己更新的,頁面沒有重新載入").toBe(true);
  expect(
    schedulePayloads(rtA, topicA).length - aBefore,
    "一店那一列的頻道收到了跨店 fan-out 訊號",
  ).toBeGreaterThanOrEqual(1);

  await pageB.waitForTimeout(1_000);
  expect(schedulePayloads(rtB, topicB).length - bBefore, "同店不同人 B 收不到這次跨店變動").toBe(0);
});

test("X2 🔴 跨店訊號原文:A 的 WebSocket 搜不到客戶資料與二店店名;payload 只有 v / reason / id", async () => {
  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  const forbidden = [...fixture.secrets, "E2E跨店客戶", `二店${fixture.runId}`, "E2E跨店測試地址"];
  const all = rtA.texts.join("\n");
  expect(all.length, "正向對照:確實有錄到 frame").toBeGreaterThan(0);
  for (const s of forbidden) {
    expect(all.includes(s), `A 的 WebSocket 裡不可以出現「${s}」`).toBe(false);
  }
  const payloads = schedulePayloads(rtA, topicA);
  expect(payloads.length).toBeGreaterThan(0);
  for (const p of payloads) {
    expect(Object.keys(p as object).sort()).toEqual(["id", "reason", "v"]);
    expect((p as { reason: string }).reason).toBe("schedule_changed");
  }
  expect(pageErrors, "全程沒有 pageerror").toEqual([]);
});
