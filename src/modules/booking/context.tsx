// 模組 5:行事曆與預約核心引擎 — 第五節「對外介面」的實作
// 其他模組要查詢商家營業時間/服務人員可預約時段/當日行事曆/預約清單/料錢成本品項清單,或要
// 建立/確認/編輯/取消/完成預約,一律 import 這個檔案匯出的 hooks/函式,不要自己 import supabase
// client 直接查 merchant_business_hours/staff_availability_windows/bookings/material_cost_items
// 這幾張表(規格書第五節、建單功能擴充第六節)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  cancelBooking as apiCancelBooking,
  completeBooking as apiCompleteBooking,
  confirmBooking as apiConfirmBooking,
  createBooking as apiCreateBooking,
  updateBooking as apiUpdateBooking,
  fetchMerchantBookings,
  fetchMerchantBusinessHours,
  fetchMerchantDaySchedule,
  fetchMerchantMaterialCostItems,
  fetchStaffAvailabilityWindows,
  getBooking,
  type CreateBookingInput,
  type MerchantBookingsFilters,
  type UpdateBookingInput,
} from "./api";
import type {
  Booking,
  BookingDetail,
  MaterialCostItem,
  MerchantBusinessHours,
  MerchantDaySchedule,
  StaffAvailabilityWindow,
} from "./types";

/** 5.1 對外介面:回傳某商家目前設定的整體營業時間清單,唯讀。 */
export function useMerchantBusinessHours(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantBusinessHours[]> {
  return useQuery({
    queryKey: ["booking-module", "business-hours", merchantId],
    queryFn: () => fetchMerchantBusinessHours(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** 5.2 對外介面:回傳某服務人員目前設定的可預約時段清單,唯讀。 */
export function useStaffAvailabilityWindows(
  staffId: string | null | undefined,
): UseQueryResult<StaffAvailabilityWindow[]> {
  return useQuery({
    queryKey: ["booking-module", "staff-availability-windows", staffId],
    queryFn: () => fetchStaffAvailabilityWindows(staffId as string),
    enabled: Boolean(staffId),
  });
}

/** 5.3 對外介面:某商家某天的行事曆總覽(邊界交集 + 本店預約 + 跨店占用概況)。
 * 供本模組 4.3 行事曆頁面使用,也保留給模組 7(排班參考人力配置)直接複用。 */
export function useMerchantDaySchedule(
  merchantId: string | null | undefined,
  date: string | null | undefined,
): UseQueryResult<MerchantDaySchedule> {
  return useQuery({
    queryKey: ["booking-module", "day-schedule", merchantId, date],
    queryFn: () => fetchMerchantDaySchedule(merchantId as string, date as string),
    enabled: Boolean(merchantId) && Boolean(date),
  });
}

/** 5.4 對外介面:某商家的預約/訂單清單(可用時間範圍/狀態/服務人員篩選),唯讀。
 * 這是模組 6 訂單列表/篩選 UI 的主要資料來源,建議在此基礎上擴充欄位/篩選條件,不另開查詢。 */
export function useMerchantBookings(
  merchantId: string | null | undefined,
  filters: MerchantBookingsFilters = {},
): UseQueryResult<Booking[]> {
  return useQuery({
    queryKey: ["booking-module", "bookings-list", merchantId, filters],
    queryFn: () => fetchMerchantBookings(merchantId as string, filters),
    enabled: Boolean(merchantId),
  });
}

/** 5.4/建單功能擴充 4.3 對外介面:依 id 查單筆預約詳情(含服務項目/助手/料錢成本清單)。 */
export { getBooking };
export type { BookingDetail };

/** 建單功能擴充 6.1 對外介面:回傳某商家目前上架中的料錢成本品項清單,唯讀。
 * 供本模組建單/編輯表單使用,也保留給未來模組 6(訂單管理顯示成本明細)直接複用。 */
export function useMerchantMaterialCostItems(
  merchantId: string | null | undefined,
): UseQueryResult<MaterialCostItem[]> {
  return useQuery({
    queryKey: ["booking-module", "material-cost-items", merchantId],
    queryFn: () => fetchMerchantMaterialCostItems(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** 5.5 對外介面,建單功能擴充 6.2 擴充:建立/確認/編輯/取消/完成預約,包一層呼叫
 * 4.1/4.8/4.9/cancel_booking/complete_booking,供未來任何需要操作預約的模組(模組 6、模組 13)
 * 呼叫,不需要重新實作規則 2.1~2.6、2.9、3.5 的驗證與狀態機邏輯。 */
export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  return apiCreateBooking(input);
}

/** 建單功能擴充 6.2 對外介面(新增):把 pending_confirmation 轉成 accepted。 */
export async function confirmBooking(bookingId: string): Promise<Booking> {
  return apiConfirmBooking(bookingId);
}

/** 建單功能擴充 6.2 對外介面(新增):編輯已建立的預約。 */
export async function updateBooking(input: UpdateBookingInput): Promise<Booking> {
  return apiUpdateBooking(input);
}

export async function cancelBooking(bookingId: string, reason?: string | null): Promise<Booking> {
  return apiCancelBooking(bookingId, reason);
}

export async function completeBooking(bookingId: string): Promise<Booking> {
  return apiCompleteBooking(bookingId);
}
