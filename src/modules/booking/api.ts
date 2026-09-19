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
  AmountAdjustmentMode,
  Booking,
  BookingDetail,
  CustomerRelatedBooking,
  MaterialCostItem,
  MerchantBusinessHours,
  MerchantDaySchedule,
  PaymentMethod,
  StaffAvailabilityWindow,
} from "./types";
import { DEFAULT_MERCHANT_TAX_SETTINGS } from "./types";
import { bookingMatchesKeyword } from "./ordersPageLogic";

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
// 建單功能擴充 2.3/決策記錄 4:料錢成本功能開關,同一組對外介面,同一個 key 常數放這裡集中管理。
// =========================================================================
export const STRICT_CONFLICT_CHECK_FEATURE_KEY = "strict_conflict_check";
export const MATERIAL_COST_ENABLED_FEATURE_KEY = "material_cost_enabled";

// =========================================================================
// 3.3/3.4/3.5,建單功能擴充 4.1/4.8/4.9:建立/確認/編輯/取消/標記完成預約。
// =========================================================================

/** 模組 6(訂單管理)§4.1/4.2:每個已勾選服務項目要攜帶的資訊——選了幾份(quantity)、
 * 這筆訂單裡的單價(unitPrice,預設帶入 service_items.price,客服可手動修改)。
 *
 * **型別設計選擇(規格書沒有規定確切型別,由 engineer 判斷)**:改成物件陣列(對應資料庫
 * create_booking/update_booking 的 p_service_items jsonb 參數),取代原本單純的
 * serviceItemIds: string[]。沒有採用「三個平行陣列(ids/quantities/prices)」的做法,理由是
 * 平行陣列容易因為排序不一致而讓某個服務項目誤套用到另一個項目的數量/單價,是一個型別系統
 * 完全擋不下來的資料錯位風險;物件陣列每個元素自帶完整資訊,不存在這個問題。 */
export interface BookingServiceItemSelectionInput {
  serviceItemId: string;
  quantity: number;
  unitPrice: number;
}

/** 模組 6 §4.4~4.6:整筆訂單層級的金額彈性三個開關(自訂總金額/折扣/稅金)。
 * 這三組欄位在 CreateBookingInput/UpdateBookingInput 共用同一份定義,用 interface 混入。
 * 不含 §4.3 自訂工時開關(留給下一批獨立處理)。 */
export interface BookingAmountAdjustmentInput {
  customTotalAmountEnabled?: boolean;
  customTotalAmount?: number | null;
  discountEnabled?: boolean;
  discountMode?: AmountAdjustmentMode | null;
  discountValue?: number | null;
  taxEnabled?: boolean;
  taxMode?: AmountAdjustmentMode | null;
  taxValue?: number | null;
  /** 模組 9(支付方式)v2:指向商家自訂 payment_methods 清單的 id,取代 v1 的固定代碼文字。
   * null 代表尚未設定。 */
  paymentMethodId?: string | null;
  /** 模組 6 §4.3 裁決 Q3(方向一):整筆訂單層級的自訂工時開關。關閉時沿用 §2.2 逐項加總計算
   * end_at;開啟後 end_at 直接改用 customDurationMinutes 計算,會真的影響排程佔用與衝突檢查邊界
   * (含單日例外第三層)。關閉時 customDurationMinutes 應該是 null/undefined,後端也會在關閉時
   * 一律存 null,避免留著舊值造成混淆。 */
  customDurationEnabled?: boolean;
  customDurationMinutes?: number | null;
}

function buildServiceItemsJsonb(items: BookingServiceItemSelectionInput[]) {
  return items.map((item) => ({
    service_item_id: item.serviceItemId,
    quantity: item.quantity,
    unit_price: item.unitPrice,
  }));
}

/** 建單功能擴充 4.1:create_booking 破壞性簽章變更——serviceItemId 改成 serviceItems(多選,
 * 至少 1 個,模組 6 §4.1/4.2 再擴充成攜帶數量/單價的物件陣列),新增 assistantStaffIds
 * (助手清單,決策記錄 2)、materialCostItemIds(料錢成本品項,決策記錄 4)、金額彈性三開關
 * (模組 6 §4.4~4.6)。 */
export interface CreateBookingInput extends BookingAmountAdjustmentInput {
  merchantId: string;
  staffId: string;
  serviceItems: BookingServiceItemSelectionInput[];
  startAt: string; // ISO 字串(含時區),對應 timestamptz
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  notes?: string | null;
  assistantStaffIds?: string[];
  materialCostItemIds?: string[];
  /** 建單表單細節修正第二節:客戶指定的服務地點,只有 industry_type 需要地址的產業
   * (見 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS)才會用到,後端 create_booking 會依商家
   * industry_type 再驗證一次是否必填,不是只靠前端擋。 */
  customerAddress?: string | null;
  /** 預約詳情資訊擴充與建單備註分類第一節:客戶備註(客戶看得到的備註),跟既有的 notes
   * (內部備註,商家內部看、客戶看不到)分開存放。 */
  customerNotes?: string | null;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const { data, error } = await supabase.rpc("create_booking", {
    p_merchant_id: input.merchantId,
    p_staff_id: input.staffId,
    p_service_items: buildServiceItemsJsonb(input.serviceItems),
    p_start_at: input.startAt,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    // exactOptionalPropertyTypes:true 下,可選欄位不能明確賦值 undefined,要嘛不放這個 key。
    ...(input.customerEmail ? { p_customer_email: input.customerEmail } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
    p_assistant_staff_ids: input.assistantStaffIds ?? [],
    p_material_cost_item_ids: input.materialCostItemIds ?? [],
    ...(input.customerAddress ? { p_customer_address: input.customerAddress } : {}),
    ...(input.customerNotes ? { p_customer_notes: input.customerNotes } : {}),
    p_custom_total_amount_enabled: input.customTotalAmountEnabled ?? false,
    ...(input.customTotalAmount !== null && input.customTotalAmount !== undefined
      ? { p_custom_total_amount: input.customTotalAmount }
      : {}),
    p_discount_enabled: input.discountEnabled ?? false,
    ...(input.discountMode ? { p_discount_mode: input.discountMode } : {}),
    ...(input.discountValue !== null && input.discountValue !== undefined
      ? { p_discount_value: input.discountValue }
      : {}),
    p_tax_enabled: input.taxEnabled ?? false,
    ...(input.taxMode ? { p_tax_mode: input.taxMode } : {}),
    ...(input.taxValue !== null && input.taxValue !== undefined
      ? { p_tax_value: input.taxValue }
      : {}),
    ...(input.paymentMethodId ? { p_payment_method_id: input.paymentMethodId } : {}),
    p_custom_duration_enabled: input.customDurationEnabled ?? false,
    ...(input.customDurationMinutes !== null && input.customDurationMinutes !== undefined
      ? { p_custom_duration_minutes: input.customDurationMinutes }
      : {}),
  });
  if (error) throw error;
  return data as Booking;
}

/** 建單功能擴充 4.9/決策記錄 6(新增):編輯已建立的預約,欄位範圍跟 CreateBookingInput 相同,
 * 多一個 bookingId 指定要編輯哪一筆。 */
export interface UpdateBookingInput extends BookingAmountAdjustmentInput {
  bookingId: string;
  staffId: string;
  serviceItems: BookingServiceItemSelectionInput[];
  startAt: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  notes?: string | null;
  assistantStaffIds?: string[];
  materialCostItemIds?: string[];
  /** 建單表單細節修正第二節:同 CreateBookingInput.customerAddress。 */
  customerAddress?: string | null;
  /** 預約詳情資訊擴充與建單備註分類第一節:同 CreateBookingInput.customerNotes。 */
  customerNotes?: string | null;
}

export async function updateBooking(input: UpdateBookingInput): Promise<Booking> {
  const { data, error } = await supabase.rpc("update_booking", {
    p_booking_id: input.bookingId,
    p_staff_id: input.staffId,
    p_service_items: buildServiceItemsJsonb(input.serviceItems),
    p_start_at: input.startAt,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    ...(input.customerEmail ? { p_customer_email: input.customerEmail } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
    p_assistant_staff_ids: input.assistantStaffIds ?? [],
    p_material_cost_item_ids: input.materialCostItemIds ?? [],
    ...(input.customerAddress ? { p_customer_address: input.customerAddress } : {}),
    ...(input.customerNotes ? { p_customer_notes: input.customerNotes } : {}),
    p_custom_total_amount_enabled: input.customTotalAmountEnabled ?? false,
    ...(input.customTotalAmount !== null && input.customTotalAmount !== undefined
      ? { p_custom_total_amount: input.customTotalAmount }
      : {}),
    p_discount_enabled: input.discountEnabled ?? false,
    ...(input.discountMode ? { p_discount_mode: input.discountMode } : {}),
    ...(input.discountValue !== null && input.discountValue !== undefined
      ? { p_discount_value: input.discountValue }
      : {}),
    p_tax_enabled: input.taxEnabled ?? false,
    ...(input.taxMode ? { p_tax_mode: input.taxMode } : {}),
    ...(input.taxValue !== null && input.taxValue !== undefined
      ? { p_tax_value: input.taxValue }
      : {}),
    ...(input.paymentMethodId ? { p_payment_method_id: input.paymentMethodId } : {}),
    p_custom_duration_enabled: input.customDurationEnabled ?? false,
    ...(input.customDurationMinutes !== null && input.customDurationMinutes !== undefined
      ? { p_custom_duration_minutes: input.customDurationMinutes }
      : {}),
  });
  if (error) throw error;
  return data as Booking;
}

/** 模組 9(支付方式)v2:單獨更新付款方式,不需要傳服務項目/金額等其餘欄位。 */
export async function updateBookingPaymentMethod(
  bookingId: string,
  paymentMethodId: string | null,
): Promise<Booking> {
  const { data, error } = await supabase.rpc("update_booking_payment_method", {
    p_booking_id: bookingId,
    ...(paymentMethodId ? { p_payment_method_id: paymentMethodId } : {}),
  });
  if (error) throw error;
  return data as Booking;
}

/** 建單功能擴充 4.8/決策記錄 5(新增):把 pending_confirmation 轉成 accepted。 */
export async function confirmBooking(bookingId: string): Promise<Booking> {
  const { data, error } = await supabase.rpc("confirm_booking", {
    p_booking_id: bookingId,
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
// 模組 6(訂單管理)§5.2/§6.4:單日例外設定/清除,包一層呼叫 set_staff_day_override/
// clear_staff_day_override。權限歸在 business_hours(§5.4),不是 orders,RLS 由資料庫函式自己
// 把關,這裡不做前端權限判斷(前端只依 useAgentPermission('business_hours') 決定要不要顯示
// 這個入口,見 CalendarPage.tsx)。
// =========================================================================

/** 模組 6 §5.2/§6.4:設定單日例外(開啟/關閉時段),半小時為單位。回傳受影響的既有預約筆數
 * (只有關閉時可能 > 0,開啟時一律是 0),供呼叫端提示客服「這個時段還有 N 筆既有預約,系統不會
 * 自動取消或搬移」——不阻擋操作本身,單純回報數字(§5.2 第 4 點)。 */
export async function setStaffDayOverride(
  staffId: string,
  overrideDate: string, // 'YYYY-MM-DD'
  startTime: string, // 'HH:mm'
  endTime: string, // 'HH:mm'
  isAvailable: boolean,
): Promise<number> {
  const { data, error } = await supabase.rpc("set_staff_day_override", {
    p_staff_id: staffId,
    p_override_date: overrideDate,
    p_start_time: startTime,
    p_end_time: endTime,
    p_is_available: isAvailable,
  });
  if (error) throw error;
  return data as number;
}

/** 模組 6 §5.2/§6.4:清除單日例外,恢復成「沒有例外,回歸每週固定模板」的狀態。 */
export async function clearStaffDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  const { error } = await supabase.rpc("clear_staff_day_override", {
    p_staff_id: staffId,
    p_override_date: overrideDate,
    p_start_time: startTime,
    p_end_time: endTime,
  });
  if (error) throw error;
}

// =========================================================================
// 5.4:預約/訂單清單查詢(唯讀),供模組 6 訂單列表/篩選 UI 使用。
// =========================================================================
export interface MerchantBookingsFilters {
  startAt?: string; // ISO,含此時間之後(>=)
  endAt?: string; // ISO,不含此時間之後(<)
  /** 建單與訂單管理介面優化 §7.3:startAt/endAt 要套用在哪個時間欄位——「依預約時間」對應
   * start_at(既有預設行為,不帶這個參數時 fallback 這個值,不影響既有呼叫端),「依建單時間」
   * 對應 created_at。 */
  dateField?: "start_at" | "created_at";
  status?: string[];
  staffId?: string;
  /** 建單與訂單管理介面優化 §7.2:關鍵字模糊比對範圍擴大到客戶姓名/電話/地址/預約 id(單號)/
   * 備註(內部備註+客戶備註)。刻意不在資料庫層用 PostgREST `.or()` 疊加 ilike——id 是 uuid
   * 型別,直接對 uuid 欄位做 ilike 需要額外的型別轉換,穩定性不如在前端比對;§7.4 本來就不做
   * 真正分頁,符合其他篩選條件的訂單本來就會一次全部載入到前端,前端比對不會造成額外的資料量
   * 問題。實際比對邏輯抽在 ordersPageLogic.ts 的 bookingMatchesKeyword(純函式,方便 Vitest
   * 測試,也刻意不依賴這支檔案建立的 supabase client)。 */
  keyword?: string;
}

export async function fetchMerchantBookings(
  merchantId: string,
  filters: MerchantBookingsFilters = {},
): Promise<Booking[]> {
  const dateColumn = filters.dateField ?? "start_at";
  let query = supabase
    .from("bookings")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("start_at", { ascending: true });

  if (filters.startAt) query = query.gte(dateColumn, filters.startAt);
  if (filters.endAt) query = query.lt(dateColumn, filters.endAt);
  if (filters.status && filters.status.length > 0) query = query.in("status", filters.status);
  if (filters.staffId) query = query.eq("staff_id", filters.staffId);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Booking[];
  if (filters.keyword && filters.keyword.trim()) {
    return rows.filter((b) => bookingMatchesKeyword(b, filters.keyword as string));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 建單與訂單管理介面優化 §7.5:訂單卡片需要顯示的兩項延伸資訊——服務項目名稱清單、建單客服姓名
// (createdByName)。這兩項既有的 getBooking(id) 已經會算,但那是單筆查詢(內部還會多打一支
// get_booking_actor_names RPC),訂單管理頁一次要顯示一整批訂單,不能對每一筆都各自呼叫一次
// getBooking(N+1 查詢),所以另外做一支「批次」版本:服務項目名稱一次用 .in('booking_id', ids)
// 查完,建單客服姓名把所有訂單的 created_by_user_id 去重後一次呼叫 get_booking_actor_names
// (這支 RPC 本來就設計成接受一個 user id 陣列,不是新增的後端邏輯,只是換一個呼叫端組合既有
// 查詢的方式)。
// ---------------------------------------------------------------------------
export interface BookingCardExtra {
  serviceItemNames: string[];
  createdByName: string;
}

export async function fetchBookingCardExtras(
  merchantId: string,
  bookings: Pick<Booking, "id" | "created_by_user_id">[],
): Promise<Map<string, BookingCardExtra>> {
  const result = new Map<string, BookingCardExtra>();
  if (bookings.length === 0) return result;

  const bookingIds = bookings.map((b) => b.id);
  const actorIds = Array.from(
    new Set(bookings.map((b) => b.created_by_user_id).filter((id): id is string => Boolean(id))),
  );

  const [serviceItemsRes, actorNamesRes] = await Promise.all([
    supabase
      .from("booking_service_items")
      .select("booking_id, service_items(name)")
      .in("booking_id", bookingIds),
    actorIds.length > 0
      ? supabase.rpc("get_booking_actor_names", { p_merchant_id: merchantId, p_user_ids: actorIds })
      : Promise.resolve({ data: [] as { user_id: string; display_name: string }[], error: null }),
  ]);

  if (serviceItemsRes.error) throw serviceItemsRes.error;
  if (actorNamesRes.error) throw actorNamesRes.error;

  type ServiceItemRow = { booking_id: string; service_items: { name: string } | null };
  const namesByBookingId = new Map<string, string[]>();
  for (const row of (serviceItemsRes.data ?? []) as ServiceItemRow[]) {
    const list = namesByBookingId.get(row.booking_id) ?? [];
    list.push(row.service_items?.name ?? "(已刪除的服務項目)");
    namesByBookingId.set(row.booking_id, list);
  }

  const actorNameById = new Map<string, string>();
  for (const row of actorNamesRes.data ?? []) {
    actorNameById.set(row.user_id, row.display_name);
  }

  for (const b of bookings) {
    result.set(b.id, {
      serviceItemNames: namesByBookingId.get(b.id) ?? [],
      createdByName: b.created_by_user_id
        ? (actorNameById.get(b.created_by_user_id) ?? "(已移除的人員)")
        : "(已移除的人員)",
    });
  }
  return result;
}

/** 建單功能擴充 4.3:單筆預約詳情擴充,除了 bookings 主體欄位,一併回傳服務項目清單
 * (名稱+工時快照+模組 6 的數量/金額快照)、助手清單(姓名)、料錢成本清單(名稱+金額快照)。
 * 供 5.2 預約詳情彈窗顯示完整內容,也供 5.3 編輯表單帶入預設值。三張關聯表分開查詢
 * (不用 PostgREST 巢狀 embed),邏輯簡單直接,也避免依賴 schema cache 對巢狀關聯的自動推斷。
 *
 * 模組 6(訂單管理)§3.1 取代原本的即時查價顯示:service_items 的 join 只用來取名稱/狀態,
 * **金額一律讀 booking_service_items.quantity/unit_price_snapshot 這兩個快照欄位**,不再讀
 * service_items.price 的即時值——這是本次刻意的行為變更(舊版註解曾經明講「這是即時金額,不是
 * 快照」,金額快照策略已經在這次模組 6 通盤設計完成,不要被舊註解誤導)。服務項目已下架/已刪除
 * 時名稱 fallback 成「(已刪除的服務項目)」,金額不受影響(快照本來就不依賴 service_items 目前
 * 是否存在)。 */
export async function getBooking(id: string): Promise<BookingDetail | null> {
  const { data: booking, error: bookingError } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking) return null;

  const [serviceItemsRes, assistantsRes, materialCostsRes] = await Promise.all([
    supabase
      .from("booking_service_items")
      .select("service_item_id, quantity, unit_price_snapshot, service_items(name)")
      .eq("booking_id", id),
    supabase
      .from("booking_assistants")
      .select("staff_id, merchant_staff(name)")
      .eq("booking_id", id),
    supabase
      .from("booking_material_costs")
      .select("material_cost_item_id, amount_snapshot, material_cost_items(name)")
      .eq("booking_id", id),
  ]);

  if (serviceItemsRes.error) throw serviceItemsRes.error;
  if (assistantsRes.error) throw assistantsRes.error;
  if (materialCostsRes.error) throw materialCostsRes.error;

  // 預約詳情資訊擴充與建單備註分類第三節 3.2/3.3:把 created_by_user_id/last_modified_by_user_id
  // 轉成可讀姓名。created_by_user_id 理論上一定有值(created_by_role 是必填,建單時一定會寫入
  // auth.uid()),這裡仍防禦性地過濾 null,避免舊資料或未來邊界情況造成呼叫失敗。
  const actorIds = Array.from(
    new Set(
      [
        (booking as Booking).created_by_user_id,
        (booking as Booking).last_modified_by_user_id,
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actorNames, error: actorNamesError } = await supabase.rpc(
      "get_booking_actor_names",
      {
        p_merchant_id: (booking as Booking).merchant_id,
        p_user_ids: actorIds,
      },
    );
    if (actorNamesError) throw actorNamesError;
    for (const row of actorNames ?? []) {
      actorNameById.set(row.user_id, row.display_name);
    }
  }
  const createdByUserId = (booking as Booking).created_by_user_id;
  const lastModifiedByUserId = (booking as Booking).last_modified_by_user_id;

  type ServiceItemJoinRow = {
    service_item_id: string;
    quantity: number;
    unit_price_snapshot: number;
    service_items: { name: string } | null;
  };
  type AssistantJoinRow = { staff_id: string; merchant_staff: { name: string } | null };
  type MaterialCostJoinRow = {
    material_cost_item_id: string;
    amount_snapshot: number;
    material_cost_items: { name: string } | null;
  };

  return {
    ...(booking as Booking),
    serviceItems: ((serviceItemsRes.data ?? []) as ServiceItemJoinRow[]).map((row) => {
      // 模組 6 §3.1:名稱沿用既有 fallback 慣例(下架/刪除品項繼續顯示真實名稱,對使用者比較
      // 有意義);金額一律讀快照欄位,不受服務項目是否還存在/是否改價影響。
      return {
        id: row.service_item_id,
        name: row.service_items?.name ?? "(已刪除的服務項目)",
        quantity: row.quantity,
        unitPriceSnapshot: row.unit_price_snapshot,
        lineTotal: row.quantity * row.unit_price_snapshot,
      };
    }),
    assistants: ((assistantsRes.data ?? []) as AssistantJoinRow[]).map((row) => ({
      staffId: row.staff_id,
      staffName: row.merchant_staff?.name ?? "(已刪除的人員)",
    })),
    materialCosts: ((materialCostsRes.data ?? []) as MaterialCostJoinRow[]).map((row) => ({
      materialCostItemId: row.material_cost_item_id,
      name: row.material_cost_items?.name ?? "(已刪除的品項)",
      amountSnapshot: row.amount_snapshot,
    })),
    // 預約詳情資訊擴充與建單備註分類第三節 3.2:createdByUserId 理論上一定查得到姓名
    // (get_booking_actor_names 兩邊都查不到時 fallback「(已移除的人員)」,不會是 undefined),
    // 這裡仍保留一個保底文字,避免防禦性過濾把它排除掉的極端情況下畫面顯示空白。
    createdByName: createdByUserId
      ? (actorNameById.get(createdByUserId) ?? "(已移除的人員)")
      : "(已移除的人員)",
    // 3.3:last_modified_by_user_id 是 null 時(從未被 confirm/update/cancel/complete 異動過)
    // 回傳 null,前端據此判斷「這一列不顯示」。
    lastModifiedByName: lastModifiedByUserId
      ? (actorNameById.get(lastModifiedByUserId) ?? "(已移除的人員)")
      : null,
  };
}

// =========================================================================
// 建單功能擴充 6.1:料錢成本品項查詢(唯讀),供本模組建單表單、未來模組 6 使用。
// =========================================================================

/** 回傳某商家目前 status='active' 的料錢成本品項清單。 */
export async function fetchMerchantMaterialCostItems(
  merchantId: string,
): Promise<MaterialCostItem[]> {
  const { data, error } = await supabase
    .from("material_cost_items")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MaterialCostItem[];
}

// =========================================================================
// 4.4/4.5:料錢成本品項管理頁(5.4)用的 CRUD,RLS 要求 private.can_manage_material_costs。
// 比照模組 4 service_items 的既有做法,權限檢查下沉到 RLS,前端直接呼叫 supabase.from(...)。
// =========================================================================

/** 回傳某商家所有料錢成本品項(含已下架,5.4 畫面自行依 status 篩選/標示)。 */
export async function fetchMerchantMaterialCostItemsAll(
  merchantId: string,
): Promise<MaterialCostItem[]> {
  const { data, error } = await supabase
    .from("material_cost_items")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MaterialCostItem[];
}

export interface UpsertMaterialCostItemInput {
  name: string;
  amount: number;
}

export async function addMaterialCostItem(
  merchantId: string,
  input: UpsertMaterialCostItemInput,
): Promise<MaterialCostItem> {
  const { data, error } = await supabase
    .from("material_cost_items")
    .insert({ merchant_id: merchantId, name: input.name.trim(), amount: input.amount })
    .select("*")
    .single();
  if (error) throw error;
  return data as MaterialCostItem;
}

export async function updateMaterialCostItem(
  itemId: string,
  input: Partial<UpsertMaterialCostItemInput>,
): Promise<void> {
  const payload: TablesUpdate<"material_cost_items"> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
  };
  const { error } = await supabase.from("material_cost_items").update(payload).eq("id", itemId);
  if (error) throw error;
}

/** 規則 3.1:下架採軟刪除(status='removed'),不算危險操作。 */
export async function removeMaterialCostItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from("material_cost_items")
    .update({ status: "removed" })
    .eq("id", itemId);
  if (error) throw error;
}

export async function reactivateMaterialCostItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from("material_cost_items")
    .update({ status: "active" })
    .eq("id", itemId);
  if (error) throw error;
}

// 型別工具,供未來需要局部更新 bookings 欄位的模組(例如模組 6)參考既有慣例,這次本模組不使用。
export type BookingUpdate = TablesUpdate<"bookings">;

// =========================================================================
// 模組 6(訂單管理)§2.1/§4.7:商家整體稅金設定讀寫,RLS 要求 private.can_manage_business_hours。
// 查無資料時前端/後端一律 fallback 成 DEFAULT_MERCHANT_TAX_SETTINGS(裁決 Q5)。
// =========================================================================

/** 回傳某商家目前的稅金設定;查無資料(還沒特別設定過)時 fallback 成預設值,不回傳 null,
 * 讓呼叫端不用每次都自己判斷「有沒有這筆資料」。 */
export async function fetchMerchantTaxSettings(
  merchantId: string,
): Promise<{ taxMode: AmountAdjustmentMode; taxValue: number }> {
  const { data, error } = await supabase
    .from("merchant_tax_settings")
    .select("tax_mode, tax_value")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_MERCHANT_TAX_SETTINGS };
  return { taxMode: data.tax_mode as AmountAdjustmentMode, taxValue: Number(data.tax_value) };
}

export interface UpsertMerchantTaxSettingsInput {
  taxMode: AmountAdjustmentMode;
  taxValue: number;
}

/** §4.7 商家稅金設定畫面用:沒有既有列時新增,已有則更新(upsert on primary key merchant_id)。 */
export async function upsertMerchantTaxSettings(
  merchantId: string,
  input: UpsertMerchantTaxSettingsInput,
): Promise<void> {
  const { error } = await supabase
    .from("merchant_tax_settings")
    .upsert(
      { merchant_id: merchantId, tax_mode: input.taxMode, tax_value: input.taxValue },
      { onConflict: "merchant_id" },
    );
  if (error) throw error;
}

// =========================================================================
// 模組 9(支付方式)v2 §1.1/§4/§6:商家自訂付款方式清單,取代 v1 的開關式設計。
// 唯讀查詢(fetchMerchantPaymentMethods/fetchMerchantPaymentMethodsAll)的 RLS 同時放行
// can_manage_bookings(orders 權限)或 can_manage_payment_methods,寫入(add/update/remove/
// reactivate)的 RLS 只允許 can_manage_payment_methods(見 migration 20260919130100 的說明)。
// =========================================================================

/** 回傳某商家目前 status='active' 的付款方式清單,供建單表單下拉選單使用(§5.2)。 */
export async function fetchMerchantPaymentMethods(merchantId: string): Promise<PaymentMethod[]> {
  const { data, error } = await supabase
    .from("payment_methods")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaymentMethod[];
}

/** 回傳某商家所有付款方式(含已下架,管理頁畫面自行依 status 篩選/標示,§5.1)。 */
export async function fetchMerchantPaymentMethodsAll(
  merchantId: string,
): Promise<PaymentMethod[]> {
  const { data, error } = await supabase
    .from("payment_methods")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaymentMethod[];
}

export interface UpsertPaymentMethodInput {
  name: string;
  description?: string | null;
}

export async function addPaymentMethod(
  merchantId: string,
  input: UpsertPaymentMethodInput,
): Promise<PaymentMethod> {
  const { data, error } = await supabase
    .from("payment_methods")
    .insert({
      merchant_id: merchantId,
      name: input.name.trim(),
      description: input.description?.trim() ? input.description.trim() : null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as PaymentMethod;
}

export async function updatePaymentMethod(
  id: string,
  input: Partial<UpsertPaymentMethodInput>,
): Promise<void> {
  const payload: TablesUpdate<"payment_methods"> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? { description: input.description?.trim() ? input.description.trim() : null }
      : {}),
  };
  const { error } = await supabase.from("payment_methods").update(payload).eq("id", id);
  if (error) throw error;
}

/** 軟刪除(下架),不算危險操作,比照 material_cost_items 既有慣例。 */
export async function removePaymentMethod(id: string): Promise<void> {
  const { error } = await supabase
    .from("payment_methods")
    .update({ status: "removed" })
    .eq("id", id);
  if (error) throw error;
}

export async function reactivatePaymentMethod(id: string): Promise<void> {
  const { error } = await supabase
    .from("payment_methods")
    .update({ status: "active" })
    .eq("id", id);
  if (error) throw error;
}

// =========================================================================
// 模組 6 §3.3/§6.3:相關訂單查詢——同一位客戶(電話正規化後相同)在這間商家底下的歷史訂單清單,
// 供預約詳情頁的「相關訂單」按鈕使用,也保留給之後其他模組(如模組 10 會員與紅利)複用。
// =========================================================================
export async function getCustomerRelatedBookings(
  merchantId: string,
  customerPhone: string,
  excludeBookingId?: string | null,
): Promise<CustomerRelatedBooking[]> {
  const { data, error } = await supabase.rpc("get_customer_related_bookings", {
    p_merchant_id: merchantId,
    p_customer_phone: customerPhone,
    ...(excludeBookingId ? { p_exclude_booking_id: excludeBookingId } : {}),
  });
  if (error) throw error;
  return (
    (data ?? []) as {
      id: string;
      start_at: string;
      end_at: string;
      status: string;
      final_amount_snapshot: number;
      service_item_names: string[] | null;
    }[]
  ).map((row) => ({
    id: row.id,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status as CustomerRelatedBooking["status"],
    finalAmountSnapshot: row.final_amount_snapshot,
    serviceItemNames: row.service_item_names ?? [],
  }));
}

// =========================================================================
// 模組 6 §6.1:訂單金額查詢對外介面——直接取得「這筆訂單最終金額」的查詢窗口(讀取
// final_amount_snapshot 等 breakdown 欄位),供模組 8(薪資與帳務)、模組 12(報表匯出)之後
// 直接複用,不用重新查三張關聯表自己加總。
// =========================================================================
export interface BookingAmountSummary {
  id: string;
  subtotalAmountSnapshot: number;
  discountAmountSnapshot: number;
  taxAmountSnapshot: number;
  finalAmountSnapshot: number;
  paymentMethodId: string | null;
  paymentMethodNameSnapshot: string | null;
}

export async function fetchBookingAmountSummary(
  bookingId: string,
): Promise<BookingAmountSummary | null> {
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, subtotal_amount_snapshot, discount_amount_snapshot, tax_amount_snapshot, final_amount_snapshot, payment_method_id, payment_method_name_snapshot",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    subtotalAmountSnapshot: data.subtotal_amount_snapshot,
    discountAmountSnapshot: data.discount_amount_snapshot,
    taxAmountSnapshot: data.tax_amount_snapshot,
    finalAmountSnapshot: data.final_amount_snapshot,
    paymentMethodId: data.payment_method_id,
    paymentMethodNameSnapshot: data.payment_method_name_snapshot,
  };
}
