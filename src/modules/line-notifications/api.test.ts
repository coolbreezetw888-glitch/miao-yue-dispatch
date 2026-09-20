// 模組 11(LINE 通知)§2.4 第 4 點/§3.11/§7:dispatchLineNotification 是本模組最重要的邊界
// 原則——不等待、吞掉錯誤地呼叫 line-notify-dispatch Edge Function,即使這支函式整個掛掉或
// 逾時,也絕對不能讓錯誤往外拋、影響原本呼叫端(建立/確認/取消/完成訂單、登記請假)的操作。
//
// 驗證重點:
//   1. 呼叫參數正確(merchant_id/booking_id/staff_leave_record_id/event_type 正確從
//      camelCase 轉成 snake_case,選填欄位沒有值時不帶出去)。
//   2. 回傳值是 undefined(void),不是 Promise——呼叫端不可能、也不需要 await 到任何東西。
//   3. Edge Function 呼叫失敗(reject)時,不會造成未處理的 Promise rejection、不會拋出例外
//      讓呼叫端的 try/catch 意外抓到,只會呼叫 console.error 留一行紀錄。

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
  return mod.dispatchLineNotification;
}

describe("dispatchLineNotification(規則 2.4 第 4 點/§3.11 本模組最重要的邊界原則)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokeMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("呼叫參數正確:booking 事件帶 merchant_id/booking_id/event_type,不帶 staff_leave_record_id", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchLineNotification = await importDispatch();

    dispatchLineNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_confirmed",
    });

    // dispatchLineNotification 內部沒有 await,呼叫後 invoke 應該已經被同步觸發一次。
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("line-notify-dispatch", {
      body: {
        merchant_id: "merchant-1",
        booking_id: "booking-1",
        event_type: "booking_confirmed",
      },
    });
  });

  it("呼叫參數正確:staff_leave 事件帶 merchant_id/staff_leave_record_id/event_type,不帶 booking_id", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchLineNotification = await importDispatch();

    dispatchLineNotification({
      merchantId: "merchant-1",
      staffLeaveRecordId: "leave-1",
      eventType: "staff_leave_created",
    });

    expect(invokeMock).toHaveBeenCalledWith("line-notify-dispatch", {
      body: {
        merchant_id: "merchant-1",
        staff_leave_record_id: "leave-1",
        event_type: "staff_leave_created",
      },
    });
  });

  it("回傳值是 undefined(void),不是 Promise——呼叫端不可能 await 到任何東西", async () => {
    invokeMock.mockResolvedValue({ data: { dispatched: true }, error: null });
    const dispatchLineNotification = await importDispatch();

    const returnValue = dispatchLineNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_created",
    });

    expect(returnValue).toBeUndefined();
  });

  it("Edge Function 呼叫失敗(reject)時,只留一行 console.error,不會讓呼叫端意外收到例外", async () => {
    invokeMock.mockRejectedValue(new Error("Edge Function 500"));
    const dispatchLineNotification = await importDispatch();

    // 這裡刻意「不」用 try/catch 包住呼叫——如果 dispatchLineNotification 真的把錯誤往外拋,
    // 這個測試本身就會直接失敗(unhandled rejection / thrown error),不需要額外斷言。
    dispatchLineNotification({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_cancelled",
    });

    // 讓內部 .catch() 的 microtask 有機會真的執行完。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("line-notify-dispatch");
  });

  it("Edge Function 呼叫失敗時,不會影響同一個呼叫端接下來的正常流程(模擬 createBooking 的使用情境)", async () => {
    invokeMock.mockRejectedValue(new Error("network error"));
    const dispatchLineNotification = await importDispatch();

    // 模擬呼叫端(例如 src/modules/booking/api.ts 的 createBooking)在拿到 RPC 成功結果之後
    // 疊加呼叫 dispatchLineNotification,接著繼續往下執行、回傳結果給更上層——這整段流程
    // 不應該被 dispatchLineNotification 的失敗打斷。
    function simulateCreateBookingFlow(): string {
      const bookingId = "booking-created-id";
      dispatchLineNotification({
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
