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
  BookingDetail,
  MaterialCostItem,
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
// 建單功能擴充 2.3/決策記錄 4:料錢成本功能開關,同一組對外介面,同一個 key 常數放這裡集中管理。
// =========================================================================
export const STRICT_CONFLICT_CHECK_FEATURE_KEY = "strict_conflict_check";
export const MATERIAL_COST_ENABLED_FEATURE_KEY = "material_cost_enabled";

// =========================================================================
// 3.3/3.4/3.5,建單功能擴充 4.1/4.8/4.9:建立/確認/編輯/取消/標記完成預約。
// =========================================================================

/** 建單功能擴充 4.1:create_booking 破壞性簽章變更——serviceItemId 改成 serviceItemIds(多選,
 * 至少 1 個),新增 assistantStaffIds(助手清單,決策記錄 2)、materialCostItemIds(料錢成本品項,
 * 決策記錄 4)。 */
export interface CreateBookingInput {
  merchantId: string;
  staffId: string;
  serviceItemIds: string[];
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
    p_service_item_ids: input.serviceItemIds,
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
  });
  if (error) throw error;
  return data as Booking;
}

/** 建單功能擴充 4.9/決策記錄 6(新增):編輯已建立的預約,欄位範圍跟 CreateBookingInput 相同,
 * 多一個 bookingId 指定要編輯哪一筆。 */
export interface UpdateBookingInput {
  bookingId: string;
  staffId: string;
  serviceItemIds: string[];
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
    p_service_item_ids: input.serviceItemIds,
    p_start_at: input.startAt,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    ...(input.customerEmail ? { p_customer_email: input.customerEmail } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
    p_assistant_staff_ids: input.assistantStaffIds ?? [],
    p_material_cost_item_ids: input.materialCostItemIds ?? [],
    ...(input.customerAddress ? { p_customer_address: input.customerAddress } : {}),
    ...(input.customerNotes ? { p_customer_notes: input.customerNotes } : {}),
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

/** 建單功能擴充 4.3:單筆預約詳情擴充,除了 bookings 主體欄位,一併回傳服務項目清單
 * (名稱+工時快照)、助手清單(姓名)、料錢成本清單(名稱+金額快照)。供 5.2 預約詳情彈窗顯示完整內容,
 * 也供 5.3 編輯表單帶入預設值。三張關聯表分開查詢(不用 PostgREST 巢狀 embed),邏輯簡單直接,
 * 也避免依賴 schema cache 對巢狀關聯的自動推斷。
 *
 * 建單表單細節修正第五節:service_items 的 join 多帶一個 price 欄位。**這是查詢當下的即時金額,
 * 不是建立/編輯當下鎖定的價格快照**——如果服務項目之後改價,舊預約顯示的金額會跟著變動。金額快照
 * 策略明確保留給未來模組 6(訂單管理)通盤設計,這裡刻意不做,不要被誤以為這裡顯示的金額有被鎖定。
 * 服務項目已下架/已刪除時 price 回傳 null(fallback 顯示「—」,不要顯示 0)。 */
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
      .select("service_item_id, service_items(name, price, status)")
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
    service_items: { name: string; price: number; status: string } | null;
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
      // service_items 的 SELECT RLS 政策(service_items_select)只檢查管理權限,不排除
      // status='removed' 的列,所以「整列被刪除」(row.service_items 為 null)跟「已下架但
      // 資料列還在」(status !== 'active') 是兩種不同情況,都要視為「查不到目前有效的價格」。
      // 名稱則刻意不比照下架 fallback:下架品項概念上不是「不存在」,只是「不能再被選用於新
      // 預約」,繼續顯示它原本的真實名稱對使用者比較有意義;只有金額(規格書明確要求)才 fallback
      // 成「—」,避免顯示 0 讓人誤以為是免費,或直接報錯。
      const isRemoved = !row.service_items || row.service_items.status !== "active";
      return {
        id: row.service_item_id,
        name: row.service_items?.name ?? "(已刪除的服務項目)",
        price: isRemoved ? null : row.service_items!.price,
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
