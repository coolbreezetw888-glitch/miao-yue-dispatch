// #986 第 9 批:服務人員包裝 RPC 的前端呼叫端。
//   ・9-1 / 9-2:staffCreateBooking / staffUpdateBooking 帶料錢參數(第 11 批 F 起是 p_material_cost_items;帶陣列才送;沒帶 = 不送這個 key,
//     舊行為:建單不帶料錢、改單由後端維持原料錢)
//   ・9-4:使用者裁決「服務人員改單 / 拖拉不通知客戶」⇒ staffUpdateBooking、staffMoveBooking 成功後**不可**呼叫
//     dispatchLineNotification(只發商家內部推播);建單、取消、完成照舊發 LINE。
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  dispatchLine: vi.fn(),
  dispatchPush: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => m.rpc(...args),
    from: vi.fn(),
    storage: { from: vi.fn() },
    functions: { invoke: vi.fn() },
  },
}));
vi.mock("@/modules/line-notifications/api", () => ({ dispatchLineNotification: m.dispatchLine }));
vi.mock("@/modules/push-notifications/api", () => ({ dispatchPushNotification: m.dispatchPush }));

import {
  staffCancelBooking,
  staffCompleteBooking,
  staffCreateBooking,
  staffMoveBooking,
  staffUpdateBooking,
} from "./api";

const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const ITEM = { serviceItemId: "33333333-3333-4333-8333-333333333333", quantity: 1, unitPrice: 800 };
const MAT = "88888888-8888-4888-8888-888888888888";

const BASE = {
  serviceItems: [ITEM],
  startAt: "2036-01-05T10:00:00+08:00",
  customerName: "王小姐",
  customerPhone: "0988000111",
};

beforeEach(() => {
  m.rpc.mockReset();
  m.dispatchLine.mockReset();
  m.dispatchPush.mockReset();
});

function rpcArgs(): Record<string, unknown> {
  return m.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("料錢參數(9-1 / 9-2)", () => {
  // 第 11 批 F #993:料錢參數改成 p_material_cost_items(品項 + 數量 + 自訂成本單價)。
  it("建單帶料錢 ⇒ p_material_cost_items(含數量 / 單價);沒帶 ⇒ 不送這個 key(舊行為)", async () => {
    m.rpc.mockResolvedValue({ data: { id: BOOKING_ID, merchant_id: MERCHANT_ID }, error: null });
    await staffCreateBooking({
      staffId: STAFF_ID,
      ...BASE,
      materialCostItems: [{ materialCostItemId: MAT, quantity: 3, unitPrice: 12.5 }],
    });
    expect(rpcArgs()["p_material_cost_items"]).toEqual([
      { material_cost_item_id: MAT, quantity: 3, unit_price: 12.5 },
    ]);
    expect(Object.prototype.hasOwnProperty.call(rpcArgs(), "p_material_cost_item_ids")).toBe(false);
    m.rpc.mockClear();
    await staffCreateBooking({ staffId: STAFF_ID, ...BASE });
    expect(Object.prototype.hasOwnProperty.call(rpcArgs(), "p_material_cost_items")).toBe(false);
  });

  it("改單帶空陣列 ⇒ 照送 [](= 全部拿掉,不可以被當成沒帶);不帶 ⇒ 不送(後端維持數量與單價)", async () => {
    m.rpc.mockResolvedValue({ data: { id: BOOKING_ID, merchant_id: MERCHANT_ID }, error: null });
    await staffUpdateBooking({ bookingId: BOOKING_ID, ...BASE, materialCostItems: [] });
    expect(rpcArgs()["p_material_cost_items"]).toEqual([]);
    m.rpc.mockClear();
    await staffUpdateBooking({ bookingId: BOOKING_ID, ...BASE });
    expect(Object.prototype.hasOwnProperty.call(rpcArgs(), "p_material_cost_items")).toBe(false);
  });
});

describe("服務人員改單 / 拖拉不通知客戶(9-4)", () => {
  it("staffUpdateBooking 成功 ⇒ 只發推播 booking_updated,不呼叫 LINE", async () => {
    m.rpc.mockResolvedValue({ data: { id: BOOKING_ID, merchant_id: MERCHANT_ID }, error: null });
    await staffUpdateBooking({ bookingId: BOOKING_ID, ...BASE });
    expect(m.dispatchLine).not.toHaveBeenCalled();
    expect(m.dispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, eventType: "booking_updated" }),
    );
  });

  it("staffMoveBooking 成功 ⇒ 只發推播 booking_updated,不呼叫 LINE", async () => {
    m.rpc.mockResolvedValue({
      data: {
        mode: "time",
        booking: { id: BOOKING_ID, merchant_id: MERCHANT_ID },
        previous: {
          start_at: "2036-01-05T02:00:00+00:00",
          end_at: "2036-01-05T03:00:00+00:00",
          staff_id: STAFF_ID,
          assistant_staff_id: null,
        },
        next: {
          start_at: "2036-01-05T02:10:00+00:00",
          end_at: "2036-01-05T03:10:00+00:00",
          staff_id: STAFF_ID,
          assistant_staff_id: null,
        },
        time_changed: true,
        staff_changed: false,
      },
      error: null,
    });
    await staffMoveBooking({
      bookingId: BOOKING_ID,
      targetStartAt: "2036-01-05T10:10:00+08:00",
      expectedStartAt: "2036-01-05T02:00:00+00:00",
    });
    expect(m.dispatchLine).not.toHaveBeenCalled();
    expect(m.dispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, eventType: "booking_updated" }),
    );
  });

  it("對照:建單、取消、完成照舊會發 LINE(使用者原話只停「改單」)", async () => {
    m.rpc.mockResolvedValue({ data: { id: BOOKING_ID, merchant_id: MERCHANT_ID }, error: null });
    await staffCreateBooking({ staffId: STAFF_ID, ...BASE });
    await staffCancelBooking(BOOKING_ID);
    await staffCompleteBooking(BOOKING_ID);
    expect(m.dispatchLine.mock.calls.map((c) => (c[0] as { eventType: string }).eventType)).toEqual(
      ["booking_created", "booking_cancelled", "booking_completed"],
    );
  });
});
