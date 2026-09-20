// 模組 11(LINE 通知)§3.11/§7:驗證 createStaffLeave(src/modules/scheduling/api.ts)在
// RPC 呼叫成功之後,正確疊加一行呼叫 dispatchLineNotification(merchant_id 由呼叫端傳入,
// staff_leave_record_id 用回傳結果的 id,event_type 固定 staff_leave_created)。

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

async function importSchedulingApi() {
  return import("./api");
}

const FAKE_LEAVE_RECORD = {
  id: "leave-1",
  staff_id: "staff-1",
  status: "active",
};

describe("createStaffLeave(§3.11 疊加 dispatchLineNotification)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    dispatchLineNotificationMock.mockReset();
  });

  it("RPC 成功後,正確呼叫 dispatchLineNotification(merchant_id/staff_leave_record_id/event_type)", async () => {
    rpcMock.mockResolvedValue({ data: FAKE_LEAVE_RECORD, error: null });
    const { createStaffLeave } = await importSchedulingApi();

    const result = await createStaffLeave({
      staffId: "staff-1",
      leaveTypeId: "leave-type-1",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      merchantId: "merchant-1",
    });

    expect(result).toEqual(FAKE_LEAVE_RECORD);
    expect(dispatchLineNotificationMock).toHaveBeenCalledTimes(1);
    expect(dispatchLineNotificationMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      staffLeaveRecordId: "leave-1",
      eventType: "staff_leave_created",
    });
  });

  it("RPC 本身失敗時,完全不會呼叫 dispatchLineNotification", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "登記失敗" } });
    const { createStaffLeave } = await importSchedulingApi();

    await expect(
      createStaffLeave({
        staffId: "staff-1",
        leaveTypeId: "leave-type-1",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        merchantId: "merchant-1",
      }),
    ).rejects.toBeTruthy();

    expect(dispatchLineNotificationMock).not.toHaveBeenCalled();
  });
});
