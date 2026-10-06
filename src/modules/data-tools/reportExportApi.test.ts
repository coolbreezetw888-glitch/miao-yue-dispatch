// SPECS-INDEX #976 第 3 批(2026-10-06,表 C-3):報表匯出中心改走匯出專用 RPC。
// 釘住「呼叫哪一支、帶哪些參數」:篩選條件沒帶就不送(交給函式的 default null = 不篩),
// 跟改前 fetchMerchantBookings / fetchStaffLeaveRecords「有值才加條件」的語意一致。
import { afterEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import {
  fetchLeaveReport,
  fetchMembersReport,
  fetchOrdersReport,
  fetchReportExportStaff,
} from "./reportExportApi";

afterEach(() => rpcMock.mockReset());

describe("reportExportApi(#976 C-3)", () => {
  it("訂單:日期與狀態有值才送;沒有篩選時只送商家", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await fetchOrdersReport("m1", {
      startAt: "2026-10-01T00:00:00",
      endAt: "2026-10-31T23:59:59",
      status: "completed",
    });
    expect(rpcMock).toHaveBeenLastCalledWith("export_orders_report", {
      p_merchant_id: "m1",
      p_start_at: "2026-10-01T00:00:00",
      p_end_at: "2026-10-31T23:59:59",
      p_status: "completed",
    });
    await fetchOrdersReport("m1");
    expect(rpcMock).toHaveBeenLastCalledWith("export_orders_report", { p_merchant_id: "m1" });
  });

  it("會員 / 服務人員下拉:只送商家", async () => {
    rpcMock.mockResolvedValue({ data: [{ id: "s1", name: "甲" }], error: null });
    expect(await fetchReportExportStaff("m1")).toEqual([{ id: "s1", name: "甲" }]);
    expect(rpcMock).toHaveBeenLastCalledWith("list_report_export_staff", { p_merchant_id: "m1" });
    rpcMock.mockResolvedValue({ data: null, error: null });
    expect(await fetchMembersReport("m1")).toEqual([]);
    expect(rpcMock).toHaveBeenLastCalledWith("export_members_report", { p_merchant_id: "m1" });
  });

  it("請假:「全部服務人員」(null)與空日期不送", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await fetchLeaveReport("m1", { staffId: null, startDateFrom: "", startDateTo: null });
    expect(rpcMock).toHaveBeenLastCalledWith("export_leave_report", { p_merchant_id: "m1" });
    await fetchLeaveReport("m1", {
      staffId: "s1",
      startDateFrom: "2026-10-01",
      startDateTo: "2026-10-31",
    });
    expect(rpcMock).toHaveBeenLastCalledWith("export_leave_report", {
      p_merchant_id: "m1",
      p_staff_id: "s1",
      p_start_date_from: "2026-10-01",
      p_start_date_to: "2026-10-31",
    });
  });

  it("後端擋下(42501)時把錯誤丟出去,畫面走「匯出失敗」toast", async () => {
    const err = { code: "42501", message: "沒有權限使用這間商家的報表匯出中心" };
    rpcMock.mockResolvedValue({ data: null, error: err });
    await expect(fetchOrdersReport("m1")).rejects.toBe(err);
  });
});
