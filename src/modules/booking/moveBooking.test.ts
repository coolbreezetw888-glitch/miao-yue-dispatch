// SPECS-INDEX #818(+ #823 交接)。api.ts moveBooking() 的單元測試:
//   1. RPC 參數對應(camelCase → p_*)
//   2. 成功後 fire-and-forget 送 booking_updated 推播,changeSummary 用既有 computeBookingChangeSummary
//   3. 🔴 #823:只有主服務人員真的換人(reassign_main)才帶 previousStaffId = previous.staff_id;
//      time / reassign_assistant **不帶**(助手換人時主服務人員沒變,帶了 Edge Function 會誤發
//      「已從你的行程移除」給還在單上的主服務人員)
//   4. RPC 失敗 → 直接 throw、不送推播
//
// 【故障注入紀錄(2026-09-28 實際跑過,還原後 git diff --stat 乾淨)】
//   (e) api.ts moveBooking() 拿掉 `...(mainStaffReassigned ? { previousStaffId } : {})` → 2 條紅(4 綠):
//       「#823 mode=reassign_main:帶 previousStaffId」:expected "spy" to be called with arguments: [ { merchantId: 'm1', …(4) } ]
//       「斜拖…仍帶 previousStaffId」:expected undefined to be 'staff-a'
//       (time / reassign_assistant 那兩條「不帶」的測試仍綠 —— 正好證明它們是靠 mode 分辨,不是永遠綠的假測試)

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MoveBookingResult } from "./bookingDragMove";

const { rpcMock, dispatchPushMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  dispatchPushMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock, from: () => ({}), functions: { invoke: vi.fn() } },
}));
vi.mock("@/modules/push-notifications/api", () => ({
  dispatchPushNotification: dispatchPushMock,
}));
vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
}));

import { moveBooking } from "./api";

const A = "staff-a";
const B = "staff-b";
const C = "staff-c";

function result(over: Partial<MoveBookingResult> = {}): MoveBookingResult {
  return {
    mode: "time",
    booking: { id: "t1", merchant_id: "m1" },
    previous: {
      start_at: "2036-01-05T02:00:00+00:00",
      end_at: "2036-01-05T03:00:00+00:00",
      staff_id: A,
      assistant_staff_id: B,
    },
    next: {
      start_at: "2036-01-05T04:00:00+00:00",
      end_at: "2036-01-05T05:00:00+00:00",
      staff_id: A,
      assistant_staff_id: B,
    },
    time_changed: true,
    staff_changed: false,
    ...over,
  };
}

const INPUT = {
  bookingId: "t1",
  draggedStaffId: A,
  targetStaffId: A,
  targetStartAt: "2036-01-05T12:00:00+08:00",
  expectedStartAt: "2036-01-05T02:00:00+00:00",
  expectedStaffId: A,
};

beforeEach(() => {
  rpcMock.mockReset();
  dispatchPushMock.mockReset();
});

describe("moveBooking(#818 推播 + #823 previousStaffId 交接)", () => {
  it("把六個欄位對應到 move_booking 的 p_* 參數,回傳 RPC 的 jsonb", async () => {
    rpcMock.mockResolvedValue({ data: result(), error: null });
    const r = await moveBooking(INPUT);
    expect(rpcMock).toHaveBeenCalledWith("move_booking", {
      p_booking_id: "t1",
      p_dragged_staff_id: A,
      p_target_staff_id: A,
      p_target_start_at: "2036-01-05T12:00:00+08:00",
      p_expected_start_at: "2036-01-05T02:00:00+00:00",
      p_expected_staff_id: A,
    });
    expect(r.mode).toBe("time");
  });

  it("mode=time:推播 changeSummary「預約時間改為 2036-01-05 12:00」,**不帶** previousStaffId", async () => {
    rpcMock.mockResolvedValue({ data: result(), error: null });
    await moveBooking(INPUT);
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    expect(dispatchPushMock).toHaveBeenCalledWith({
      merchantId: "m1",
      bookingId: "t1",
      eventType: "booking_updated",
      changeSummary: "預約時間改為 2036-01-05 12:00",
    });
    expect(dispatchPushMock.mock.calls[0]![0]).not.toHaveProperty("previousStaffId");
  });

  it("🔴 #823 mode=reassign_main:帶 previousStaffId = previous.staff_id,changeSummary「服務人員改為 王大明」", async () => {
    rpcMock.mockResolvedValue({
      data: result({
        mode: "reassign_main",
        time_changed: false,
        staff_changed: true,
        next: { ...result().previous, staff_id: C },
      }),
      error: null,
    });
    await moveBooking({ ...INPUT, targetStaffId: C }, { targetStaffName: "王大明" });
    expect(dispatchPushMock).toHaveBeenCalledWith({
      merchantId: "m1",
      bookingId: "t1",
      eventType: "booking_updated",
      changeSummary: "服務人員改為 王大明",
      previousStaffId: A,
    });
  });

  it("斜拖(reassign_main + time_changed):人跟時間都變 → 既有函式的通用文案;仍帶 previousStaffId", async () => {
    rpcMock.mockResolvedValue({
      data: result({
        mode: "reassign_main",
        time_changed: true,
        staff_changed: true,
        next: { ...result().next, staff_id: C },
      }),
      error: null,
    });
    await moveBooking({ ...INPUT, targetStaffId: C }, { targetStaffName: "王大明" });
    const payload = dispatchPushMock.mock.calls[0]![0] as {
      changeSummary: string;
      previousStaffId?: string;
    };
    expect(payload.changeSummary).toBe("您的預約內容已更新,請至系統查看最新內容");
    expect(payload.previousStaffId).toBe(A);
  });

  it("mode=reassign_assistant:主服務人員沒變 → **不帶** previousStaffId;文案是通用文案(不改共用函式)", async () => {
    rpcMock.mockResolvedValue({
      data: result({
        mode: "reassign_assistant",
        time_changed: false,
        staff_changed: true,
        next: { ...result().previous, assistant_staff_id: C },
      }),
      error: null,
    });
    await moveBooking(
      { ...INPUT, draggedStaffId: B, targetStaffId: C },
      { targetStaffName: "王大明" },
    );
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    const payload = dispatchPushMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload["changeSummary"]).toBe("您的預約內容已更新,請至系統查看最新內容");
    expect(payload).not.toHaveProperty("previousStaffId");
  });

  it("RPC 回錯誤 → 原樣 throw(前端用 getErrorMessage 取 message / code 判 40001),不送推播", async () => {
    const error = {
      code: "40001",
      message: "這筆預約剛剛被其他人改過，畫面已重新整理，請再拖一次",
    };
    rpcMock.mockResolvedValue({ data: null, error });
    await expect(moveBooking(INPUT)).rejects.toBe(error);
    expect(dispatchPushMock).not.toHaveBeenCalled();
  });
});
