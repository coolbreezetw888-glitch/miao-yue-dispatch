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
  fetchBookingCardExtras,
  setStaffDayOverride as apiSetStaffDayOverride,
  updateBooking as apiUpdateBooking,
  updateBookingPaymentMethod as apiUpdateBookingPaymentMethod,
  fetchBookingAmountSummary,
  fetchMerchantBookings,
  fetchMerchantBookingStatusColors,
  fetchMerchantBusinessHours,
  fetchMerchantCalendarStateStyles,
  fetchMerchantDaySchedule,
  fetchMerchantMaterialCostItems,
  fetchMerchantPaymentMethods,
  fetchMerchantTaxSettings,
  fetchStaffAvailabilityWindows,
  getBooking,
  getBookingStatusChangeLogs as apiGetBookingStatusChangeLogs,
  getCustomerRelatedBookings as apiGetCustomerRelatedBookings,
  updateMerchantBookingStatusColors as apiUpdateMerchantBookingStatusColors,
  updateMerchantCalendarStateStyles as apiUpdateMerchantCalendarStateStyles,
  upsertMerchantTaxSettings as apiUpsertMerchantTaxSettings,
  type BookingAmountSummary,
  type BookingCardExtra,
  type CreateBookingInput,
  type MerchantBookingsFilters,
  type UpdateBookingInput,
  type UpsertMerchantTaxSettingsInput,
} from "./api";
import type {
  AmountAdjustmentMode,
  Booking,
  BookingDetail,
  BookingStatusChangeLog,
  BookingStatusColorMap,
  CalendarStateStyleMap,
  CustomerRelatedBooking,
  MaterialCostItem,
  MerchantBusinessHours,
  MerchantDaySchedule,
  PaymentMethod,
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

/** 模組 9(支付方式)v2 對外介面:單獨更新付款方式。 */
export async function updateBookingPaymentMethod(
  bookingId: string,
  paymentMethodId: string | null,
): Promise<Booking> {
  return apiUpdateBookingPaymentMethod(bookingId, paymentMethodId);
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

/** 模組 9(支付方式)v2 §6 對外介面:商家目前上架中(status='active')的付款方式清單,唯讀。
 * 供建單表單下拉選單(§5.2)使用。管理頁(含已下架清單/CRUD)直接 import api.ts 對應函式,
 * 不透過這裡(比照 MaterialCostsPage.tsx 直接 import fetchMerchantMaterialCostItemsAll 等函式
 * 的既有做法,這裡的 hooks 集中放的是「唯讀查詢」)。 */
export function useMerchantPaymentMethods(
  merchantId: string | null | undefined,
): UseQueryResult<PaymentMethod[]> {
  return useQuery({
    queryKey: ["booking-module", "merchant-payment-methods", merchantId],
    queryFn: () => fetchMerchantPaymentMethods(merchantId as string),
    enabled: Boolean(merchantId),
  });
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

// 使用者裁決(2026-09-24):行事曆時段選單的「清除例外(恢復預設)」入口整個拿掉,這裡原本包一層
// 的 clearStaffDayOverride 對外介面也隨之移除(唯一的呼叫端就是 CalendarPage)。資料庫函式
// clear_staff_day_override 與 api.ts 的同名 wrapper 都保留——模組 14(服務人員端)
// src/modules/staff-portal/context.tsx 仍然直接從 @/modules/booking/api 使用它。

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

/** 建單與訂單管理介面優化 §7.5 對外介面:批次取得訂單卡片需要的延伸資訊(服務項目名稱清單、
 * 建單客服姓名),供訂單管理頁卡片列表使用,避免對列表裡每一筆訂單各自呼叫一次 getBooking
 * (N+1 查詢)。queryKey 用訂單 id 清單(排序後)當快取鍵,清單內容不變時不會重複查詢。 */
export function useBookingCardExtras(
  merchantId: string | null | undefined,
  bookings: Pick<Booking, "id" | "created_by_user_id">[],
): UseQueryResult<Map<string, BookingCardExtra>> {
  const bookingIdsKey = bookings
    .map((b) => b.id)
    .sort()
    .join(",");
  return useQuery({
    queryKey: ["booking-module", "booking-card-extras", merchantId, bookingIdsKey],
    queryFn: () => fetchBookingCardExtras(merchantId as string, bookings),
    enabled: Boolean(merchantId) && bookings.length > 0,
  });
}

/** 模組 6 §9.1(SPECS-INDEX #597)對外介面:查詢某筆訂單的操作記錄,供預約詳情彈窗
 * 「操作記錄」按鈕使用。 */
export function useBookingStatusChangeLogs(
  bookingId: string | null | undefined,
  enabled: boolean,
): UseQueryResult<BookingStatusChangeLog[]> {
  return useQuery({
    queryKey: ["booking-module", "booking-status-change-logs", bookingId],
    queryFn: () => apiGetBookingStatusChangeLogs(bookingId as string),
    enabled: Boolean(bookingId) && enabled,
  });
}

/** 建單與訂單管理介面優化 §十 10.1-10.6(SPECS-INDEX #620/#621)對外介面:商家目前設定的
 * 4 種訂單狀態代表色,查無資料時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS(見 api.ts)。
 * 供 CalendarPage.tsx(色塊)/OrdersPage.tsx(色條+設定畫面)使用。 */
export function useMerchantBookingStatusColors(
  merchantId: string | null | undefined,
): UseQueryResult<BookingStatusColorMap> {
  return useQuery({
    queryKey: ["booking-module", "merchant-booking-status-colors", merchantId],
    queryFn: () => fetchMerchantBookingStatusColors(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export async function updateMerchantBookingStatusColors(
  merchantId: string,
  colors: BookingStatusColorMap,
): Promise<void> {
  return apiUpdateMerchantBookingStatusColors(merchantId, colors);
}

/** SPECS-INDEX #644 對外介面:商家目前設定的 3 種行事曆排程狀態代表色(全天休假/時段排休/
 * 跨店佔用),查無資料時 fallback 成 DEFAULT_CALENDAR_STATE_STYLES(見 api.ts)。供
 * CalendarPage.tsx、商家設定頁(MerchantSettingsPage.tsx)使用。服務人員自助端
 * (MyCalendarTimelineView.tsx)不呼叫這支——一般服務人員不符合 can_manage_bookings,讀不到
 * merchant_calendar_state_styles 這張表,改用 staff-portal 模組自己的
 * useMyCalendarStateStyles(呼叫 SECURITY DEFINER 的 get_my_calendar_state_styles)。 */
export function useMerchantCalendarStateStyles(
  merchantId: string | null | undefined,
): UseQueryResult<CalendarStateStyleMap> {
  return useQuery({
    queryKey: ["booking-module", "merchant-calendar-state-styles", merchantId],
    queryFn: () => fetchMerchantCalendarStateStyles(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export async function updateMerchantCalendarStateStyles(
  merchantId: string,
  styles: CalendarStateStyleMap,
): Promise<void> {
  return apiUpdateMerchantCalendarStateStyles(merchantId, styles);
}
