// SPECS-INDEX #1003 / #1006(第 14 批):商家端行事曆即時同步 —— 純邏輯 + hook 層測試。
//
// 做法比照服務人員端 useStaffScheduleLiveSync.test.tsx:注入一個假的 supabase client(channel / removeChannel),
// 由測試手動推送訂閱狀態與 broadcast,驗證「訂哪個頻道、什麼時候重查、什麼時候退訂、出錯時不往外丟、不彈 toast」。
// 真的 WebSocket 由本機 e2e(e2e-local/b14-calendar-live-sync-and-cards.spec.ts)驗。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSpy = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
  for (const k of ["error", "warning", "info", "success", "message"]) fn[k] = vi.fn();
  return fn;
});
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

const defaultClient = vi.hoisted(() => ({ channel: vi.fn(), removeChannel: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: defaultClient }));

import {
  invalidateMerchantCalendar,
  MERCHANT_CALENDAR_INVALIDATE_KEYS,
  merchantCalendarTopic,
  resolveMerchantCalendarSubscription,
  shouldRefreshMerchantCalendar,
} from "./merchantCalendarChannel";
import {
  useMerchantCalendarLiveSync,
  type MerchantCalendarRealtimeClient,
} from "./useMerchantCalendarLiveSync";

const MERCHANT_A = "3f2a1b8c-4d5e-6f70-8192-a3b4c5d6e7f8";
const MERCHANT_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

const CALENDAR_MSG = {
  type: "broadcast",
  event: "calendar_changed",
  payload: { v: 1, reason: "calendar_changed", id: "x" },
};

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.fn>;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderLiveSync(merchantId: string | null | undefined, client: unknown) {
  return renderHook(
    (props: { merchantId: string | null | undefined }) =>
      useMerchantCalendarLiveSync(props.merchantId, {
        client: client as MerchantCalendarRealtimeClient,
      }),
    { initialProps: { merchantId }, wrapper: Wrapper },
  );
}

/** 一次 flush = MERCHANT_CALENDAR_INVALIDATE_KEYS.length 次 invalidate。 */
function flushCount(): number {
  return invalidateSpy.mock.calls.length / MERCHANT_CALENDAR_INVALIDATE_KEYS.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient();
  invalidateSpy = vi.fn(() => Promise.resolve());
  queryClient.invalidateQueries = invalidateSpy as unknown as QueryClient["invalidateQueries"];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("merchantCalendarChannel 純邏輯", () => {
  it("頻道名:merchant:<小寫 UUID>:calendar(資料庫授權函式只認小寫)", () => {
    expect(merchantCalendarTopic(MERCHANT_A.toUpperCase())).toBe(`merchant:${MERCHANT_A}:calendar`);
    expect(resolveMerchantCalendarSubscription(MERCHANT_A)).toBe(`merchant:${MERCHANT_A}:calendar`);
  });
  it("merchantId 還沒載入 / 不是 UUID ⇒ 不訂", () => {
    for (const bad of [null, undefined, "", "abc", "merchant-1"]) {
      expect(resolveMerchantCalendarSubscription(bad)).toBeNull();
    }
  });
  it("只認 event = calendar_changed 且 payload.reason = calendar_changed;其他形狀一律忽略、不丟錯", () => {
    expect(shouldRefreshMerchantCalendar(CALENDAR_MSG)).toBe(true);
    expect(
      shouldRefreshMerchantCalendar({
        event: "calendar_changed",
        payload: { reason: "calendar_changed" },
      }),
    ).toBe(true);
    for (const bad of [
      null,
      undefined,
      "calendar_changed",
      [],
      {},
      { event: "schedule_changed", payload: { reason: "calendar_changed" } },
      { event: "calendar_changed", payload: { reason: "schedule_changed" } },
      { event: "calendar_changed", payload: null },
      { event: "calendar_changed", payload: [] },
    ]) {
      expect(shouldRefreshMerchantCalendar(bad)).toBe(false);
    }
  });
  it("收到訊號只重查行事曆那幾支查詢,不整個 booking-module 一起洗", () => {
    const spy = vi.fn(() => Promise.resolve());
    expect(invalidateMerchantCalendar({ invalidateQueries: spy } as never)).toBe(true);
    expect(
      spy.mock.calls.map((c) => (c as unknown as [{ queryKey: string[] }])[0].queryKey),
    ).toEqual([
      ["booking-module", "day-schedule"],
      ["booking-module", "bookings-list"],
      ["booking-module", "month-badge-assistants"],
      ["booking-module", "booking-card-extras"],
      ["booking-module", "staff-availability-windows"],
      ["staff-agent-module", "staff-list"],
    ]);
    expect(invalidateMerchantCalendar(null)).toBe(false);
  });
  it("invalidate 失敗(同步丟錯 / reject)只記 warn,不往外丟", () => {
    expect(() =>
      invalidateMerchantCalendar({
        invalidateQueries: () => {
          throw new Error("boom");
        },
      } as never),
    ).not.toThrow();
  });
});

describe("useMerchantCalendarLiveSync", () => {
  it("🔴 訂自己商家的私有頻道(private: true),只聽 calendar_changed 事件", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync(MERCHANT_A, client);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.topic).toBe(`merchant:${MERCHANT_A}:calendar`);
    expect(channels[0]!.opts).toEqual({ config: { private: true } });
    expect(channels[0]!.onArgs[0]!.slice(0, 2)).toEqual([
      "broadcast",
      { event: "calendar_changed" },
    ]);
  });

  it("merchantId 還沒有 ⇒ 不訂;有了才訂", () => {
    const { client, channels } = createFakeClient();
    const view = renderLiveSync(null, client);
    expect(channels).toHaveLength(0);
    view.rerender({ merchantId: MERCHANT_A });
    expect(channels).toHaveLength(1);
  });

  it("收到訊號 ⇒ 去抖 400ms 後重查一次;連續多則合併成一次", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync(MERCHANT_A, client);
    channels[0]!.emitBroadcast(CALENDAR_MSG);
    channels[0]!.emitBroadcast(CALENDAR_MSG);
    channels[0]!.emitBroadcast(CALENDAR_MSG);
    expect(flushCount()).toBe(0);
    vi.advanceTimersByTime(400);
    expect(flushCount()).toBe(1);
  });

  it("形狀不對的訊號不重查", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync(MERCHANT_A, client);
    channels[0]!.emitBroadcast({ event: "calendar_changed", payload: { reason: "other" } });
    vi.advanceTimersByTime(3000);
    expect(flushCount()).toBe(0);
  });

  it("每次 SUBSCRIBED(含重連)都補查一次", () => {
    const { client, channels } = createFakeClient();
    renderLiveSync(MERCHANT_A, client);
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(400);
    channels[0]!.emitStatus("CLOSED");
    channels[0]!.emitStatus("SUBSCRIBED");
    vi.advanceTimersByTime(400);
    expect(flushCount()).toBe(2);
  });

  it("被拒連續 3 次 ⇒ 退訂放棄;傳輸層斷線不算", () => {
    const { client, channels, log } = createFakeClient();
    renderLiveSync(MERCHANT_A, client);
    for (let i = 0; i < 5; i += 1) {
      channels[0]!.emitStatus("CHANNEL_ERROR", new Error("socket closed: 1006"));
    }
    expect(log).not.toContain(`remove:merchant:${MERCHANT_A}:calendar`);
    for (let i = 0; i < 3; i += 1) {
      channels[0]!.emitStatus(
        "CHANNEL_ERROR",
        new Error("Unauthorized: You do not have permissions"),
      );
    }
    expect(log).toContain(`remove:merchant:${MERCHANT_A}:calendar`);
  });

  it("換商家 ⇒ 先退舊頻道再訂新頻道;卸載 ⇒ 退訂,之後的訊號不再重查", () => {
    const { client, channels, log } = createFakeClient();
    const view = renderLiveSync(MERCHANT_A, client);
    view.rerender({ merchantId: MERCHANT_B });
    expect(log).toEqual([
      `channel:merchant:${MERCHANT_A}:calendar`,
      `remove:merchant:${MERCHANT_A}:calendar`,
      `channel:merchant:${MERCHANT_B}:calendar`,
    ]);
    view.unmount();
    expect(log.at(-1)).toBe(`remove:merchant:${MERCHANT_B}:calendar`);
    channels[1]!.emitBroadcast(CALENDAR_MSG);
    vi.advanceTimersByTime(3000);
    expect(flushCount()).toBe(0);
  });

  it("建頻道本身丟錯 ⇒ 靜默降級(不往外丟、不彈 toast)", () => {
    const client = {
      channel: vi.fn(() => {
        throw new Error("WebSocket blocked");
      }),
      removeChannel: vi.fn(),
    };
    expect(() => renderLiveSync(MERCHANT_A, client)).not.toThrow();
    expect(toastSpy).not.toHaveBeenCalled();
    for (const k of ["error", "warning", "info", "success", "message"]) {
      expect(toastSpy[k]).not.toHaveBeenCalled();
    }
  });

  it("不傳 client ⇒ 用全站共用的 supabase", () => {
    const fake = createFakeClient();
    defaultClient.channel.mockImplementation(fake.client.channel);
    defaultClient.removeChannel.mockImplementation(fake.client.removeChannel);
    renderHook(() => useMerchantCalendarLiveSync(MERCHANT_A), { wrapper: Wrapper });
    expect(defaultClient.channel).toHaveBeenCalledWith(`merchant:${MERCHANT_A}:calendar`, {
      config: { private: true },
    });
  });
});
