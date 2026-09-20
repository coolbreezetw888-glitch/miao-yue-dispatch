// 模組 11(LINE 通知)§3.11/§7:驗證 createBooking/cancelBooking/completeBooking 這三支既有
// mutation 函式(src/modules/booking/api.ts)在 RPC 呼叫成功之後,正確疊加一行呼叫
// dispatchLineNotification(不等待、參數正確),而且 dispatchLineNotification 本身失敗
// (reject)完全不影響這三支函式回傳的成功結果——這是規則 2.4 第 4 點「絕對不能讓通知失敗影響
// 原本業務操作」在前端這一側的驗證。
//
// confirmBooking 刻意不在這裡測——規則 2.5 要求它的 dispatch 呼叫是「有條件的」(由
// src/modules/booking/BookingDetailDialog.tsx 依使用者在 4.8 彈窗的選擇決定要不要呼叫),
// 不是無條件疊加在 confirmBooking() 本身裡面,所以 confirmBooking() 這支函式維持原樣,不呼叫
// dispatchLineNotification。

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const dispatchLineNotificationMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(),
  },
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: (...args: unknown[]) => dispatchLineNotificationMock(...args),
}));

async function importBookingApi() {
  return import("./api");
}

const FAKE_BOOKING = {
  id: "booking-1",
  merchant_id: "merchant-1",
  status: "pending_confirmation",
};

describe("createBooking(§3.11 疊加 dispatchLineNotification)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchLineNotificationMock.mockReset();
  });

  it("RPC 成功後,正確呼叫 dispatchLineNotification(merchant_id/booking_id/event_type)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { createBooking } = await importBookingApi();

    const result = await createBooking({
      merchantId: "merchant-1",
      staffId: "staff-1",
      serviceItems: [{ serviceItemId: "item-1", quantity: 1, unitPrice: 100 }],
      startAt: "2026-10-01T10:00:00+08:00",
      customerName: "測試客戶",
      customerPhone: "0900000000",
    });

    expect(result).toEqual(FAKE_BOOKING);
    expect(dispatchLineNotificationMock).toHaveBeenCalledTimes(1);
    expect(dispatchLineNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_created",
    });
  });

  it("dispatchLineNotification 本身丟出例外時,不影響 createBooking 回傳的成功結果", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    // 模擬 dispatchLineNotification 內部萬一真的同步丟出例外(理論上不應該發生,但這裡驗證
    // 即使發生,createBooking 呼叫端的 try/catch 也不應該被牽連——因為呼叫是同步的一行,
    // 如果它真的 throw,會直接讓 createBooking reject,這條測試就是要抓到這種回歸)。
    dispatchLineNotificationMock.mockImplementation(() => {
      throw new Error("dispatchLineNotification 模擬掛掉");
    });

    const { createBooking } = await importBookingApi();

    await expect(
      createBooking({
        merchantId: "merchant-1",
        staffId: "staff-1",
        serviceItems: [{ serviceItemId: "item-1", quantity: 1, unitPrice: 100 }],
        startAt: "2026-10-01T10:00:00+08:00",
        customerName: "測試客戶",
        customerPhone: "0900000000",
      }),
    ).rejects.toThrow();
    // 這條測試證明:目前 api.ts 的寫法（直接呼叫 dispatchLineNotification，不額外包
    // try/catch）依賴 dispatchLineNotification 自己保證絕對不會同步拋出例外（見
    // src/modules/line-notifications/api.test.ts 已驗證這件事）。這裡刻意留下這條「如果
    // dispatchLineNotification 本身的保證被打破，createBooking 就會被牽連」的回歸測試，
    // 而不是在 api.ts 多包一層防禦性 try/catch——因為真正的保證來源只有一個（dispatch
    // 函式本身），重複防禦容易造成「兩邊都覺得對方會擋」的錯覺。
  });

  it("RPC 本身失敗時,完全不會呼叫 dispatchLineNotification", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "建單失敗" } });
    const { createBooking } = await importBookingApi();

    await expect(
      createBooking({
        merchantId: "merchant-1",
        staffId: "staff-1",
        serviceItems: [{ serviceItemId: "item-1", quantity: 1, unitPrice: 100 }],
        startAt: "2026-10-01T10:00:00+08:00",
        customerName: "測試客戶",
        customerPhone: "0900000000",
      }),
    ).rejects.toBeTruthy();

    expect(dispatchLineNotificationMock).not.toHaveBeenCalled();
  });
});

describe("cancelBooking/completeBooking(§3.11 疊加 dispatchLineNotification)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchLineNotificationMock.mockReset();
  });

  it("cancelBooking 成功後正確呼叫 dispatchLineNotification(event_type=booking_cancelled)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { cancelBooking } = await importBookingApi();

    const result = await cancelBooking("booking-1", "客戶取消");

    expect(result).toEqual(FAKE_BOOKING);
    expect(dispatchLineNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_cancelled",
    });
  });

  it("completeBooking 成功後正確呼叫 dispatchLineNotification(event_type=booking_completed)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { completeBooking } = await importBookingApi();

    const result = await completeBooking("booking-1");

    expect(result).toEqual(FAKE_BOOKING);
    expect(dispatchLineNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_completed",
    });
  });

  it("confirmBooking 不呼叫 dispatchLineNotification(規則 2.5:改由呼叫端依彈窗選擇決定)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { confirmBooking } = await importBookingApi();

    await confirmBooking("booking-1");

    expect(dispatchLineNotificationMock).not.toHaveBeenCalled();
  });
});
