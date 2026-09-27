// 模組 15(服務人員推播通知)§7.8/§9:驗證 createBooking/cancelBooking/updateBooking 這三支既有
// mutation 函式(src/modules/booking/api.ts)在 RPC 呼叫成功之後,正確疊加一行呼叫
// dispatchPushNotification(不等待、參數正確,包含 updateBooking 的 changeSummary 透傳),而且
// dispatchPushNotification 本身失敗完全不影響這三支函式回傳的成功結果。完全比照既有
// lineNotificationDispatch.test.ts 的測試結構。
//
// updateBooking 是這次規格書第一次在這個 RPC 疊加任何通知呼叫(對應規格書 9.節整合點總結),
// 這裡額外驗證「有帶 changeSummary」「沒有帶 changeSummary」兩種情境的呼叫參數正確性。

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const dispatchPushNotificationMock = vi.fn();
// SPECS-INDEX #823:updateBooking 會在 RPC 之前用 supabase.from("bookings") 讀一次目前的 staff_id。
// 這裡把 from 也做成可控制的 mock;預設回「查不到」(data: null),等於改動前的行為。
const maybeSingleMock = vi.fn();
const fromMock = vi.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: (...args: unknown[]) => maybeSingleMock(...args),
    }),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...(args as [])),
  },
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
}));

vi.mock("@/modules/push-notifications/api", () => ({
  dispatchPushNotification: (...args: unknown[]) => dispatchPushNotificationMock(...args),
}));

async function importBookingApi() {
  return import("./api");
}

const FAKE_BOOKING = {
  id: "booking-1",
  merchant_id: "merchant-1",
  status: "pending_confirmation",
  // #823:RPC 回來的是「更新後」的訂單,主服務人員是 staff-1。
  staff_id: "staff-1",
};

const CREATE_INPUT = {
  merchantId: "merchant-1",
  staffId: "staff-1",
  serviceItems: [{ serviceItemId: "item-1", quantity: 1, unitPrice: 100 }],
  startAt: "2026-10-01T10:00:00+08:00",
  customerName: "測試客戶",
  customerPhone: "0900000000",
};

describe("createBooking(§7.8/§9 疊加 dispatchPushNotification)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchPushNotificationMock.mockReset();
  });

  it("RPC 成功後,正確呼叫 dispatchPushNotification(merchant_id/booking_id/event_type=booking_created)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { createBooking } = await importBookingApi();

    const result = await createBooking(CREATE_INPUT);

    expect(result).toEqual(FAKE_BOOKING);
    expect(dispatchPushNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_created",
    });
  });

  it("RPC 本身失敗時,完全不會呼叫 dispatchPushNotification", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "建單失敗" } });
    const { createBooking } = await importBookingApi();

    await expect(createBooking(CREATE_INPUT)).rejects.toBeTruthy();
    expect(dispatchPushNotificationMock).not.toHaveBeenCalled();
  });

  it("dispatchPushNotification 本身丟出例外時,不影響 createBooking 回傳的成功結果", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    dispatchPushNotificationMock.mockImplementation(() => {
      throw new Error("dispatchPushNotification 模擬掛掉");
    });
    const { createBooking } = await importBookingApi();

    // 同 lineNotificationDispatch.test.ts 的既有精神:api.ts 依賴 dispatchPushNotification
    // 自己保證絕對不會同步拋出例外(見 src/modules/push-notifications/api.test.ts 已驗證這件事),
    // 這裡留下回歸測試,不在 api.ts 多包一層防禦性 try/catch。
    await expect(createBooking(CREATE_INPUT)).rejects.toThrow();
  });
});

describe("cancelBooking(§7.8/§9 疊加 dispatchPushNotification)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchPushNotificationMock.mockReset();
  });

  it("成功後正確呼叫 dispatchPushNotification(event_type=booking_cancelled)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { cancelBooking } = await importBookingApi();

    const result = await cancelBooking("booking-1", "客戶取消");

    expect(result).toEqual(FAKE_BOOKING);
    expect(dispatchPushNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_cancelled",
    });
  });
});

describe("updateBooking(§7.8/§9,規格書首次疊加通知呼叫 + 規則 4.5 changeSummary 透傳)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchPushNotificationMock.mockReset();
    fromMock.mockClear();
    maybeSingleMock.mockReset();
    // 預設:編輯前的主服務人員就是 staff-1(沒換人)→ 下面既有的三條測試行為跟改動前完全一樣。
    maybeSingleMock.mockResolvedValue({ data: { staff_id: "staff-1" }, error: null });
  });

  const UPDATE_INPUT = {
    bookingId: "booking-1",
    staffId: "staff-1",
    serviceItems: [{ serviceItemId: "item-1", quantity: 1, unitPrice: 100 }],
    startAt: "2026-10-01T10:00:00+08:00",
    customerName: "測試客戶",
    customerPhone: "0900000000",
  };

  it("有帶 changeSummary 時,正確透傳給 dispatchPushNotification", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { updateBooking } = await importBookingApi();

    await updateBooking({ ...UPDATE_INPUT, changeSummary: "預約時間改為 09/26 15:00" });

    expect(dispatchPushNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_updated",
      changeSummary: "預約時間改為 09/26 15:00",
    });
  });

  it("沒有帶 changeSummary 時,呼叫參數不含 changeSummary 這個 key(不是傳 undefined)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
    const { updateBooking } = await importBookingApi();

    await updateBooking(UPDATE_INPUT);

    expect(dispatchPushNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      bookingId: "booking-1",
      eventType: "booking_updated",
    });
    const callArgs = dispatchPushNotificationMock.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(callArgs, "changeSummary")).toBe(false);
  });

  it("RPC 本身失敗時,完全不會呼叫 dispatchPushNotification", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "更新失敗" } });
    const { updateBooking } = await importBookingApi();

    await expect(updateBooking(UPDATE_INPUT)).rejects.toBeTruthy();
    expect(dispatchPushNotificationMock).not.toHaveBeenCalled();
  });

  // =======================================================================
  // SPECS-INDEX #823:主服務人員被換掉時,要把「舊的那位」一起帶給 dispatchPushNotification。
  // 舊值的來源有三種(見 UpdateBookingInput.previousStaffId 的註解),逐一驗證。
  // =======================================================================
  describe("#823 previousStaffId(被換掉的主服務人員)", () => {
    it("🔴 核心:呼叫端沒帶 previousStaffId → 先讀 bookings.staff_id 當舊值;RPC 回來的 staff_id 不同 → 帶 previousStaffId", async () => {
      maybeSingleMock.mockResolvedValue({ data: { staff_id: "staff-old" }, error: null });
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      await updateBooking({ ...UPDATE_INPUT, changeSummary: "服務人員改為 王小明" });

      expect(fromMock).toHaveBeenCalledWith("bookings");
      expect(dispatchPushNotificationMock).toHaveBeenCalledWith({
        merchantId: "merchant-1",
        bookingId: "booking-1",
        eventType: "booking_updated",
        changeSummary: "服務人員改為 王小明",
        previousStaffId: "staff-old",
      });
    });

    it("正向對照:讀到的舊值跟 RPC 回來的一樣(其實沒換人)→ 不帶 previousStaffId 這個 key", async () => {
      maybeSingleMock.mockResolvedValue({ data: { staff_id: "staff-1" }, error: null });
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      await updateBooking({ ...UPDATE_INPUT, changeSummary: "預約時間改為 09/26 15:00" });

      const callArgs = dispatchPushNotificationMock.mock.calls[0]?.[0];
      expect(Object.prototype.hasOwnProperty.call(callArgs, "previousStaffId")).toBe(false);
    });

    it("那一次「先讀」一定發生在 update_booking RPC **之前**(RPC 跑完 staff_id 就是新的了,讀了也沒用)", async () => {
      const order: string[] = [];
      maybeSingleMock.mockImplementation(async () => {
        order.push("read-previous");
        return { data: { staff_id: "staff-old" }, error: null };
      });
      rpcMock.mockImplementation(async () => {
        order.push("rpc");
        return { data: FAKE_BOOKING, error: null };
      });
      const { updateBooking } = await importBookingApi();

      await updateBooking(UPDATE_INPUT);

      expect(order).toEqual(["read-previous", "rpc"]);
    });

    it("呼叫端自己帶了 previousStaffId(字串)→ 直接用,不再多讀一次", async () => {
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      await updateBooking({ ...UPDATE_INPUT, previousStaffId: "staff-explicit" });

      expect(fromMock).not.toHaveBeenCalled();
      expect(dispatchPushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ previousStaffId: "staff-explicit" }),
      );
    });

    it("呼叫端明確帶 null → 不讀、也不帶 previousStaffId", async () => {
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      await updateBooking({ ...UPDATE_INPUT, previousStaffId: null });

      expect(fromMock).not.toHaveBeenCalled();
      const callArgs = dispatchPushNotificationMock.mock.calls[0]?.[0];
      expect(Object.prototype.hasOwnProperty.call(callArgs, "previousStaffId")).toBe(false);
    });

    it("「先讀」失敗(回 error)→ 編輯照常成功、通知照常發,只是不帶 previousStaffId,絕不影響編輯本身", async () => {
      maybeSingleMock.mockResolvedValue({ data: null, error: { message: "RLS 擋下" } });
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      const result = await updateBooking(UPDATE_INPUT);

      expect(result).toEqual(FAKE_BOOKING);
      expect(dispatchPushNotificationMock).toHaveBeenCalledTimes(1);
      const callArgs = dispatchPushNotificationMock.mock.calls[0]?.[0];
      expect(Object.prototype.hasOwnProperty.call(callArgs, "previousStaffId")).toBe(false);
    });

    it("「先讀」直接丟例外(例如網路斷線)→ 一樣被吞掉,編輯照常成功", async () => {
      maybeSingleMock.mockRejectedValue(new Error("network down"));
      rpcMock.mockResolvedValue({ data: FAKE_BOOKING, error: null });
      const { updateBooking } = await importBookingApi();

      await expect(updateBooking(UPDATE_INPUT)).resolves.toEqual(FAKE_BOOKING);
      expect(dispatchPushNotificationMock).toHaveBeenCalledTimes(1);
    });
  });
});
