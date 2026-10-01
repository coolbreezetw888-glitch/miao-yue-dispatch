// SPECS-INDEX #904 第一層(純函式):服務人員端行事曆即時同步的前端純邏輯。
// 對應 #889 頻道命名、#894 訊號解析、#896 重查清單、#897 重連補查、#899 靜默降級、#900 去抖、#903 權限被關。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_STAFF_SCHEDULE_CHANNEL_STATE,
  STAFF_SCHEDULE_DEBOUNCE_MS,
  STAFF_SCHEDULE_EVENT,
  STAFF_SCHEDULE_INVALIDATE_KEYS,
  STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS,
  STAFF_SCHEDULE_MAX_WAIT_MS,
  STAFF_SCHEDULE_REASON,
  createStaffScheduleRefreshScheduler,
  invalidateStaffSchedule,
  isValidStaffId,
  nextStaffScheduleChannelState,
  resolveStaffScheduleSubscription,
  shouldRefreshFromBroadcast,
  shouldRefreshStaffSchedule,
  staffScheduleTopic,
  type StaffScheduleChannelState,
  effectiveStaffScheduleStatus,
  isTransportChannelError,
} from "./staffScheduleChannel";

const STAFF_ID = "3f2a1b8c-4d5e-6f70-8192-a3b4c5d6e7f8";

/** 取陣列第 i 個元素;tsconfig 開了 noUncheckedIndexedAccess,這樣寫比到處加 ! 安全。 */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`第 ${index} 個元素不存在`);
  return item;
}

function first<T>(items: readonly T[]): T {
  return nth(items, 0);
}

function makeQueryClient() {
  return { invalidateQueries: vi.fn(() => Promise.resolve()) };
}

describe("#889 頻道命名與事件名稱", () => {
  it("staffScheduleTopic 逐字等於 staff:<uuid>:schedule(前後端不一致會安靜地完全沒反應)", () => {
    expect(staffScheduleTopic(STAFF_ID)).toBe(
      "staff:3f2a1b8c-4d5e-6f70-8192-a3b4c5d6e7f8:schedule",
    );
  });

  it("大寫 UUID 轉成小寫,對齊資料庫端 uuid::text 的寫法", () => {
    expect(staffScheduleTopic(STAFF_ID.toUpperCase())).toBe(staffScheduleTopic(STAFF_ID));
  });

  it("事件名與 reason 都是 schedule_changed(資料庫端 realtime.send 的 event 與 payload.reason)", () => {
    expect(STAFF_SCHEDULE_EVENT).toBe("schedule_changed");
    expect(STAFF_SCHEDULE_REASON).toBe("schedule_changed");
  });

  it("isValidStaffId 只認標準 UUID 字串", () => {
    expect(isValidStaffId(STAFF_ID)).toBe(true);
    expect(isValidStaffId(STAFF_ID.toUpperCase())).toBe(true);
    expect(isValidStaffId("abc")).toBe(false);
    expect(isValidStaffId("")).toBe(false);
    expect(isValidStaffId(`${STAFF_ID} `)).toBe(false);
    expect(isValidStaffId(`staff:${STAFF_ID}:schedule`)).toBe(false);
    expect(isValidStaffId(null)).toBe(false);
    expect(isValidStaffId(undefined)).toBe(false);
    expect(isValidStaffId(123)).toBe(false);
  });
});

describe("#894 shouldRefreshStaffSchedule:只接受預期格式", () => {
  it("資料庫實際送出的 payload {v:1, reason, id} → true", () => {
    expect(shouldRefreshStaffSchedule({ v: 1, reason: "schedule_changed", id: "some-uuid" })).toBe(
      true,
    );
  });

  it("只有 reason 也算(不因為少了 v 就漏掉重查)", () => {
    expect(shouldRefreshStaffSchedule({ reason: "schedule_changed" })).toBe(true);
  });

  it("其他/畸形 payload 一律 false,不丟錯", () => {
    expect(shouldRefreshStaffSchedule(null)).toBe(false);
    expect(shouldRefreshStaffSchedule(undefined)).toBe(false);
    expect(shouldRefreshStaffSchedule("schedule_changed")).toBe(false);
    expect(shouldRefreshStaffSchedule(42)).toBe(false);
    expect(shouldRefreshStaffSchedule(true)).toBe(false);
    expect(shouldRefreshStaffSchedule({})).toBe(false);
    expect(shouldRefreshStaffSchedule({ reason: "其他" })).toBe(false);
    expect(shouldRefreshStaffSchedule({ reason: "SCHEDULE_CHANGED" })).toBe(false);
    expect(shouldRefreshStaffSchedule({ reason: ["schedule_changed"] })).toBe(false);
    expect(shouldRefreshStaffSchedule({ type: "schedule_changed" })).toBe(false);
    expect(shouldRefreshStaffSchedule(["schedule_changed"])).toBe(false);
  });

  it("Object.create(null) 這種沒有原型的物件也不會丟錯", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    expect(shouldRefreshStaffSchedule(bare)).toBe(false);
    bare["reason"] = "schedule_changed";
    expect(shouldRefreshStaffSchedule(bare)).toBe(true);
  });
});

describe("#894 shouldRefreshFromBroadcast:supabase-js 回呼收到的外層信封", () => {
  it("event 與 payload 都對 → true", () => {
    expect(
      shouldRefreshFromBroadcast({
        type: "broadcast",
        event: "schedule_changed",
        payload: { v: 1, reason: "schedule_changed", id: "x" },
      }),
    ).toBe(true);
  });

  it("event 不對(之後頻道多了別的事件)→ false", () => {
    expect(
      shouldRefreshFromBroadcast({
        type: "broadcast",
        event: "something_else",
        payload: { reason: "schedule_changed" },
      }),
    ).toBe(false);
  });

  it("payload 不對 / 信封畸形 → false", () => {
    expect(shouldRefreshFromBroadcast({ event: "schedule_changed", payload: {} })).toBe(false);
    expect(shouldRefreshFromBroadcast({ event: "schedule_changed" })).toBe(false);
    // 把內層 payload 直接傳進來(沒有信封)不算 —— 避免批次 4 接錯層還誤以為正常
    expect(shouldRefreshFromBroadcast({ reason: "schedule_changed" })).toBe(false);
    expect(shouldRefreshFromBroadcast(null)).toBe(false);
    expect(shouldRefreshFromBroadcast(undefined)).toBe(false);
    expect(shouldRefreshFromBroadcast("schedule_changed")).toBe(false);
    expect(shouldRefreshFromBroadcast([])).toBe(false);
  });
});

describe("#896 invalidateStaffSchedule:只重查兩個 key", () => {
  it("清單逐字等於 my-booking-schedule 與 my-day-schedule-state 兩個前綴", () => {
    expect(STAFF_SCHEDULE_INVALIDATE_KEYS).toEqual([
      ["staff-portal-module", "my-booking-schedule"],
      ["staff-portal-module", "my-day-schedule-state"],
    ]);
  });

  it("剛好 invalidate 那兩個 key,回傳 true", () => {
    const queryClient = makeQueryClient();
    expect(invalidateStaffSchedule(queryClient)).toBe(true);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ["staff-portal-module", "my-booking-schedule"],
    });
    expect(queryClient.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["staff-portal-module", "my-day-schedule-state"],
    });
  });

  it("沒有碰 my-staff-record / my-staff-permission,也沒有整個 staff-portal-module 一起洗", () => {
    const queryClient = makeQueryClient();
    invalidateStaffSchedule(queryClient);
    const keys = queryClient.invalidateQueries.mock.calls.map(
      (call) => (call as unknown as [{ queryKey: unknown[] }])[0].queryKey,
    );
    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(2);
      expect(key[0]).toBe("staff-portal-module");
      expect([
        "my-staff-record",
        "my-staff-permission",
        "my-booking-status-colors",
        "my-calendar-state-styles",
        "my-day-business-hours",
        "my-availability-overrides",
      ]).not.toContain(key[1]);
    }
  });

  it("前綴對得上 context.tsx 實際的 queryKey(用 React Query 的前綴比對規則驗)", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const client = new QueryClient();
    const seed = (key: unknown[]) => client.setQueryData(key, "x");
    seed(["staff-portal-module", "my-booking-schedule", STAFF_ID, "2026-10-01", "2026-10-31"]);
    seed(["staff-portal-module", "my-day-schedule-state", STAFF_ID, "2026-10-01"]);
    seed(["staff-portal-module", "my-staff-record", "merchant-1"]);
    seed(["staff-portal-module", "my-staff-permission", STAFF_ID, "staff_calendar_view"]);

    invalidateStaffSchedule(client);

    const stale = (key: unknown[]) => client.getQueryState(key)?.isInvalidated;
    expect(
      stale(["staff-portal-module", "my-booking-schedule", STAFF_ID, "2026-10-01", "2026-10-31"]),
    ).toBe(true);
    expect(stale(["staff-portal-module", "my-day-schedule-state", STAFF_ID, "2026-10-01"])).toBe(
      true,
    );
    expect(stale(["staff-portal-module", "my-staff-record", "merchant-1"])).toBe(false);
    expect(
      stale(["staff-portal-module", "my-staff-permission", STAFF_ID, "staff_calendar_view"]),
    ).toBe(false);
    client.clear();
  });

  it("queryClient 是 null/undefined → 回 false,不丟錯", () => {
    expect(invalidateStaffSchedule(null)).toBe(false);
    expect(invalidateStaffSchedule(undefined)).toBe(false);
  });

  describe("#899 故障:重查失敗只記 console.warn,不往外丟", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("invalidateQueries 同步丟錯:不往外丟,第二個 key 照樣執行", () => {
      const queryClient = {
        invalidateQueries: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("boom");
          })
          .mockImplementation(() => Promise.resolve()),
      };
      expect(() => invalidateStaffSchedule(queryClient)).not.toThrow();
      expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("invalidateQueries 回傳 reject 的 Promise:被接住,不留下 unhandled rejection", async () => {
      const queryClient = {
        invalidateQueries: vi.fn(() => Promise.reject(new Error("network down"))),
      };
      expect(invalidateStaffSchedule(queryClient)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});

describe("#900 去抖:trailing 400ms + maxWait 2000ms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("預設值是 400ms / 2000ms", () => {
    expect(STAFF_SCHEDULE_DEBOUNCE_MS).toBe(400);
    expect(STAFF_SCHEDULE_MAX_WAIT_MS).toBe(2000);
  });

  it("400ms 內連續 5 則只觸發 1 次", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    for (let i = 0; i < 5; i += 1) {
      scheduler.trigger();
      vi.advanceTimersByTime(50);
    }
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("單一則訊號:399ms 還沒執行,400ms 剛好執行(trailing)", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    scheduler.trigger();
    expect(scheduler.isPending()).toBe(true);
    vi.advanceTimersByTime(399);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(scheduler.isPending()).toBe(false);
  });

  it("一直有訊號(每 300ms 一則、持續 5 秒):maxWait 2000ms 內一定至少觸發一次,不會永遠不更新", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    const flushTimes: number[] = [];
    onFlush.mockImplementation(() => flushTimes.push(Date.now()));
    const start = Date.now();
    for (let elapsed = 0; elapsed < 5000; elapsed += 300) {
      scheduler.trigger();
      vi.advanceTimersByTime(300);
    }
    // 第一次一定在 2000ms 內
    expect(flushTimes.length).toBeGreaterThanOrEqual(2);
    expect(nth(flushTimes, 0) - start).toBeLessThanOrEqual(STAFF_SCHEDULE_MAX_WAIT_MS);
    // 每兩次之間的間隔也不超過 maxWait(+ 一個訊號間隔的誤差)
    for (let i = 1; i < flushTimes.length; i += 1) {
      expect(nth(flushTimes, i) - nth(flushTimes, i - 1)).toBeLessThanOrEqual(
        STAFF_SCHEDULE_MAX_WAIT_MS + 300,
      );
    }
  });

  it("兩批相隔很久的訊號 → 各觸發一次(maxWait 的起算點每輪重設)", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    scheduler.trigger();
    vi.advanceTimersByTime(5000);
    scheduler.trigger();
    vi.advanceTimersByTime(399);
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("cancel(卸載 / 換 staffId)之後不會再執行,之後可以重新開始", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    scheduler.trigger();
    scheduler.cancel();
    expect(scheduler.isPending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onFlush).not.toHaveBeenCalled();

    scheduler.trigger();
    vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("cancel 會重設 maxWait 的起算點(不會因為上一輪殘留而立刻執行)", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    scheduler.trigger();
    vi.advanceTimersByTime(300);
    scheduler.cancel();
    vi.advanceTimersByTime(1900);
    scheduler.trigger();
    vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS - 1);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("可以自訂 waitMs / maxWaitMs;maxWaitMs 比 waitMs 小時以 waitMs 為準", () => {
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush, { waitMs: 100, maxWaitMs: 50 });
    scheduler.trigger();
    vi.advanceTimersByTime(99);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("可以注入自己的計時器(不靠 fake timers)", () => {
    let now = 0;
    const pending: Array<{ at: number; cb: () => void; id: number }> = [];
    let nextId = 1;
    const timers = {
      setTimeout: (cb: () => void, ms: number) => {
        const id = nextId++;
        pending.push({ at: now + ms, cb, id });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        const index = pending.findIndex((p) => p.id === handle);
        if (index >= 0) pending.splice(index, 1);
      },
      now: () => now,
    };
    const onFlush = vi.fn();
    const scheduler = createStaffScheduleRefreshScheduler(onFlush, { timers });
    scheduler.trigger();
    now = 200;
    scheduler.trigger();
    expect(pending).toHaveLength(1);
    expect(nth(pending, 0).at).toBe(600);
    now = 600;
    pending.shift()?.cb();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("#899 故障:onFlush 丟錯只記 warn,排程器之後照常運作", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFlush = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => {});
    const scheduler = createStaffScheduleRefreshScheduler(onFlush);
    scheduler.trigger();
    expect(() => vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(scheduler.isPending()).toBe(false);

    scheduler.trigger();
    vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("跟 invalidateStaffSchedule 串起來:批次改 5 張單 → 只打 2 次 invalidate(1 輪 × 2 個 key)", () => {
    const queryClient = makeQueryClient();
    const scheduler = createStaffScheduleRefreshScheduler(() =>
      invalidateStaffSchedule(queryClient),
    );
    for (let i = 0; i < 5; i += 1) {
      if (shouldRefreshStaffSchedule({ v: 1, reason: "schedule_changed" })) scheduler.trigger();
    }
    vi.advanceTimersByTime(STAFF_SCHEDULE_DEBOUNCE_MS);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });
});

describe("#895 / #903 resolveStaffScheduleSubscription:要不要訂、訂哪個頻道", () => {
  it("staffId 合法 + 行事曆檢視 true → 回頻道名", () => {
    expect(resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView: true })).toBe(
      staffScheduleTopic(STAFF_ID),
    );
  });

  it("行事曆檢視不是明確的 true(載入中 / 查不到 / false)→ null,不訂", () => {
    for (const hasCalendarView of [undefined, null, false]) {
      expect(resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView })).toBeNull();
    }
  });

  it("staffId 還沒解出或格式不對 → null", () => {
    for (const staffId of [null, undefined, "", "abc", `staff:${STAFF_ID}:schedule`]) {
      expect(resolveStaffScheduleSubscription({ staffId, hasCalendarView: true })).toBeNull();
    }
  });

  it("#903 權限在畫面開著時被關掉:回傳值從頻道名變成 null(hook 拿它當 effect 依賴,cleanup 會退訂)", () => {
    const before = resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView: true });
    const after = resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView: false });
    expect(before).not.toBeNull();
    expect(after).toBeNull();
  });

  it("切換商家(staffId 變)→ 頻道名跟著變,舊的會被退掉", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(resolveStaffScheduleSubscription({ staffId: other, hasCalendarView: true })).not.toBe(
      resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView: true }),
    );
  });

  it("同一個 staffId 大小寫不同 → 同一個頻道名(不會因此重新訂閱)", () => {
    expect(
      resolveStaffScheduleSubscription({ staffId: STAFF_ID.toUpperCase(), hasCalendarView: true }),
    ).toBe(resolveStaffScheduleSubscription({ staffId: STAFF_ID, hasCalendarView: true }));
  });
});

describe("#897 / #899 nextStaffScheduleChannelState:訂閱狀態處理", () => {
  const run = (
    statuses: unknown[],
    start: StaffScheduleChannelState = INITIAL_STAFF_SCHEDULE_CHANNEL_STATE,
  ) => {
    let state = start;
    return statuses.map((status) => {
      const decision = nextStaffScheduleChannelState(state, status);
      state = decision.state;
      return decision;
    });
  };

  it("SUBSCRIBED → 重查(第一次)", () => {
    const d = first(run(["SUBSCRIBED"]));
    expect(d.refresh).toBe(true);
    expect(d.log).toBe("none");
    expect(d.giveUp).toBe(false);
  });

  it("#897 斷線重連:每一次 SUBSCRIBED 都重查,不只第一次", () => {
    const decisions = run(["SUBSCRIBED", "CLOSED", "SUBSCRIBED", "TIMED_OUT", "SUBSCRIBED"]);
    expect(decisions.map((d) => d.refresh)).toEqual([true, false, true, false, true]);
  });

  it("TIMED_OUT / CLOSED 不是錯誤:不重查、只記 info、不放棄", () => {
    for (const status of ["TIMED_OUT", "CLOSED"]) {
      const d = first(run([status]));
      expect(d).toMatchObject({ refresh: false, log: "info", giveUp: false });
      expect(d.state.consecutiveErrors).toBe(0);
    }
  });

  it("CHANNEL_ERROR:記 warn、不重查;同一串連續錯誤只 warn 第一次與放棄那次", () => {
    const decisions = run(["CHANNEL_ERROR", "CHANNEL_ERROR", "CHANNEL_ERROR"]);
    expect(decisions.map((d) => d.log)).toEqual(["warn", "none", "warn"]);
    expect(decisions.every((d) => d.refresh === false)).toBe(true);
    expect(decisions.map((d) => d.giveUp)).toEqual([false, false, true]);
    expect(STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS).toBe(3);
  });

  it("CHANNEL_ERROR 之後成功連上 → 錯誤次數歸零,而且照樣重查", () => {
    const decisions = run(["CHANNEL_ERROR", "CHANNEL_ERROR", "SUBSCRIBED", "CHANNEL_ERROR"]);
    expect(nth(decisions, 2)).toMatchObject({ refresh: true, giveUp: false });
    expect(nth(decisions, 2).state.consecutiveErrors).toBe(0);
    expect(nth(decisions, 3)).toMatchObject({ log: "warn", giveUp: false });
    expect(nth(decisions, 3).state.consecutiveErrors).toBe(1);
  });

  it("CLOSED / TIMED_OUT 夾在錯誤中間不會把錯誤次數歸零", () => {
    const decisions = run([
      "CHANNEL_ERROR",
      "CLOSED",
      "CHANNEL_ERROR",
      "TIMED_OUT",
      "CHANNEL_ERROR",
    ]);
    expect(nth(decisions, 4).giveUp).toBe(true);
  });

  it("放棄之後的任何狀態都不再處理(包含 SUBSCRIBED)", () => {
    const decisions = run([
      "CHANNEL_ERROR",
      "CHANNEL_ERROR",
      "CHANNEL_ERROR",
      "SUBSCRIBED",
      "CHANNEL_ERROR",
    ]);
    expect(nth(decisions, 3)).toMatchObject({ refresh: false, log: "none", giveUp: false });
    expect(nth(decisions, 4)).toMatchObject({ refresh: false, log: "none", giveUp: false });
  });

  it("門檻可自訂;門檻 ≤ 0 時視為 1(第一次錯誤就放棄)", () => {
    expect(
      nextStaffScheduleChannelState(INITIAL_STAFF_SCHEDULE_CHANNEL_STATE, "CHANNEL_ERROR", 1)
        .giveUp,
    ).toBe(true);
    expect(
      nextStaffScheduleChannelState(INITIAL_STAFF_SCHEDULE_CHANNEL_STATE, "CHANNEL_ERROR", 0)
        .giveUp,
    ).toBe(true);
  });

  it("未知狀態 / 畸形輸入:忽略,不丟錯", () => {
    for (const status of ["JOINING", "", null, undefined, 42, {}]) {
      const d = first(run([status]));
      expect(d).toMatchObject({ refresh: false, log: "info", giveUp: false });
    }
  });

  it("不會改到傳進來的 state 物件(純函式)", () => {
    const state: StaffScheduleChannelState = { consecutiveErrors: 1, gaveUp: false };
    const frozen = Object.freeze({ ...state });
    expect(() => nextStaffScheduleChannelState(frozen, "CHANNEL_ERROR")).not.toThrow();
    expect(() => nextStaffScheduleChannelState(frozen, "SUBSCRIBED")).not.toThrow();
    expect(frozen).toEqual(state);
  });
});

describe("檔案本身:純邏輯、沒有 React / supabase client 依賴(#894)", () => {
  it("原始碼裡沒有 import react 或 supabase client", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // jsdom 環境下 import.meta.url 是 http:// 開頭,沿用 appLayoutLogic.test.ts 的做法改用 process.cwd()
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/modules/staff-portal/staffScheduleChannel.ts"),
      "utf8",
    );
    const imports = source.split(/\r?\n/).filter((line) => /^\s*import\s/.test(line));
    expect(imports.some((line) => /from\s+["']react["']/.test(line))).toBe(false);
    expect(imports.some((line) => /supabase/.test(line))).toBe(false);
    // 唯一允許的 import 是 react-query 的型別
    expect(imports.every((line) => /^import type /.test(line))).toBe(true);
    // 用語一律「服務人員」(用 unicode 跳脫寫,測試檔自己也不出現那個詞)
    expect(source.includes("\u5e2b\u5085")).toBe(false);
  });
});

// 批次 4 補充:分辨「被拒」與「傳輸層斷線」(本機 e2e E13b 實測 realtime-js 2.116 的訊息格式)
describe("isTransportChannelError / effectiveStaffScheduleStatus", () => {
  it.each([
    new Error("socket closed: 1006"),
    new Error("socket closed: 4001 (e2e: 模擬斷線)"),
    new Error("channel error: transport failure"),
    new Error("channel error: connection lost"),
    new Error("heartbeat timeout"),
    "socket closed: 1000",
  ])("傳輸層斷線:%s ⇒ true,狀態視同 CLOSED", (error) => {
    expect(isTransportChannelError(error)).toBe(true);
    expect(effectiveStaffScheduleStatus("CHANNEL_ERROR", error)).toBe("CLOSED");
  });

  it.each([
    new Error(
      "Unauthorized: You do not have permissions to read from this Channel topic: staff:x:schedule",
    ),
    new Error("too_many_connections"),
    new Error("error"),
    undefined,
    null,
    { message: "socket closed: 1006" }, // 不是 Error 也不是字串 ⇒ 不認(寧可算被拒,最多就是提早放棄)
  ])("被拒或認不出來:%s ⇒ false,CHANNEL_ERROR 原樣保留(會累計放棄次數)", (error) => {
    expect(isTransportChannelError(error)).toBe(false);
    expect(effectiveStaffScheduleStatus("CHANNEL_ERROR", error)).toBe("CHANNEL_ERROR");
  });

  it("其他狀態一律原樣傳回(就算帶了斷線訊息)", () => {
    const err = new Error("socket closed: 1006");
    for (const s of ["SUBSCRIBED", "TIMED_OUT", "CLOSED", "WHATEVER"]) {
      expect(effectiveStaffScheduleStatus(s, err)).toBe(s);
    }
  });
});
