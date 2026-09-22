// 模組 15(服務人員推播通知)規則 4.3 第 4 點/§8.1:dispatchPushNotification 是本模組最重要的
// 邊界原則——不等待、吞掉錯誤地呼叫 push-notify-dispatch Edge Function,即使這支函式整個掛掉或
// 逾時,也絕對不能讓錯誤往外拋、影響原本呼叫端(建立/取消/編輯訂單)的操作。完全比照模組 11
// dispatchLineNotification 的既有測試結構(src/modules/line-notifications/api.test.ts)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

async function importDispatch() {
  const mod = await import("./api");
  return mod.dispatchPushNotification;
}

describe("dispatchPushNotification(規則 4.3 第 4 點/§8.1 本模組最重要的邊界原則)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokeMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("呼叫參數正確:一般事件帶 merchant_id/booking_id/event_type,不帶 change_summary", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchPushNotification = await importDispatch();

    dispatchPushNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_created",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("push-notify-dispatch", {
      body: {
        merchant_id: "merchant-1",
        booking_id: "booking-1",
        event_type: "booking_created",
      },
    });
  });

  it("呼叫參數正確:booking_updated 事件帶上 change_summary", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchPushNotification = await importDispatch();

    dispatchPushNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_updated",
      changeSummary: "預約時間改為 09/26 15:00",
    });

    expect(invokeMock).toHaveBeenCalledWith("push-notify-dispatch", {
      body: {
        merchant_id: "merchant-1",
        booking_id: "booking-1",
        event_type: "booking_updated",
        change_summary: "預約時間改為 09/26 15:00",
      },
    });
  });

  it("回傳值是 undefined(void),不是 Promise——呼叫端不可能 await 到任何東西", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchPushNotification = await importDispatch();

    const returnValue = dispatchPushNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_created",
    });

    expect(returnValue).toBeUndefined();
  });

  it("Edge Function 呼叫失敗(reject)時,只留一行 console.error,不會讓呼叫端意外收到例外", async () => {
    invokeMock.mockRejectedValue(new Error("Edge Function 500"));
    const dispatchPushNotification = await importDispatch();

    dispatchPushNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_cancelled",
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("push-notify-dispatch");
  });

  it("Edge Function 呼叫失敗時,不會影響同一個呼叫端接下來的正常流程(模擬 createBooking 的使用情境)", async () => {
    invokeMock.mockRejectedValue(new Error("network error"));
    const dispatchPushNotification = await importDispatch();

    function simulateCreateBookingFlow(): string {
      const bookingId = "booking-created-id";
      dispatchPushNotification({
        merchantId: "merchant-1",
        bookingId,
        eventType: "booking_created",
      });
      return bookingId;
    }

    expect(() => simulateCreateBookingFlow()).not.toThrow();
    expect(simulateCreateBookingFlow()).toBe("booking-created-id");

    await Promise.resolve();
    await Promise.resolve();
  });
});
