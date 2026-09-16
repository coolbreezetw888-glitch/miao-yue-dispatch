// 模組 5:行事曆與預約核心引擎 — 資料存取層
// 這裡是唯一直接呼叫 supabase.from('merchant_business_hours' / 'staff_availability_windows' /
// 'bookings') 或 supabase.rpc('create_booking' / 'cancel_booking' / 'complete_booking' /
// 'get_merchant_day_schedule') 的地方。其他模組不應該直接操作這幾張表(見規格書第五節
// 「對外介面」),一律透過 context.tsx 匯出的 hooks。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3/4 已經確立的踩坑):`error` 不是真正的 Error 實例,
// 一律用 `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type {
  Booking,
  MerchantBusinessHours,
  MerchantDaySchedule,
  StaffAvailabilityWindow,
} from "./types";

// =========================================================================
// 3.2:商家整體營業時間讀寫(規則 2.1)。RLS 要求 private.can_manage_business_hours。
// =========================================================================

/** 回傳某商家目前設定的營業時間列(可能不足七天,查無的那幾天前端視為公休/不可預約,見規格書 1.1)。 */
export async function fetchMerchantBusinessHours(
  merchantId: string,
): Promise<MerchantBusinessHours[]> {
  const { data, error } = await supabase
    .from("merchant_business_hours")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("day_of_week", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MerchantBusinessHours[];
}

export interface UpsertBusinessHoursInput {
  dayOfWeek: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
}

/** 4.1:一次寫入一天的營業時間設定,查無既有列則新增,已有則更新(upsert on unique(merchant_id, day_of_week))。 */
export async function upsertMerchantBusinessHours(
  merchantId: string,
  input: UpsertBusinessHoursInput,
): Promise<void> {
  const { error } = await supabase.from("merchant_business_hours").upsert(
    {
      merchant_id: merchantId,
      day_of_week: input.dayOfWeek,
      is_closed: input.isClosed,
      open_time: input.isClosed ? null : input.openTime,
      close_time: input.isClosed ? null : input.closeTime,
    },
    { onConflict: "merchant_id,day_of_week" },
  );
  if (error) throw error;
}

// =========================================================================
// 3.2:服務人員可預約時段讀寫(規則 2.2/2.5)。RLS 要求 private.can_manage_business_hours。
// =========================================================================

/** 回傳某服務人員目前設定的可預約時段(可能同一天有多組)。 */
export async function fetchStaffAvailabilityWindows(
  staffId: string,
): Promise<StaffAvailabilityWindow[]> {
  const { data, error } = await supabase
    .from("staff_availability_windows")
    .select("*")
    .eq("staff_id", staffId)
    .order("day_of_week", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data ?? []) as StaffAvailabilityWindow[];
}

export interface AddStaffAvailabilityWindowInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export async function addStaffAvailabilityWindow(
  staffId: string,
  input: AddStaffAvailabilityWindowInput,
): Promise<StaffAvailabilityWindow> {
  const { data, error } = await supabase
    .from("staff_availability_windows")
    .insert({
      staff_id: staffId,
      day_of_week: input.dayOfWeek,
      start_time: input.startTime,
      end_time: input.endTime,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as StaffAvailabilityWindow;
}

export async function removeStaffAvailabilityWindow(windowId: string): Promise<void> {
  const { error } = await supabase.from("staff_availability_windows").delete().eq("id", windowId);
  if (error) throw error;
}

// =========================================================================
// 1.4/規則 2.4:嚴格工時衝突檢查開關,沿用模組 1 既有的 getFeatureFlag/setFeatureFlag
// 對外介面(src/modules/merchant/api.ts),這裡不重新實作。
// =========================================================================
export const STRICT_CONFLICT_CHECK_FEATURE_KEY = "strict_conflict_check";

// =========================================================================
// 3.3/3.4/3.5:建立/取消/標記完成預約。
// =========================================================================

export interface CreateBookingInput {
  merchantId: string;
  staffId: string;
  serviceItemId: string;
  startAt: string; // ISO 字串(含時區),對應 timestamptz
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  notes?: string | null;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const { data, error } = await supabase.rpc("create_booking", {
    p_merchant_id: input.merchantId,
    p_staff_id: input.staffId,
    p_service_item_id: input.serviceItemId,
    p_start_at: input.startAt,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    // exactOptionalPropertyTypes:true 下,可選欄位不能明確賦值 undefined,要嘛不放這個 key。
    ...(input.customerEmail ? { p_customer_email: input.customerEmail } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
  });
  if (error) throw error;
  return data as Booking;
}

export async function cancelBooking(bookingId: string, reason?: string | null): Promise<Booking> {
  const { data, error } = await supabase.rpc("cancel_booking", {
    p_booking_id: bookingId,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw error;
  return data as Booking;
}

export async function completeBooking(bookingId: string): Promise<Booking> {
  const { data, error } = await supabase.rpc("complete_booking", {
    p_booking_id: bookingId,
  });
  if (error) throw error;
  return data as Booking;
}

// =========================================================================
// 3.6/5.3:當日行事曆查詢(供 4.3 行事曆頁面使用,也保留給模組 7 複用)。
// =========================================================================
export async function fetchMerchantDaySchedule(
  merchantId: string,
  date: string, // 'YYYY-MM-DD'
): Promise<MerchantDaySchedule> {
  const { data, error } = await supabase.rpc("get_merchant_day_schedule", {
    p_merchant_id: merchantId,
    p_date: date,
  });
  if (error) throw error;
  return data as unknown as MerchantDaySchedule;
}

// =========================================================================
// 5.4:預約/訂單清單查詢(唯讀),供模組 6 訂單列表/篩選 UI 使用。
// =========================================================================
export interface MerchantBookingsFilters {
  startAt?: string; // ISO,含此時間之後(>=)
  endAt?: string; // ISO,不含此時間之後(<)
  status?: string[];
  staffId?: string;
}

export async function fetchMerchantBookings(
  merchantId: string,
  filters: MerchantBookingsFilters = {},
): Promise<Booking[]> {
  let query = supabase
    .from("bookings")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("start_at", { ascending: true });

  if (filters.startAt) query = query.gte("start_at", filters.startAt);
  if (filters.endAt) query = query.lt("start_at", filters.endAt);
  if (filters.status && filters.status.length > 0) query = query.in("status", filters.status);
  if (filters.staffId) query = query.eq("staff_id", filters.staffId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Booking[];
}

export async function getBooking(id: string): Promise<Booking | null> {
  const { data, error } = await supabase.from("bookings").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Booking | null) ?? null;
}

// 型別工具,供未來需要局部更新 bookings 欄位的模組(例如模組 6)參考既有慣例,這次本模組不使用。
export type BookingUpdate = TablesUpdate<"bookings">;
