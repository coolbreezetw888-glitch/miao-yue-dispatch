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
  StaffAvailabilityWindow,
} from "./types";
import { DEFAULT_MERCHANT_TAX_SETTINGS } from "./types";

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
  /** 模組 6 §3.2/裁決 Q10:付款方式,見 types.ts PAYMENT_METHOD_OPTIONS。 */
  paymentMethod?: string | null;
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
    ...(input.taxValue !== null && input.taxValue !== undefined ? { p_tax_value: input.taxValue } : {}),
    ...(input.paymentMethod ? { p_payment_method: input.paymentMethod } : {}),
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
    ...(input.taxValue !== null && input.taxValue !== undefined ? { p_tax_value: input.taxValue } : {}),
    ...(input.paymentMethod ? { p_payment_method: input.paymentMethod } : {}),
  });
  if (error) throw error;
  return data as Booking;
}

/** 模組 6 §3.2/§6.2:單獨更新付款方式,不需要傳服務項目/金額等其餘欄位。 */
export async function updateBookingPaymentMethod(
  bookingId: string,
  paymentMethod: string | null,
): Promise<Booking> {
  const { data, error } = await supabase.rpc("update_booking_payment_method", {
    p_booking_id: bookingId,
    ...(paymentMethod ? { p_payment_method: paymentMethod } : {}),
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
// 5.4:預約/訂單清單查詢(唯讀),供模組 6 訂單列表/篩選 UI 使用。
// =========================================================================
export interface MerchantBookingsFilters {
  startAt?: string; // ISO,含此時間之後(>=)
  endAt?: string; // ISO,不含此時間之後(<)
  status?: string[];
  staffId?: string;
  /** 模組 6(訂單管理)§1.2:客戶關鍵字搜尋(姓名或電話模糊比對),既有 fetchMerchantBookings
   * 沒有的新篩選條件。客服可能只記得姓名或只記得電話其中一項,所以同時比對兩個欄位
   * (PostgREST `.or(...)` 疊加 ilike,對應 SQL 的「姓名 ILIKE 或 電話 ILIKE」)。 */
  customerKeyword?: string;
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
  if (filters.customerKeyword && filters.customerKeyword.trim()) {
    // PostgREST 的 .or() 逗號是分隔子條件的語法字元,關鍵字裡如果剛好含有逗號會被誤判成多條件,
    // 這裡先跳脫掉,避免客服搜尋字串裡有逗號時查詢語法出錯或條件被拆散。
    const escaped = filters.customerKeyword.trim().replace(/,/g, "\\,");
    query = query.or(`customer_name.ilike.%${escaped}%,customer_phone.ilike.%${escaped}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Booking[];
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
      [(booking as Booking).created_by_user_id, (booking as Booking).last_modified_by_user_id].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actorNames, error: actorNamesError } = await supabase.rpc("get_booking_actor_names", {
      p_merchant_id: (booking as Booking).merchant_id,
      p_user_ids: actorIds,
    });
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
    createdByName: createdByUserId ? (actorNameById.get(createdByUserId) ?? "(已移除的人員)") : "(已移除的人員)",
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
  const { error } = await supabase.from("merchant_tax_settings").upsert(
    { merchant_id: merchantId, tax_mode: input.taxMode, tax_value: input.taxValue },
    { onConflict: "merchant_id" },
  );
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
  return ((data ?? []) as {
    id: string;
    start_at: string;
    end_at: string;
    status: string;
    final_amount_snapshot: number;
    service_item_names: string[] | null;
  }[]).map((row) => ({
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
  paymentMethod: string | null;
}

export async function fetchBookingAmountSummary(bookingId: string): Promise<BookingAmountSummary | null> {
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, subtotal_amount_snapshot, discount_amount_snapshot, tax_amount_snapshot, final_amount_snapshot, payment_method",
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
    paymentMethod: data.payment_method,
  };
}
