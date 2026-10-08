// SPECS-INDEX #874 服務人員端行事曆即時同步 —— 批次 4:hook 層測試(#904 第一層最後一列)。
//
// 對象:context.tsx 的 useStaffScheduleLiveSync(#895 ~ #899、#903)。
// 做法:注入一個假的 supabase client(channel / removeChannel),由測試手動推送訂閱狀態與 broadcast,
//      驗證「什麼時候訂、訂哪個頻道、什麼時候重查、什麼時候退訂、出錯時不往外丟」。
//      真的 WebSocket 由本機 e2e(e2e-local/staff-schedule-live-sync.spec.ts)驗。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 🔴 #899「不彈 toast」:把 sonner 換成替身,任何呼叫都會被記下來,測試最後斷言 0 次。
const toastSpy = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
  for (const k of ["error", "warning", "info", "success", "message"]) fn[k] = vi.fn();
  return fn;
});
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

// 預設路徑(不注入 client)會用全站的 supabase;換成替身,確認 hook 真的走它。
const defaultClient = vi.hoisted(() => ({ channel: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: defaultClient }));

import { useStaffScheduleLiveSync, type StaffScheduleRealtimeClient } from "./context";
import { STAFF_SCHEDULE_INVALIDATE_KEYS } from "./staffScheduleChannel";

const STAFF_A = "3f2a1b8c-4d5e-6f70-8192-a3b4c5d6e7f8";
const STAFF_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOPIC_A = `staff:${STAFF_A}:schedule`;
const TOPIC_B = `staff:${STAFF_B}:schedule`;

type StatusCallback = (status: string, error?: Error) => void;
type BroadcastCallback = (message: unknown) => void;

interface FakeChannel {
  topic: string;
  opts: unknown;
  onArgs: unknown[][];
  emitStatus: (status: string, error?: Error) => void;
  emitBroadcast: (message: unknown) => void;
}

function createFakeClient() {
  const log: string[] = [];
  const channels: FakeChannel[] = [];
  const client = {
    channel: vi.fn((topic: string, opts: unknown) => {
      let statusCb: StatusCallback | null = null;
      const broadcastCbs: BroadcastCallback[] = [];
      const fake: FakeChannel & { on: unknown; subscribe: unknown } = {
        topic,
        opts,
        onArgs: [],
        emitStatus: (status, error) => statusCb?.(status, error),
        emitBroadcast: (message) => broadcastCbs.forEach((cb) => cb(message)),
        on: (...args: unknown[]) => {
          fake.onArgs.push(args);
          broadcastCbs.push(args[2] as BroadcastCallback);
          return fake;
        },
        subscribe: (cb: StatusCallback) => {
          statusCb = cb;
          return fake;
        },
      };
      channels.push(fake);
      log.push(`channel:${topic}`);
      return fake;
    }),
    removeChannel: vi.fn((ch: FakeChannel) => {
      log.push(`remove:${ch.topic}`);
      return Promise.resolve("ok");
    }),
  };
  return { client, channels, log };
}

const SCHEDULE_MSG = {
  type: "broadcast",
  event: "schedule_changed",
  payload: { v: 1, reason: "schedule_changed", id: "x" },
};

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

function wrapperWith(strict = false) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const inner = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return strict ? <StrictMode>{inner}</StrictMode> : inner;
  };
}

type HookProps = {
  staffId: string | null | undefined;
  hasCalendarView: boolean | null | undefined;
  /** 假 client(型別上不是完整的 RealtimeChannel,所以這裡收 unknown,傳進 hook 時再轉型)。 */
  client?: unknown;
};

function renderLiveSync(initial: HookProps, strict = false) {
  return renderHook(
    (props: HookProps) =>
      useStaffScheduleLiveSync(props.staffId, {
        hasCalendarView: props.hasCalendarView,
        ...(props.client ? { client: props.client as StaffScheduleRealtimeClient } : {}),
      }),
    { initialProps: initial, wrapper: wrapperWith(strict) },
  );
}

/** 一次 flush = STAFF_SCHEDULE_INVALIDATE_KEYS.length 次 invalidate(#896 兩個 + #1011 兩個 + #1036 兩個)。 */
function flushCount(): number {
  return invalidateSpy.mock.calls.length / STAFF_SCHEDULE_INVALIDATE_KEYS.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient();
  invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  toastSpy.mockClear();
  for (const k of ["error", "warning", "info", "success", "message"]) toastSpy[k]?.mockClear();
  defaultClient.channel.mockReset();
  defaultClient.removeChannel.mockReset();
});

function expectNoToast() {
  expect(toastSpy).not.toHaveBeenCalled();
  for (const k of ["error", "warning", "info", "success", "message"]) {
    expect(toastSpy[k]).not.toHaveBeenCalled();
  }
}

describe("useStaffScheduleLiveSync — 什麼時候訂閱(#895)", () => {
  it.each([
    ["權限 false", STAFF_A, false],
    ["權限還在載入(undefined)", STAFF_A, undefined],
    ["權限查不到(null)", STAFF_A, null],
    ["staffId 還沒解出來", null, true],
    ["staffId 不是 UUID", "not-a-uuid", true],
  ])("%s ⇒ 完全不建頻道", (_label, staffId, hasCalendarView) => {
    const { client } = createFakeClient();
    renderLiveSync({ staffId, hasCalendarView, client });
    expect(client.channel).not.toHaveBeenCalled();
  });

  it("條件成立 ⇒ 用小寫頻道名、private: true 訂一次,只聽 schedule_changed(不是 '*')", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A.toUpperCase(), hasCalendarView: true, client });
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(channels[0]!.topic).toBe(TOPIC_A);
    expect(channels[0]!.opts).toEqual({ config: { private: true } });
    expect(channels[0]!.onArgs).toHaveLength(1);
    expect(channels[0]!.onArgs[0]![0]).toBe("broadcast");
    expect(channels[0]!.onArgs[0]![1]).toEqual({ event: "schedule_changed" });
  });

  it("不注入 client 時用全站共用的 supabase", () => {
    const { client } = createFakeClient();
    defaultClient.channel.mockImplementation(client.channel);
    defaultClient.removeChannel.mockImplementation(client.removeChannel);
    const { unmount } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true });
    expect(defaultClient.channel).toHaveBeenCalledWith(TOPIC_A, { config: { private: true } });
    unmount();
    expect(defaultClient.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("重新渲染(參數沒變)不會重訂", () => {
    const { client } = createFakeClient();
    const { rerender } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    rerender({ staffId: STAFF_A, hasCalendarView: true, client });
    rerender({ staffId: STAFF_A, hasCalendarView: true, client });
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
  });
});

describe("useStaffScheduleLiveSync — 收到訊號重查(#896 / #900)", () => {
  it("一則合法訊號 ⇒ 400ms 後只 invalidate #896 的兩個 key + #1011 的兩個 key + #1036 的每週時段與單日例外", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitBroadcast(SCHEDULE_MSG);
    vi.advanceTimersByTime(399);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidateSpy.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ["staff-portal-module", "my-booking-schedule"] },
      { queryKey: ["staff-portal-module", "my-day-schedule-state"] },
      { queryKey: ["staff-portal-module", "my-day-business-hours"] },
      { queryKey: ["staff-portal-module", "my-staff-record"] },
      { queryKey: ["booking-module", "staff-availability-windows"] },
      { queryKey: ["staff-portal-module", "my-availability-overrides"] },
    ]);
  });

  it("400ms 內連續 5 則 ⇒ 只重查 1 次", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    for (let i = 0; i < 5; i++) {
      channels[0]!.emitBroadcast(SCHEDULE_MSG);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(1000);
    expect(flushCount()).toBe(1);
  });

  it("一直有訊號(每 300ms 一則)⇒ maxWait 2000ms 內一定至少重查一次", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    for (let t = 0; t <= 2000; t += 300) {
      channels[0]!.emitBroadcast(SCHEDULE_MSG);
      vi.advanceTimersByTime(300);
    }
    expect(flushCount()).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["別的事件名", { ...SCHEDULE_MSG, event: "other" }],
    ["reason 不對", { ...SCHEDULE_MSG, payload: { reason: "x" } }],
    ["沒有 payload", { type: "broadcast", event: "schedule_changed" }],
    ["null", null],
    ["字串", "schedule_changed"],
  ])("不合格式的訊息(%s)⇒ 不重查", (_label, message) => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitBroadcast(message);
    vi.advanceTimersByTime(3000);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useStaffScheduleLiveSync — 重連補漏(#897)與靜默降級(#899)", () => {
  it("每一次 SUBSCRIBED 都重查(不只第一次)", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(500);
    expect(flushCount()).toBe(1);
    // 斷線 → supabase-js 自己重連 → 再一次 SUBSCRIBED
    channels[0]!.emitStatus("CLOSED");
    channels[0]!.emitStatus("TIMED_OUT");
    vi.advanceTimersByTime(500);
    expect(flushCount()).toBe(1);
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(500);
    expect(flushCount()).toBe(2);
  });

  it("TIMED_OUT / CLOSED 不是錯誤:只記 info,不 warn、不退訂、不丟錯、不彈 toast", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    expect(() => {
      channels[0]!.emitStatus("TIMED_OUT");
      channels[0]!.emitStatus("CLOSED");
    }).not.toThrow();
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(client.removeChannel).not.toHaveBeenCalled();
    expectNoToast();
  });

  it("CHANNEL_ERROR:記 warn、不丟錯、不彈 toast;連續 3 次就退訂(giveUp),之後的狀態一律不理", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    const err = new Error(
      "Unauthorized: You do not have permissions to read from this Channel topic",
    );
    expect(() => channels[0]!.emitStatus("CHANNEL_ERROR", err)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
    channels[0]!.emitStatus("CHANNEL_ERROR", err);
    channels[0]!.emitStatus("CHANNEL_ERROR", err);
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    // 放棄之後就算又冒出 SUBSCRIBED 也不重查
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(3000);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expectNoToast();
  });

  it("傳輸層斷線造成的 CHANNEL_ERROR(socket closed / 心跳逾時)連續很多次也不放棄;網路恢復 SUBSCRIBED 照樣補查", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(500);
    for (let i = 0; i < 6; i++) {
      channels[0]!.emitStatus("CHANNEL_ERROR", new Error(`socket closed: 1006`));
      channels[0]!.emitStatus("CHANNEL_ERROR", new Error("heartbeat timeout"));
    }
    expect(client.removeChannel).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(500);
    expect(flushCount()).toBe(2);
    expectNoToast();
  });

  it("斷線夾在被拒中間:只有被拒的那幾次算數", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    const denied = new Error("Unauthorized: You do not have permissions to read");
    channels[0]!.emitStatus("CHANNEL_ERROR", denied);
    channels[0]!.emitStatus("CHANNEL_ERROR", new Error("socket closed: 1006"));
    channels[0]!.emitStatus("CHANNEL_ERROR", denied);
    expect(client.removeChannel).not.toHaveBeenCalled();
    channels[0]!.emitStatus("CHANNEL_ERROR", denied);
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("中間成功過一次 SUBSCRIBED,錯誤次數就歸零(不會累計到放棄)", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitStatus("CHANNEL_ERROR");
    channels[0]!.emitStatus("CHANNEL_ERROR");
    channels[0]!.emitStatus("SUBSCRIBED");
    channels[0]!.emitStatus("CHANNEL_ERROR");
    channels[0]!.emitStatus("CHANNEL_ERROR");
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("giveUp 時已排定的重查也一併取消", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitBroadcast(SCHEDULE_MSG);
    channels[0]!.emitStatus("CHANNEL_ERROR");
    channels[0]!.emitStatus("CHANNEL_ERROR");
    channels[0]!.emitStatus("CHANNEL_ERROR");
    vi.advanceTimersByTime(3000);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("supabase.channel() 本身丟錯(例如瀏覽器封鎖 WebSocket)⇒ hook 不丟錯,只 warn", () => {
    const client = {
      channel: vi.fn(() => {
        throw new Error("WebSocket blocked");
      }),
      removeChannel: vi.fn(),
    } as unknown as StaffScheduleRealtimeClient;
    expect(() => renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expectNoToast();
  });

  it("removeChannel 丟錯或 reject ⇒ 卸載時不丟錯,只 warn", async () => {
    const { client } = createFakeClient();
    client.removeChannel.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const first = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    expect(() => first.unmount()).not.toThrow();
    client.removeChannel.mockImplementationOnce(() => Promise.reject(new Error("later")));
    const second = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    expect(() => second.unmount()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidateQueries 失敗 ⇒ 不往外丟", async () => {
    const { client, channels } = createFakeClient();
    invalidateSpy.mockRejectedValue(new Error("network"));
    renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitBroadcast(SCHEDULE_MSG);
    await vi.advanceTimersByTimeAsync(500);
    expect(warnSpy).toHaveBeenCalled();
    expectNoToast();
  });
});

describe("useStaffScheduleLiveSync — 退訂(#895 / #903)", () => {
  it("卸載 ⇒ removeChannel 被呼叫;已排定還沒執行的重查取消;之後的訊號不理", () => {
    const { client, channels } = createFakeClient();
    const { unmount } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    channels[0]!.emitBroadcast(SCHEDULE_MSG);
    unmount();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel.mock.calls[0]![0]).toBe(channels[0]);
    channels[0]!.emitBroadcast(SCHEDULE_MSG);
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(3000);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("切換商家(staffId 換掉)⇒ 先退舊頻道,再訂新頻道", () => {
    const { client, log } = createFakeClient();
    const { rerender } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    rerender({ staffId: STAFF_B, hasCalendarView: true, client });
    expect(log).toEqual([`channel:${TOPIC_A}`, `remove:${TOPIC_A}`, `channel:${TOPIC_B}`]);
  });

  it("#903 權限在畫面開著時被關掉 ⇒ 退訂;再打開 ⇒ 重新訂", () => {
    const { client, log } = createFakeClient();
    const { rerender } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client });
    rerender({ staffId: STAFF_A, hasCalendarView: false, client });
    expect(log).toEqual([`channel:${TOPIC_A}`, `remove:${TOPIC_A}`]);
    rerender({ staffId: STAFF_A, hasCalendarView: true, client });
    expect(log).toEqual([`channel:${TOPIC_A}`, `remove:${TOPIC_A}`, `channel:${TOPIC_A}`]);
  });

  it("React Strict Mode(掛→卸→掛)⇒ 第一次的頻道有被退掉,最後只留一個", () => {
    const { client, log } = createFakeClient();
    const { unmount } = renderLiveSync({ staffId: STAFF_A, hasCalendarView: true, client }, true);
    const created = log.filter((l) => l.startsWith("channel:")).length;
    const removed = log.filter((l) => l.startsWith("remove:")).length;
    expect(created - removed).toBe(1);
    unmount();
    expect(log.filter((l) => l.startsWith("remove:")).length).toBe(created);
  });
});
