// SPECS-INDEX #1036(第 23 批):服務人員端「每週可預約時段」+「單日例外」即時同步 —— 本機 e2e。
// 規格書:.project/specs/服務人員端時段即時同步-第23批.md
// 執行:E2E_LOCAL_PORT=5308 npx playwright test --config playwright.local.config.ts b23-1036(只連本機 Docker Supabase)。
//
//   N0 開好三個畫面:服務人員 A 的時間軸、A 的休假設定頁(= A 的另一台裝置)、服務人員 B 的休假設定頁
//   N1 🔴 商家管理員改 A 的時段結束時間 ⇒ A 的時間軸格子、A 的休假設定清單 5 秒內自己更新;B 什麼都收不到
//   N2 商家新增 / 刪除 A 的一組時段 ⇒ A 的休假設定清單 5 秒內出現 / 消失、時間軸格子跟著變
//   N3 🔴 A 正在改某一組(還沒存)時商家新增另一組 ⇒ 新的一組出現,A 正在改的草稿不被蓋掉
//   N4 A 在休假設定頁存檔 ⇒ A 開著的時間軸(另一個分頁 / 裝置)5 秒內自己更新
//   N5 🔴 單日例外(主腦裁決同批補):商家在行事曆點 A 的格子「關閉時段」/「開啟時段」⇒ A 的時間軸 5 秒內跟著變;
//      B 收不到
//   N6 🔴 A 正在改的那一組被商家刪掉 ⇒ 那一列消失、跳 toast「這組時段已被刪除」(主腦裁決)
//   全部:訊號 payload 只有 {id, reason, v};B 的 WebSocket 原文完全沒有 A 的頻道
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts(一店 A / B、別家店 E),teardown 一樣三段核對
// (含清本次服務人員 / 商家頻道的 realtime.messages 列)。商家端的寫入走管理員身分的 supabase-js
// (= 商家端「編輯服務人員 → 可預約時段」同一條 RLS 路徑)。
// 截圖存 B23_SHOTS(預設 test-results/b23-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { DAY_OF_WEEK_LABELS } from "../src/modules/booking/types";
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
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
  type LiveSyncStaff,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
/** 規格:5 秒內。 */
const REALTIME_TIMEOUT = 5_000;
const SHOTS = process.env["B23_SHOTS"] ?? "test-results/b23-shots";
const NO_RELOAD_MARK = "__e2eB23NoReload";

test.describe.configure({ mode: "serial", timeout: 180_000 });

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

function schedulePayloads(log: RealtimeLog, topic: string): unknown[] {
  return log.received
    .filter((f) => f.topic === wireTopic(topic) && f.event === "broadcast")
    .map((f) => f.payload as { event?: unknown; payload?: unknown } | null)
    .filter((env) => env?.event === "schedule_changed")
    .map((env) => env!.payload);
}

let fixture: LiveSyncFixture;
let setupFailed = false;
let dow = 0;
let dayLabel = "";
let windowId = "";
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];

let timelineA: Page;
let rtTimelineA: RealtimeLog;
let availA: Page;
let rtAvailA: RealtimeLog;
let availB: Page;
let rtAvailB: RealtimeLog;

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}失敗:${error.message}`);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await setupLiveSyncFixture();
    const svc = serviceClient();
    dow = new Date(buildTaipeiIso(fixture.dateKey, "12:00")).getUTCDay();
    dayLabel = `星期${DAY_OF_WEEK_LABELS[dow]}`;

    // A:有時段限制、可以新增編輯訂單(時間軸可點格子 = 會畫出每週時段)、按件計酬 + 排班自助(可進休假設定)。
    // B:按件計酬 + 排班自助(開休假設定頁,驗「收不到 A 的訊號」)。
    for (const staff of [fixture.staffA, fixture.staffB]) {
      must(
        `改服務人員 ${staff.name} 設定`,
        (
          await svc
            .from("merchant_staff")
            .update({
              unlimited_backend_edit: false,
              can_create_edit_orders: true,
              show_member_info: true,
              compensation_type: "piece_rate",
            })
            .eq("id", staff.staffId)
        ).error,
      );
      must(
        `開服務人員 ${staff.name} 排班自助`,
        (
          await svc.from("merchant_staff_permissions").upsert(
            {
              staff_id: staff.staffId,
              section_key: "staff_availability_self_manage",
              granted: true,
            },
            { onConflict: "staff_id,section_key" },
          )
        ).error,
      );
    }
    // fixture 建服務人員時開了 no_time_slot_limit;關掉後仍可能留著全天時段,先清掉 A / B 的時段再布置。
    must(
      "清 A / B 既有時段",
      (
        await svc
          .from("staff_availability_windows")
          .delete()
          .in("staff_id", [fixture.staffA.staffId, fixture.staffB.staffId])
      ).error,
    );
    const w = await svc
      .from("staff_availability_windows")
      .insert([
        {
          staff_id: fixture.staffA.staffId,
          day_of_week: dow,
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          staff_id: fixture.staffB.staffId,
          day_of_week: dow,
          start_time: "09:00",
          end_time: "12:00",
        },
      ])
      .select("id, staff_id");
    must("布置每週時段", w.error);
    windowId = (w.data as { id: string; staff_id: string }[]).find(
      (r) => r.staff_id === fixture.staffA.staffId,
    )!.id;
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  for (const c of contexts) await c.close();
  for (const r of recorders) expectOnlyLocalRequests(r);
  expect(pageErrors, "頁面沒有任何未處理的錯誤").toEqual([]);
  if (setupFailed || !fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  console.log("[b23 本機] 清理結果:\n" + actions.map((x) => `  - ${x}`).join("\n"));
});

async function newPage(browser: Browser, width = 1280): Promise<Page> {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
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

/** 時間軸某個時間那一格(#1049 起格線 00:00 開始,每格 30 分鐘)。 */
function slotAt(p: Page, time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const index = (h * 60 + m) / 30;
  return p.getByTestId("my-timeline-grid").locator(":scope > [data-slot-state]").nth(index);
}

async function openAvailability(p: Page, staff: LiveSyncStaff): Promise<void> {
  await injectSession(p, staff.session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/my-availability");
  await expect(p.getByRole("heading", { name: "休假設定" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(p.getByText(`${dayLabel} 09:00 - 12:00`)).toBeVisible({ timeout: LOAD_TIMEOUT });
}

function expectCleanPayloads(log: RealtimeLog, topic: string): void {
  for (const payload of schedulePayloads(log, topic)) {
    expect(Object.keys(payload as object).sort()).toEqual(["id", "reason", "v"]);
    expect((payload as { reason: string }).reason).toBe("schedule_changed");
  }
  const all = log.texts.join("\n");
  for (const s of [fixture.staffA.name, fixture.staffB.name, windowId, "09:00", "12:30", "13:00"]) {
    expect(all.includes(s), `WebSocket 不可以出現「${s}」`).toBe(false);
  }
}

test("N0 開好三個畫面:A 的時間軸、A 的休假設定(另一台裝置)、B 的休假設定,三頁都訂到自己的頻道", async ({
  browser,
}) => {
  timelineA = await newPage(browser);
  rtTimelineA = watchRealtime(timelineA);
  await injectSession(timelineA, fixture.staffA.session);
  await primeStaffCurrentMerchant(timelineA, LOAD_TIMEOUT);
  await timelineA.goto("/app/calendar");
  await expect(timelineA.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await timelineA.getByRole("button", { name: "時間軸格線" }).click();
  await expect(timelineA.getByTestId("my-timeline-grid")).toHaveAttribute(
    "data-interactive",
    "true",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(slotAt(timelineA, "09:00")).toHaveAttribute("data-slot-state", "available", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(slotAt(timelineA, "12:00")).toHaveAttribute("data-slot-state", "unavailable");

  availA = await newPage(browser, 375);
  rtAvailA = watchRealtime(availA);
  await openAvailability(availA, fixture.staffA);

  availB = await newPage(browser, 375);
  rtAvailB = watchRealtime(availB);
  await openAvailability(availB, fixture.staffB);

  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  const topicB = staffScheduleTopic(fixture.staffB.staffId);
  for (const [log, topic, who] of [
    [rtTimelineA, topicA, "A 的時間軸"],
    [rtAvailA, topicA, "A 的休假設定頁"],
    [rtAvailB, topicB, "B 的休假設定頁"],
  ] as const) {
    await expect
      .poll(() => joinOkCount(log, topic), { message: `${who}訂到自己的頻道`, timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
  }
  for (const p of [timelineA, availA, availB]) await markNoReload(p);
});

test("N1 🔴 商家改 A 的時段 ⇒ A 的時間軸、休假設定 5 秒內自己更新;B 收不到任何訊號", async () => {
  const topicB = staffScheduleTopic(fixture.staffB.staffId);
  const bBefore = schedulePayloads(rtAvailB, topicB).length;

  const upd = await fixture.m1.admin
    .from("staff_availability_windows")
    .update({ start_time: "09:00", end_time: "13:00" })
    .eq("id", windowId)
    .select("id");
  expect(upd.error, "商家管理員改時段").toBeNull();
  expect(upd.data?.length).toBe(1);

  await expect(
    availA.getByText(`${dayLabel} 09:00 - 13:00`),
    "A 的休假設定 5 秒內換成新時間",
  ).toBeVisible({ timeout: REALTIME_TIMEOUT });
  await expect(slotAt(timelineA, "12:00"), "A 的時間軸 12:00 那格 5 秒內變可預約").toHaveAttribute(
    "data-slot-state",
    "available",
    { timeout: REALTIME_TIMEOUT },
  );
  await availA.screenshot({ path: `${SHOTS}/N1-staffA-availability-live-375.png` });
  await slotAt(timelineA, "12:00").scrollIntoViewIfNeeded();
  await timelineA.screenshot({ path: `${SHOTS}/N1-staffA-timeline-live-1280.png` });

  // B:再等 3 秒,B 自己的頻道沒有任何新訊號、畫面不變
  await availB.waitForTimeout(3_000);
  expect(schedulePayloads(rtAvailB, topicB).length - bBefore, "B 的頻道沒有收到訊號").toBe(0);
  await expect(availB.getByText(`${dayLabel} 09:00 - 12:00`)).toBeVisible();
  expect(
    rtAvailB.texts.some((t) => t.includes(fixture.staffA.staffId)),
    "B 的 WebSocket 原文完全沒有 A 的頻道",
  ).toBe(false);

  for (const p of [timelineA, availA, availB]) expect(await stillNoReload(p)).toBe(true);
});

test("N2 商家新增 / 刪除 A 的一組時段 ⇒ A 的休假設定與時間軸 5 秒內出現 / 消失", async () => {
  const ins = await fixture.m1.admin
    .from("staff_availability_windows")
    .insert({
      staff_id: fixture.staffA.staffId,
      day_of_week: dow,
      start_time: "15:00",
      end_time: "16:00",
    })
    .select("id")
    .single();
  expect(ins.error, "商家管理員新增時段").toBeNull();
  const newId = (ins.data as { id: string }).id;
  await expect(availA.getByText(`${dayLabel} 15:00 - 16:00`)).toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  await expect(slotAt(timelineA, "15:00")).toHaveAttribute("data-slot-state", "available", {
    timeout: REALTIME_TIMEOUT,
  });

  const del = await fixture.m1.admin
    .from("staff_availability_windows")
    .delete()
    .eq("id", newId)
    .select("id");
  expect(del.error, "商家管理員刪除時段").toBeNull();
  expect(del.data?.length).toBe(1);
  await expect(availA.getByText(`${dayLabel} 15:00 - 16:00`)).toHaveCount(0, {
    timeout: REALTIME_TIMEOUT,
  });
  await expect(slotAt(timelineA, "15:00")).toHaveAttribute("data-slot-state", "unavailable", {
    timeout: REALTIME_TIMEOUT,
  });
  for (const p of [timelineA, availA]) expect(await stillNoReload(p)).toBe(true);
});

test("N3 🔴 A 正在改某一組(還沒存)時商家新增另一組 ⇒ 新的一組出現,A 的草稿不被蓋掉", async () => {
  const label = `${dayLabel} 09:00 - 13:00`;
  const end = availA.getByLabel(`${label}的結束時間`);
  await end.fill("13:30");
  await expect(availA.getByRole("button", { name: `儲存${label}` })).toBeVisible();

  const ins = await fixture.m1.admin
    .from("staff_availability_windows")
    .insert({
      staff_id: fixture.staffA.staffId,
      day_of_week: dow,
      start_time: "17:00",
      end_time: "18:00",
    })
    .select("id")
    .single();
  expect(ins.error, "商家管理員新增時段").toBeNull();

  await expect(availA.getByText(`${dayLabel} 17:00 - 18:00`), "新的一組 5 秒內出現").toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  await expect(end, "正在改的草稿沒被蓋掉").toHaveValue("13:30");
  await expect(availA.getByRole("button", { name: `儲存${label}` })).toBeVisible();
  await end.scrollIntoViewIfNeeded();
  await availA.screenshot({ path: `${SHOTS}/N3-staffA-dirty-kept-375.png` });
  expect(await stillNoReload(availA)).toBe(true);
});

test("N4 A 在休假設定存檔 ⇒ A 開著的時間軸(另一台裝置)5 秒內自己更新", async () => {
  await expect(slotAt(timelineA, "13:00")).toHaveAttribute("data-slot-state", "unavailable");
  const label = `${dayLabel} 09:00 - 13:00`;
  await availA.getByRole("button", { name: `儲存${label}` }).click();
  await expect(availA.getByText("已更新可預約時段")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(availA.getByText(`${dayLabel} 09:00 - 13:30`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(slotAt(timelineA, "13:00"), "時間軸 13:00 那格 5 秒內變可預約").toHaveAttribute(
    "data-slot-state",
    "available",
    { timeout: REALTIME_TIMEOUT },
  );
  await slotAt(timelineA, "13:00").scrollIntoViewIfNeeded();
  await timelineA.screenshot({ path: `${SHOTS}/N4-staffA-timeline-other-device-1280.png` });
  expect(await stillNoReload(timelineA)).toBe(true);

  const row = await serviceClient()
    .from("staff_availability_windows")
    .select("end_time")
    .eq("id", windowId)
    .single();
  expect((row.data as { end_time: string }).end_time).toBe("13:30:00");

  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  expect(schedulePayloads(rtTimelineA, topicA).length).toBeGreaterThanOrEqual(4);
  expectCleanPayloads(rtTimelineA, topicA);
  expectCleanPayloads(rtAvailA, topicA);
  expect(schedulePayloads(rtAvailB, staffScheduleTopic(fixture.staffB.staffId))).toEqual([]);
});

test("N5 🔴 單日例外:商家在行事曆點 A 的格子關閉 / 開啟 ⇒ A 的時間軸 5 秒內跟著變;B 收不到", async ({
  browser,
}) => {
  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  const topicB = staffScheduleTopic(fixture.staffB.staffId);
  const aBefore = schedulePayloads(rtTimelineA, topicA).length;
  const bBefore = schedulePayloads(rtAvailB, topicB).length;

  const merchant = await newPage(browser);
  const s = await fixture.m1.admin.auth.getSession();
  if (!s.data.session) throw new Error("讀不到管理員甲的 session");
  await injectSession(merchant, s.data.session);
  await merchant.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [
    getCurrentMerchantStorageKey(fixture.m1.adminUserId),
    fixture.m1.merchantId,
  ] as [string, string]);
  await merchant.goto(`/app/calendar?date=${fixture.dateKey}`);
  await merchant
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  const grid = merchant.getByTestId(`staff-grid-${fixture.staffA.staffId}`);
  await expect(grid).toBeVisible({ timeout: LOAD_TIMEOUT });
  const cell = grid.locator(":scope > [data-slot-state]").nth((10 * 60) / 30);
  await expect(cell).toHaveAttribute("data-slot-state", "available");
  await expect(slotAt(timelineA, "10:00")).toHaveAttribute("data-slot-state", "available");

  // 關閉時段(行事曆點格子 → set_staff_day_override)
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  await merchant.getByRole("menuitem", { name: "關閉時段" }).click();
  await expect(cell).toHaveAttribute("data-slot-state", "override-closed", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    slotAt(timelineA, "10:00"),
    "A 的時間軸 10:00 那格 5 秒內變不可預約",
  ).toHaveAttribute("data-slot-state", "override-closed", { timeout: REALTIME_TIMEOUT });
  await slotAt(timelineA, "10:00").scrollIntoViewIfNeeded();
  await timelineA.screenshot({ path: `${SHOTS}/N5-staffA-timeline-slot-closed-1280.png` });

  // 開啟時段(回到每週時段原本的狀態 ⇒ clear_staff_day_override)
  await cell.click();
  await merchant.getByRole("menuitem", { name: "開啟時段" }).click();
  await expect(cell).toHaveAttribute("data-slot-state", "available", { timeout: LOAD_TIMEOUT });
  await expect(
    slotAt(timelineA, "10:00"),
    "A 的時間軸 10:00 那格 5 秒內變回可預約",
  ).toHaveAttribute("data-slot-state", "available", { timeout: REALTIME_TIMEOUT });

  expect(schedulePayloads(rtTimelineA, topicA).length - aBefore).toBeGreaterThanOrEqual(2);
  await availB.waitForTimeout(3_000);
  expect(schedulePayloads(rtAvailB, topicB).length - bBefore, "B 的頻道沒有收到訊號").toBe(0);
  expect(await stillNoReload(timelineA)).toBe(true);
  await merchant.context().close();
});

test("N6 🔴 A 正在改的那一組被商家刪掉 ⇒ 那一列消失、跳 toast「這組時段已被刪除」", async () => {
  const label = `${dayLabel} 17:00 - 18:00`;
  const end = availA.getByLabel(`${label}的結束時間`);
  await end.fill("18:30");
  await expect(availA.getByRole("button", { name: `儲存${label}` })).toBeVisible();

  const del = await fixture.m1.admin
    .from("staff_availability_windows")
    .delete()
    .eq("staff_id", fixture.staffA.staffId)
    .eq("start_time", "17:00")
    .select("id");
  expect(del.error, "商家管理員刪除時段").toBeNull();
  expect(del.data?.length).toBe(1);

  await expect(availA.getByText("這組時段已被刪除"), "5 秒內跳 toast").toBeVisible({
    timeout: REALTIME_TIMEOUT,
  });
  await expect(availA.getByText(label)).toHaveCount(0);
  await availA.screenshot({ path: `${SHOTS}/N6-staffA-deleted-toast-375.png` });
  expect(await stillNoReload(availA)).toBe(true);

  const topicA = staffScheduleTopic(fixture.staffA.staffId);
  expectCleanPayloads(rtTimelineA, topicA);
  expectCleanPayloads(rtAvailA, topicA);
  expect(schedulePayloads(rtAvailB, staffScheduleTopic(fixture.staffB.staffId))).toEqual([]);
  expect(rtAvailB.texts.some((t) => t.includes(fixture.staffA.staffId))).toBe(false);
});
