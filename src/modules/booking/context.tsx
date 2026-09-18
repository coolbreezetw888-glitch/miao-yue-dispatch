// 模組 5:行事曆與預約核心引擎 — 第五節「對外介面」的實作
// 其他模組要查詢商家營業時間/服務人員可預約時段/當日行事曆/預約清單/料錢成本品項清單,或要
// 建立/確認/編輯/取消/完成預約,一律 import 這個檔案匯出的 hooks/函式,不要自己 import supabase
// client 直接查 merchant_business_hours/staff_availability_windows/bookings/material_cost_items
// 這幾張表(規格書第五節、建單功能擴充第六節)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  cancelBooking as apiCancelBooking,
  clearStaffDayOverride as apiClearStaffDayOverride,
  completeBooking as apiCompleteBooking,
  confirmBooking as apiConfirmBooking,
  createBooking as apiCreateBooking,
  setStaffDayOverride as apiSetStaffDayOverride,
  updateBooking as apiUpdateBooking,
  updateBookingPaymentMethod as apiUpdateBookingPaymentMethod,
  fetchBookingAmountSummary,
  fetchMerchantBookings,
  fetchMerchantBusinessHours,
  fetchMerchantDaySchedule,
  fetchMerchantMaterialCostItems,
  fetchMerchantTaxSettings,
  fetchStaffAvailabilityWindows,
  getBooking,
  getCustomerRelatedBookings as apiGetCustomerRelatedBookings,
  upsertMerchantTaxSettings as apiUpsertMerchantTaxSettings,
  type BookingAmountSummary,
  type CreateBookingInput,
  type MerchantBookingsFilters,
  type UpdateBookingInput,
  type UpsertMerchantTaxSettingsInput,
} from "./api";
import type {
  AmountAdjustmentMode,
  Booking,
  BookingDetail,
  CustomerRelatedBooking,
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

/** 模組 6(訂單管理)§6.2 對外介面:單獨更新付款方式。 */
export async function updateBookingPaymentMethod(
  bookingId: string,
  paymentMethod: string | null,
): Promise<Booking> {
  return apiUpdateBookingPaymentMethod(bookingId, paymentMethod);
}

/** 模組 6 §2.1/§4.7 對外介面:商家整體稅金設定,查無資料時 fallback 成預設值
 * (DEFAULT_MERCHANT_TAX_SETTINGS,見 types.ts)。 */
export function useMerchantTaxSettings(
  merchantId: string | null | undefined,
): UseQueryResult<{ taxMode: AmountAdjustmentMode; taxValue: number }> {
  return useQuery({
    queryKey: ["booking-module", "merchant-tax-settings", merchantId],
    queryFn: () => fetchMerchantTaxSettings(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export async function upsertMerchantTaxSettings(
  merchantId: string,
  input: UpsertMerchantTaxSettingsInput,
): Promise<void> {
  return apiUpsertMerchantTaxSettings(merchantId, input);
}

/** 模組 6 §3.3/§6.3 對外介面:相關訂單查詢,供預約詳情頁「相關訂單」按鈕使用,也保留給之後
 * 其他模組(如模組 10 會員與紅利)複用。 */
export async function getCustomerRelatedBookings(
  merchantId: string,
  customerPhone: string,
  excludeBookingId?: string | null,
): Promise<CustomerRelatedBooking[]> {
  return apiGetCustomerRelatedBookings(merchantId, customerPhone, excludeBookingId);
}

/** 模組 6 §5.2/§6.4 對外介面:設定單日例外(開啟/關閉時段),供行事曆介面使用,也保留給之後
 * 模組 7(排班與休假管理)參考。回傳受影響的既有預約筆數(§5.2 第 4 點,只提示不阻擋)。 */
export async function setStaffDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
  isAvailable: boolean,
): Promise<number> {
  return apiSetStaffDayOverride(staffId, overrideDate, startTime, endTime, isAvailable);
}

/** 模組 6 §5.2/§6.4 對外介面:清除單日例外,恢復成回歸每週固定模板的狀態。 */
export async function clearStaffDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  return apiClearStaffDayOverride(staffId, overrideDate, startTime, endTime);
}

/** 模組 6 §6.1 對外介面:直接取得單筆訂單的金額 breakdown,供模組 8/12 之後複用,
 * 不用重新查三張關聯表自己加總。 */
export function useBookingAmountSummary(
  bookingId: string | null | undefined,
): UseQueryResult<BookingAmountSummary | null> {
  return useQuery({
    queryKey: ["booking-module", "booking-amount-summary", bookingId],
    queryFn: () => fetchBookingAmountSummary(bookingId as string),
    enabled: Boolean(bookingId),
  });
}
