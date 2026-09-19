// 模組 7:排班與休假管理 — 資料存取層
// 這裡是唯一直接呼叫 supabase.from('merchant_leave_types' / 'staff_leave_records') 或
// supabase.rpc('create_staff_leave' / 'cancel_staff_leave' / 'preview_staff_leave_conflicts' /
// 'get_staff_schedule_overview') 的地方。其他模組不應該直接操作這幾張表(見規格書第五節
// 「對外介面」),一律透過 context.tsx 匯出的 hooks。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3/4/5/9 已經確立的踩坑):`error` 不是真正的 Error 實例,
// 一律用 `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type {
  MerchantLeaveType,
  StaffLeaveConflictBooking,
  StaffLeaveRecord,
  StaffScheduleOverview,
} from "./types";

// =========================================================================
// §3.2:merchant_leave_types 讀寫。比照 payment_methods v2 的既有做法,不包 RPC,直接開放 RLS
// INSERT/UPDATE(private.can_manage_team_leave 為真才能寫)。
// =========================================================================

/** 回傳某商家目前 status='active' 的假別清單,供請假登記表單下拉選單使用(§5.2)。 */
export async function fetchMerchantLeaveTypes(merchantId: string): Promise<MerchantLeaveType[]> {
  const { data, error } = await supabase
    .from("merchant_leave_types")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MerchantLeaveType[];
}

/** 回傳某商家所有假別(含已下架,假別設定頁畫面自行依 status 篩選/標示,§4.2)。 */
export async function fetchMerchantLeaveTypesAll(merchantId: string): Promise<MerchantLeaveType[]> {
  const { data, error } = await supabase
    .from("merchant_leave_types")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MerchantLeaveType[];
}

export interface UpsertLeaveTypeInput {
  name: string;
  description?: string | null;
}

export async function addLeaveType(
  merchantId: string,
  input: UpsertLeaveTypeInput,
): Promise<MerchantLeaveType> {
  const { data, error } = await supabase
    .from("merchant_leave_types")
    .insert({
      merchant_id: merchantId,
      name: input.name.trim(),
      description: input.description?.trim() ? input.description.trim() : null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as MerchantLeaveType;
}

export async function updateLeaveType(
  id: string,
  input: Partial<UpsertLeaveTypeInput>,
): Promise<void> {
  const payload: TablesUpdate<"merchant_leave_types"> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? { description: input.description?.trim() ? input.description.trim() : null }
      : {}),
  };
  const { error } = await supabase.from("merchant_leave_types").update(payload).eq("id", id);
  if (error) throw error;
}

/** 軟刪除(下架),不算危險操作,比照 payment_methods/material_cost_items 既有慣例(規則 2.10)。 */
export async function removeLeaveType(id: string): Promise<void> {
  const { error } = await supabase
    .from("merchant_leave_types")
    .update({ status: "removed" })
    .eq("id", id);
  if (error) throw error;
}

export async function reactivateLeaveType(id: string): Promise<void> {
  const { error } = await supabase
    .from("merchant_leave_types")
    .update({ status: "active" })
    .eq("id", id);
  if (error) throw error;
}

// =========================================================================
// §3.3/3.4/3.5:請假紀錄的建立/預覽衝突/取消,一律透過 SECURITY DEFINER 函式呼叫
// (staff_leave_records 沒有開放 RLS 直寫,見規格書 3.10)。
// =========================================================================

/** 回傳某服務人員(依篩選條件)的請假紀錄清單,唯讀,供 4.3 請假紀錄管理頁使用。 */
export interface StaffLeaveRecordFilters {
  staffId?: string | null;
  startDateFrom?: string | null;
  startDateTo?: string | null;
}

export async function fetchStaffLeaveRecords(
  filters: StaffLeaveRecordFilters = {},
): Promise<StaffLeaveRecord[]> {
  let query = supabase.from("staff_leave_records").select("*");
  if (filters.staffId) {
    query = query.eq("staff_id", filters.staffId);
  }
  if (filters.startDateFrom) {
    query = query.gte("end_date", filters.startDateFrom);
  }
  if (filters.startDateTo) {
    query = query.lte("start_date", filters.startDateTo);
  }
  const { data, error } = await query.order("start_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StaffLeaveRecord[];
}

/** §3.4:送出建立請假紀錄前,先查這段期間該服務人員(含以助手身份)既有的預約衝突清單。 */
export async function previewStaffLeaveConflicts(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffLeaveConflictBooking[]> {
  const { data, error } = await supabase.rpc("preview_staff_leave_conflicts", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    bookingId: row.booking_id,
    startAt: row.start_at,
    endAt: row.end_at,
    customerName: row.customer_name,
    serviceItemNames: row.service_item_names ?? [],
  }));
}

export interface CreateStaffLeaveInput {
  staffId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  notes?: string | null;
  confirmDespiteConflicts?: boolean;
}

/** §3.3:建立一筆請假紀錄(規則 2.2/2.5/2.6 逐項檢查皆在後端函式完成)。 */
export async function createStaffLeave(input: CreateStaffLeaveInput): Promise<StaffLeaveRecord> {
  const { data, error } = await supabase.rpc("create_staff_leave", {
    p_staff_id: input.staffId,
    p_leave_type_id: input.leaveTypeId,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    ...(input.notes ? { p_notes: input.notes } : {}),
    p_confirm_despite_conflicts: input.confirmDespiteConflicts ?? false,
  });
  if (error) throw error;
  return data as StaffLeaveRecord;
}

/** §3.5:取消一筆請假紀錄(軟刪除,規則 2.9/2.10)。 */
export async function cancelStaffLeave(leaveId: string): Promise<StaffLeaveRecord> {
  const { data, error } = await supabase.rpc("cancel_staff_leave", { p_leave_id: leaveId });
  if (error) throw error;
  return data as StaffLeaveRecord;
}

// =========================================================================
// §3.8:排班一覽彙整查詢,唯讀。
// =========================================================================
export async function fetchStaffScheduleOverview(
  merchantId: string,
  startDate: string,
  endDate: string,
): Promise<StaffScheduleOverview> {
  const { data, error } = await supabase.rpc("get_staff_schedule_overview", {
    p_merchant_id: merchantId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as StaffScheduleOverview;
}
