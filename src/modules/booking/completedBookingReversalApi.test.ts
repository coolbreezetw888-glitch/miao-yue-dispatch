// #844 §4.5 / §3.7(Q2 定案 C):還原 / 取消已完成訂單的 api 包裝。
// 鎖住三件事:RPC 名稱與參數照 migration、還原一律不通知、取消只有 notify === true 才通知(預設不發)。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, lineMock, pushMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  lineMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args), from: vi.fn() },
}));
vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: (...args: unknown[]) => lineMock(...args),
}));
vi.mock("@/modules/push-notifications/api", () => ({
  dispatchPushNotification: (...args: unknown[]) => pushMock(...args),
}));

import {
  cancelCompletedBooking,
  fetchCompletedBookingReversalPreview,
  revertCompletedBooking,
} from "./api";

const RESULT = {
  booking: { id: "b-1", merchant_id: "m-1", status: "cancelled" },
  action: "cancel_completed",
  points: { points_shortfall: 0, referral_shortfall: 0, shortfall_hint: null },
};

beforeEach(() => {
  rpcMock.mockReset().mockResolvedValue({ data: RESULT, error: null });
  lineMock.mockReset();
  pushMock.mockReset();
});

describe("#844 api", () => {
  it("預覽:get_completed_booking_reversal_preview(p_booking_id)", async () => {
    await fetchCompletedBookingReversalPreview("b-1");
    expect(rpcMock).toHaveBeenCalledWith("get_completed_booking_reversal_preview", {
      p_booking_id: "b-1",
    });
  });

  it("還原:revert_completed_booking(p_booking_id, p_reason),一律不發 LINE / 推播", async () => {
    await revertCompletedBooking("b-1", "誤按");
    expect(rpcMock).toHaveBeenCalledWith("revert_completed_booking", {
      p_booking_id: "b-1",
      p_reason: "誤按",
    });
    expect(lineMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("取消 notify:false(預設):p_notify_requested=false,不發任何通知", async () => {
    await cancelCompletedBooking("b-1", "作廢", { notify: false });
    expect(rpcMock).toHaveBeenCalledWith("cancel_completed_booking", {
      p_booking_id: "b-1",
      p_reason: "作廢",
      p_notify_requested: false,
    });
    expect(lineMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("取消 notify:true:p_notify_requested=true,並發 booking_cancelled 的 LINE + 推播", async () => {
    await cancelCompletedBooking("b-1", "作廢", { notify: true });
    expect(rpcMock.mock.calls[0]?.[1]).toMatchObject({ p_notify_requested: true });
    expect(lineMock).toHaveBeenCalledWith({
      merchantId: "m-1",
      bookingId: "b-1",
      eventType: "booking_cancelled",
    });
    expect(pushMock).toHaveBeenCalledWith({
      merchantId: "m-1",
      bookingId: "b-1",
      eventType: "booking_cancelled",
    });
  });

  it("RPC 失敗:往上丟(不發通知)", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "這筆訂單的狀態已經改變,請重新整理後再試" },
    });
    await expect(cancelCompletedBooking("b-1", "作廢", { notify: true })).rejects.toMatchObject({
      message: "這筆訂單的狀態已經改變,請重新整理後再試",
    });
    expect(lineMock).not.toHaveBeenCalled();
  });
});
