// SPECS-INDEX #976 第 3 批(2026-10-06,表 C-3):報表匯出中心的資料存取層。
//
// 改前:匯出中心直接讀 bookings / members / staff_leave_records / merchant_leave_types / merchant_staff
// (表層 RLS),後端完全沒看 report_export ——
//   ・只有 report_export 的客服:進得去頁面,但四份報表全部是空檔或被跳過;
//   ・後端也沒有「這是匯出」的概念,畫面守衛是唯一一道檢查。
// 改後:訂單 / 會員 / 請假三份報表與服務人員下拉,改走只回傳 CSV 欄位的 SECURITY DEFINER 函式,
// 權限 = private.can_export_reports(管理員或 report_export),跟畫面守衛 RequireReportExportAccess 一致。
// 抽成報表仍走 get_staff_commission_summary(跟服務人員報表頁共用;後端改成 staff_report 或 report_export 都放行)。
//
// 回傳是 jsonb(單一值),不受 PostgREST db.max_rows=1000 截斷 ⇒ 不再需要 unpaged 分頁迴圈。
// 篩選語意與排序跟改前一模一樣(見各 migration 函式的註解),CSV 欄位與內容不變。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export interface ReportExportStaffOption {
  id: string;
  name: string;
}

export interface OrdersReportRow {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  start_at: string;
  status: string;
  final_amount_snapshot: number | null;
  source: string | null;
}

export interface MembersReportRow {
  name: string;
  phone: string | null;
  referral_code: string;
  points_balance: number;
  status: string;
  identity_verified_at: string | null;
}

export interface LeaveReportRow {
  staff_id: string;
  /** 這間商家「在職」服務人員的姓名;已移除的服務人員是 null(改前前端用在職名單對照,對不到就顯示 id)。 */
  staff_name: string | null;
  leave_type_id: string;
  leave_type_name: string | null;
  start_date: string;
  end_date: string;
  status: string;
  notes: string | null;
}

/** 抽成 / 請假分頁的服務人員下拉選項(在職、依順位排序 = display_order → 建立時間;跟改前 useMerchantStaffList 同一個範圍)。 */
export async function fetchReportExportStaff(
  merchantId: string,
): Promise<ReportExportStaffOption[]> {
  const { data, error } = await supabase.rpc("list_report_export_staff", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as unknown as ReportExportStaffOption[];
}

export function useReportExportStaff(
  merchantId: string | null | undefined,
): UseQueryResult<ReportExportStaffOption[]> {
  return useQuery({
    queryKey: ["data-tools-module", "report-export-staff", merchantId],
    queryFn: () => fetchReportExportStaff(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export interface OrdersReportFilters {
  /** 跟改前一樣傳「YYYY-MM-DDTHH:MI:SS」字串(含此時間之後)。 */
  startAt?: string;
  /** 跟改前一樣傳「YYYY-MM-DDTHH:MI:SS」字串(不含此時間之後)。 */
  endAt?: string;
  /** 單一狀態;不帶 = 全部狀態。 */
  status?: string;
}

export async function fetchOrdersReport(
  merchantId: string,
  filters: OrdersReportFilters = {},
): Promise<OrdersReportRow[]> {
  const { data, error } = await supabase.rpc("export_orders_report", {
    p_merchant_id: merchantId,
    ...(filters.startAt ? { p_start_at: filters.startAt } : {}),
    ...(filters.endAt ? { p_end_at: filters.endAt } : {}),
    ...(filters.status ? { p_status: filters.status } : {}),
  });
  if (error) throw error;
  return (data ?? []) as unknown as OrdersReportRow[];
}

export async function fetchMembersReport(merchantId: string): Promise<MembersReportRow[]> {
  const { data, error } = await supabase.rpc("export_members_report", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as unknown as MembersReportRow[];
}

export interface LeaveReportFilters {
  staffId?: string | null;
  startDateFrom?: string | null;
  startDateTo?: string | null;
}

export async function fetchLeaveReport(
  merchantId: string,
  filters: LeaveReportFilters = {},
): Promise<LeaveReportRow[]> {
  const { data, error } = await supabase.rpc("export_leave_report", {
    p_merchant_id: merchantId,
    ...(filters.staffId ? { p_staff_id: filters.staffId } : {}),
    ...(filters.startDateFrom ? { p_start_date_from: filters.startDateFrom } : {}),
    ...(filters.startDateTo ? { p_start_date_to: filters.startDateTo } : {}),
  });
  if (error) throw error;
  return (data ?? []) as unknown as LeaveReportRow[];
}
