// SPECS-INDEX #874 服務人員端行事曆即時同步 —— 批次 3:前端純邏輯(#889 / #894 / #896 / #897 / #899 / #900 / #903)。
//
// 背景:商家端新增/修改訂單時,資料庫 trigger 會對「受影響的那位服務人員」的私有頻道
// `staff:<merchant_staff.id>:schedule` 發一則 `schedule_changed` 訊號(批次 1/2)。訊號**不帶任何內容**
// (#886,payload 只有 {v, reason, id}),前端收到後只做一件事:把行事曆相關的 query 標成過期,
// 讓 React Query 重新打 `get_my_booking_schedule` 拿資料 —— 資料可見範圍完全不變。
//
// ⚠️ 這個檔案刻意只放純函式(沒有 React、沒有 supabase client),沿用 notifications/serviceWorkerBridge.ts
//    的既有模式:邏輯寫在 useEffect 裡就只能靠 e2e 驗,抽出來才能用 Vitest 完整鎖住(#904 第一層)。
//    真正掛訂閱的 hook `useStaffScheduleLiveSync` 是批次 4 的工作,會放在 context.tsx,並使用這裡的函式。

import type { QueryClient } from "@tanstack/react-query";

// =========================================================================
// #889 頻道命名 / 事件名稱 —— 前後端唯一來源
// =========================================================================

/** broadcast 事件名稱。資料庫端 `realtime.send(..., 'schedule_changed', ...)` 逐字對應。
 * 前端訂閱一律 `.on('broadcast', { event: STAFF_SCHEDULE_EVENT }, ...)`,不用 '*'。 */
export const STAFF_SCHEDULE_EVENT = "schedule_changed";

/** payload 裡 `reason` 欄位的唯一合法值(#886)。 */
export const STAFF_SCHEDULE_REASON = "schedule_changed";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** staffId 是不是合法的 UUID 字串(大小寫都接受;組頻道名時會統一轉小寫)。 */
export function isValidStaffId(staffId: unknown): staffId is string {
  return typeof staffId === "string" && UUID_PATTERN.test(staffId);
}

/**
 * 組服務人員的班表頻道名:`staff:<merchant_staff.id 小寫 UUID>:schedule`。
 *
 * 🔴 **全前端只能由這一支產生頻道名**,任何地方都不准自己字串相接(#889、提醒 2)。
 *    頻道名差一個字元或大小寫不同,Realtime **不會報錯,只會安靜地收不到**。
 *
 * 轉小寫的理由:資料庫端是 `'staff:' || p_staff_id::text || ':schedule'`,Postgres 的 uuid 轉文字
 * 一律是小寫標準寫法;前端如果拿到大寫的 id(理論上 PostgREST 不會給,但不靠運氣),轉小寫才對得上。
 */
export function staffScheduleTopic(staffId: string): string {
  return `staff:${staffId.toLowerCase()}:schedule`;
}

// =========================================================================
// #894 訊號解析:只接受預期格式,其他一律忽略
// =========================================================================

/**
 * 這則 broadcast 的 payload 該不該觸發重查。
 *
 * 只認 `payload.reason === 'schedule_changed'`,其他(null / undefined / 字串 / 數字 / 陣列 /
 * 空物件 / 其他 reason)一律 false,不丟錯 —— 比照 `shouldRefreshNotifications` 只認 'push-received'。
 * 刻意**不要求** `v === 1`:`v` 是給未來改格式時辨識版本用的,現在不該因為少了它就漏掉重查;
 * 漏一次重查的代價(畫面不即時)遠大於多重查一次(1 次 RPC)。
 */
export function shouldRefreshStaffSchedule(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return (payload as { reason?: unknown }).reason === STAFF_SCHEDULE_REASON;
}

/**
 * 給 `.on('broadcast', { event }, (message) => ...)` 回呼用的版本:supabase-js 交給回呼的是
 * 外層信封 `{ type: 'broadcast', event, payload }`,這裡同時檢查事件名與內層 payload。
 * 事件名不對(例如之後這個頻道多了別的事件)→ false。
 */
export function shouldRefreshFromBroadcast(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const { event, payload } = message as { event?: unknown; payload?: unknown };
  if (event !== STAFF_SCHEDULE_EVENT) return false;
  return shouldRefreshStaffSchedule(payload);
}

// =========================================================================
// #896 收到訊號要重查哪幾個 query(只列這兩個,不整個模組一起洗)
// =========================================================================

/**
 * 要 invalidate 的 queryKey 前綴,對應 context.tsx 的:
 * - useMyBookingSchedule:`["staff-portal-module", "my-booking-schedule", staffId, startDate, endDate]`
 * - useMyDayScheduleState:`["staff-portal-module", "my-day-schedule-state", staffId, date]`
 *
 * 刻意**不**包含 my-staff-record / my-staff-permission / my-booking-status-colors /
 * my-calendar-state-styles / my-day-business-hours / my-availability-overrides —— 那些跟訂單變動無關。
 * 用前綴 invalidate 會把所有已快取的日期範圍標成過期,但 React Query 只會立刻重抓「目前畫面上
 * 掛著的那一段」,實際成本就是 1 次 RPC(#896 / Q1 裁決)。
 */
export const STAFF_SCHEDULE_INVALIDATE_KEYS = [
  ["staff-portal-module", "my-booking-schedule"],
  ["staff-portal-module", "my-day-schedule-state"],
] as const;

/**
 * 對 #896 的每個 key 呼叫 `invalidateQueries`。回傳值代表「有沒有真的做事」,方便測試與除錯。
 *
 * #899:realtime 只是加分項,這裡任何失敗(同步丟錯或 Promise reject)都只記 console.warn,
 * 不往外丟、不留下 unhandled rejection,而且一個 key 失敗不影響另一個 key。
 */
export function invalidateStaffSchedule(
  queryClient: Pick<QueryClient, "invalidateQueries"> | null | undefined,
): boolean {
  if (!queryClient) return false;
  for (const queryKey of STAFF_SCHEDULE_INVALIDATE_KEYS) {
    try {
      const result = queryClient.invalidateQueries({ queryKey: [...queryKey] });
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          console.warn("[staff-schedule-live-sync] 重新查詢行事曆失敗", error);
        });
      }
    } catch (error) {
      console.warn("[staff-schedule-live-sync] 重新查詢行事曆失敗", error);
    }
  }
  return true;
}

// =========================================================================
// #900 去抖:trailing 400ms + maxWait 2000ms
// =========================================================================

export const STAFF_SCHEDULE_DEBOUNCE_MS = 400;
export const STAFF_SCHEDULE_MAX_WAIT_MS = 2000;

/** 可注入的計時器(測試用 fake timers 時不需要注入,預設就走全域的 setTimeout / Date.now)。 */
export interface StaffScheduleTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const defaultTimers: StaffScheduleTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface StaffScheduleRefreshScheduler {
  /** 收到一則訊號(或重連成功)時呼叫;實際的重查會被延後合併。 */
  trigger: () => void;
  /** 取消尚未執行的重查(元件卸載、換 staffId 時一定要呼叫,避免卸載後還去 invalidate)。 */
  cancel: () => void;
  /** 目前有沒有排定但還沒執行的重查(測試與除錯用)。 */
  isPending: () => boolean;
}

/**
 * 建一個「延遲合併」的重查排程器。
 *
 * - trailing debounce:最後一次 trigger 之後安靜 `waitMs`(預設 400ms)才執行一次 `onFlush`。
 * - maxWait:從這一輪**第一次** trigger 起算,最晚 `maxWaitMs`(預設 2000ms)一定執行一次 ——
 *   否則「一直有人改單」就永遠不更新。
 * - `onFlush` 丟錯只記 console.warn,不影響之後的排程(#899)。
 * - cancel 之後還可以繼續 trigger(重新開始新的一輪)。
 */
export function createStaffScheduleRefreshScheduler(
  onFlush: () => void,
  options: {
    waitMs?: number;
    maxWaitMs?: number;
    timers?: StaffScheduleTimers;
  } = {},
): StaffScheduleRefreshScheduler {
  const waitMs = Math.max(0, options.waitMs ?? STAFF_SCHEDULE_DEBOUNCE_MS);
  const maxWaitMs = Math.max(waitMs, options.maxWaitMs ?? STAFF_SCHEDULE_MAX_WAIT_MS);
  const timers = options.timers ?? defaultTimers;

  let handle: unknown = null;
  let firstTriggerAt: number | null = null;

  const clear = () => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
  };

  const flush = () => {
    handle = null;
    firstTriggerAt = null;
    try {
      onFlush();
    } catch (error) {
      console.warn("[staff-schedule-live-sync] 重新查詢行事曆失敗", error);
    }
  };

  return {
    trigger() {
      const now = timers.now();
      if (firstTriggerAt === null) firstTriggerAt = now;
      const remainingMaxWait = maxWaitMs - (now - firstTriggerAt);
      const delay = Math.max(0, Math.min(waitMs, remainingMaxWait));
      clear();
      handle = timers.setTimeout(flush, delay);
    },
    cancel() {
      clear();
      firstTriggerAt = null;
    },
    isPending() {
      return handle !== null;
    },
  };
}

// =========================================================================
// #895 / #903 要不要訂閱(權限被關掉時的處理決策)
// =========================================================================

/**
 * 決定現在該訂哪個頻道;回傳 null 代表「不要訂(已經訂的要退掉)」。
 *
 * 全部成立才訂(#895 啟用條件):
 * 1. staffId 已解出而且是合法 UUID;
 * 2. `staff_calendar_view` 權限**明確是 true** —— 還在載入(undefined)、查不到(null)、false 一律不訂,
 *    因為 #890 的政策一定會拒,先擋住可以避免製造 CHANNEL_ERROR 噪音。
 *
 * #903:權限在畫面開著時被關掉 → 下一次權限查詢回來是 false → 這裡回 null →
 * 批次 4 的 hook 把這個回傳值當 useEffect 的依賴,cleanup 會 removeChannel。
 * (資料層本來就安全:`get_my_booking_schedule` 每次重驗權限;發送端 v1.1 起也不再發。)
 */
export function resolveStaffScheduleSubscription(input: {
  staffId: string | null | undefined;
  hasCalendarView: boolean | null | undefined;
}): string | null {
  if (input.hasCalendarView !== true) return null;
  if (!isValidStaffId(input.staffId)) return null;
  return staffScheduleTopic(input.staffId);
}

// =========================================================================
// #897 / #899 訂閱狀態處理:重連補查、失敗靜默降級
// =========================================================================

/** supabase-js `REALTIME_SUBSCRIBE_STATES` 的字串值(這裡不 import supabase,保持純函式)。 */
export type StaffScheduleSubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/** 連續 CHANNEL_ERROR 幾次後放棄(不再讓 supabase-js 一直重試)。 */
export const STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS = 3;

export interface StaffScheduleChannelState {
  /** 連續 CHANNEL_ERROR 的次數;收到 SUBSCRIBED 歸零。 */
  consecutiveErrors: number;
  /** 已經放棄這個頻道(之後的狀態一律不處理)。 */
  gaveUp: boolean;
}

export const INITIAL_STAFF_SCHEDULE_CHANNEL_STATE: StaffScheduleChannelState = {
  consecutiveErrors: 0,
  gaveUp: false,
};

export interface StaffScheduleStatusDecision {
  state: StaffScheduleChannelState;
  /** 要不要觸發一次重查(經由去抖排程器)。 */
  refresh: boolean;
  /** 要記哪個等級的 console。🔴 任何情況都**不**彈 toast、不顯示錯誤區塊(#899)。 */
  log: "none" | "info" | "warn";
  /** 要不要退掉這個頻道、停止重試(連續被拒太多次)。 */
  giveUp: boolean;
}

/**
 * `.subscribe((status) => ...)` 回呼每收到一個狀態就呼叫一次,決定下一步。
 *
 * | 狀態 | 行為 |
 * |---|---|
 * | SUBSCRIBED | **每一次**都重查(不只第一次)—— 斷線期間的變更靠這裡補(#897);錯誤次數歸零 |
 * | TIMED_OUT / CLOSED | 不是錯誤(官方明講),交給 supabase-js 自己重連;只記 info |
 * | CHANNEL_ERROR | 政策拒絕 / JWT 問題 / 超過連線上限。記 warn(同一串連續錯誤只記第一次與放棄那次,避免洗版);
 * |  | 連續 `maxConsecutiveErrors` 次就建議放棄,行事曆照舊靠既有三個觸發點運作 |
 * | 其他未知字串 | 忽略,記 info |
 *
 * 已放棄之後的任何狀態都不再處理(refresh=false、log=none)。
 */
export function nextStaffScheduleChannelState(
  state: StaffScheduleChannelState,
  status: unknown,
  maxConsecutiveErrors: number = STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS,
): StaffScheduleStatusDecision {
  if (state.gaveUp) {
    return { state, refresh: false, log: "none", giveUp: false };
  }

  switch (status) {
    case "SUBSCRIBED":
      return {
        state: { consecutiveErrors: 0, gaveUp: false },
        refresh: true,
        log: "none",
        giveUp: false,
      };
    case "TIMED_OUT":
    case "CLOSED":
      return { state, refresh: false, log: "info", giveUp: false };
    case "CHANNEL_ERROR": {
      const consecutiveErrors = state.consecutiveErrors + 1;
      const giveUp = consecutiveErrors >= Math.max(1, maxConsecutiveErrors);
      return {
        state: { consecutiveErrors, gaveUp: giveUp },
        refresh: false,
        log: consecutiveErrors === 1 || giveUp ? "warn" : "none",
        giveUp,
      };
    }
    default:
      return { state, refresh: false, log: "info", giveUp: false };
  }
}

// =========================================================================
// 批次 4 補充:分辨「被拒」與「傳輸層斷線」兩種 CHANNEL_ERROR
// =========================================================================

/**
 * supabase-js 2.116 的 `.subscribe((status, err) => …)` 在兩種完全不同的情況都會給 CHANNEL_ERROR:
 *
 * | 來源 | err.message 長相 | 意義 |
 * |---|---|---|
 * | 伺服器回覆 join 失敗 | `Unauthorized: You do not have permissions to read …`、連線數爆滿等 | **被拒**,重試也沒用 ⇒ 算進 giveUp |
 * | 傳輸層(WebSocket 斷線 / 心跳逾時) | `socket closed: <code> (…)`、`channel error: transport failure`、`channel error: connection lost`、`heartbeat timeout` | **網路問題**,supabase-js 會自己重連 ⇒ 視同 CLOSED |
 *
 * 後者的訊息格式來自 realtime-js `lib/normalizeChannelError.ts`(與 phoenix 的 heartbeat timeout)。
 *
 * 為什麼要分:手機訊號不穩時「重連中又斷」會連續冒出好幾次傳輸層 CHANNEL_ERROR;如果也算進
 * 「連續 3 次就放棄」,網路恢復之後就再也不會即時同步(直到使用者重新進入行事曆頁),
 * 等於 #897「斷線重連補漏」失效。被拒才放棄,斷線一律交給 supabase-js 重連。
 */
const TRANSPORT_ERROR_PATTERN =
  /^(socket closed:|channel error: transport failure|channel error: connection lost|heartbeat timeout)/;

export function isTransportChannelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return TRANSPORT_ERROR_PATTERN.test(message);
}

/** 把 subscribe 回呼的 (status, error) 轉成 nextStaffScheduleChannelState 要看的狀態:
 * 傳輸層斷線造成的 CHANNEL_ERROR 視同 CLOSED(只記 info、不累計放棄次數),其他原樣傳回。 */
export function effectiveStaffScheduleStatus(status: unknown, error?: unknown): unknown {
  if (status === "CHANNEL_ERROR" && isTransportChannelError(error)) return "CLOSED";
  return status;
}
