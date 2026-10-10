// 模組 14:服務人員端 — 資料存取層。
// 這裡是唯一直接呼叫 supabase.from('merchant_staff_permissions') 或
// supabase.rpc('set_staff_permission' / 'mark_staff_login_active_if_self') /
// supabase.functions.invoke('invite-merchant-staff') 的地方。其他模組不應該直接操作這張表,
// 一律透過 context.tsx 匯出的 hooks(見規格書第五節「對外介面」)。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3 已經確立的踩坑,不重新發明一套):Supabase 用戶端
// `await supabase.rpc(...)` / `await supabase.from(...).xxx()` 不加 `.throwOnError()` 時,
// `error` 不是真正的 Error 實例,只是形狀像 Error 的一般物件。這裡沿用既有的簡單寫法
// `if (error) throw error`,畫面上一律用 `@/modules/platform-admin/getErrorMessage` 的
// getErrorMessage() 取訊息。

import { supabase } from "@/integrations/supabase/client";
import { imageExtensionForMime } from "@/lib/imageUploadExtension";
import type { Tables } from "@/integrations/supabase/types";
import {
  buildCalendarStateStyleMap,
  DEFAULT_BOOKING_STATUS_COLORS,
  type BookingStatusColorMap,
  type CalendarStateStyleMap,
  type DayScheduleAvailabilityOverride,
  type DayScheduleForeignBooking,
  type DayScheduleOnLeave,
} from "@/modules/booking/types";
import {
  buildMaterialCostItemsJsonb,
  type BookingServiceItemSelectionInput,
} from "@/modules/booking/api";
import type { BookingMaterialCostSelectionInput } from "@/modules/booking/materialCostSelection";
import type { MoveBookingInput, MoveBookingResult } from "@/modules/booking/bookingDragMove";
import { isoToTaipeiDateKey, isoToTaipeiTime } from "@/modules/booking/dateUtils";
import { computeBookingChangeSummary } from "@/modules/push-notifications/changeSummary";
import { dispatchLineNotification } from "@/modules/line-notifications/api";
import { dispatchPushNotification } from "@/modules/push-notifications/api";
import type { MerchantStaffPermission, StaffPermissionSectionKey } from "./types";

export type StaffAvailabilityOverride = Tables<"staff_availability_overrides">;

/** v2 §10.2.1 對應規格書:get_my_day_business_hours 回傳形狀,故意跟既有
 * get_merchant_day_schedule 的 business_hours 物件完全一致,方便前端沿用既有處理邏輯。 */
export interface MyDayBusinessHours {
  has_setting: boolean;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
}

/** 3.15 對應規格書 2.5/2.6:get_my_booking_schedule 回傳的單筆預約明細。 */
export interface MyBookingScheduleItem {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  role_in_booking: "primary" | "assistant";
  customer_name: string;
  customer_phone: string | null;
  customer_address: string | null;
  notes: string | null;
  customer_notes: string | null;
  service_item_names: string[];
  final_amount_snapshot: number | null;
  is_member: boolean | null;
  member_name: string | null;
  member_points_balance: number | null;
  /**
   * 客戶端第 3 批(C3-E01):get_my_booking_schedule 多回這兩欄(工程師甲擴充,不改其他欄位與遮蔽規則)。
   * 寫成可選:舊版函式沒有這兩欄時當作一般訂單。
   */
  source?: string | null;
  is_guest_booking?: boolean | null;
}

// =========================================================================
// 3.10:Edge Function invite-merchant-staff。完全比照模組 3 inviteMerchantAgent 的既有結構
// (這是本模組唯一一個不打 PostgREST /rpc 端點、而是打 Edge Function 的操作——因為需要
// service_role 權限呼叫 Supabase Auth Admin API,不能讓前端直接接觸那把金鑰)。
// =========================================================================

export interface InviteMerchantStaffInput {
  merchantId: string;
  staffId: string;
  loginEmail: string;
}

export interface InviteMerchantStaffResult {
  staffId: string;
  loginStatus: "invited" | "active";
  alreadyHadAccount: boolean;
}

export async function inviteMerchantStaff(
  input: InviteMerchantStaffInput,
): Promise<InviteMerchantStaffResult> {
  const { data, error } = await supabase.functions.invoke("invite-merchant-staff", {
    body: {
      merchant_id: input.merchantId,
      staff_id: input.staffId,
      login_email: input.loginEmail.trim(),
    },
  });

  if (error) {
    // 同模組 3 inviteMerchantAgent 的既有踩坑註記:supabase.functions.invoke 對非 2xx 回應丟出的
    // FunctionsHttpError 不含 Edge Function 回傳的 JSON 錯誤訊息本文,要另外從 error.context
    // (Response 物件)讀出來,不然只會看到通用的 "Edge Function returned a non-2xx status code"。
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = (await context.clone().json()) as { error?: string };
        if (body?.error) {
          throw new Error(body.error);
        }
      } catch {
        // 讀不到 JSON 本文就退回原本的 error,往下丟出去。
      }
    }
    throw error;
  }

  const result = data as {
    staff_id: string;
    login_status: "invited" | "active";
    already_had_account: boolean;
  };
  return {
    staffId: result.staff_id,
    loginStatus: result.login_status,
    alreadyHadAccount: result.already_had_account,
  };
}

// =========================================================================
// 3.12:服務人員完成設定密碼流程後,轉場頁載入時呼叫,把自己所有 invited 狀態的紀錄轉為 active。
// =========================================================================
export async function markStaffLoginActiveIfSelf(): Promise<void> {
  const { error } = await supabase.rpc("mark_staff_login_active_if_self");
  if (error) throw error;
}

// =========================================================================
// 3.19/4.7:服務人員自助功能權限的讀取/寫入。
// =========================================================================

/** 回傳某位服務人員目前已設定過的權限(4.7/StaffPermissionsPage.tsx 畫面用)。 */
export async function fetchStaffPermissions(staffId: string): Promise<MerchantStaffPermission[]> {
  const { data, error } = await supabase
    .from("merchant_staff_permissions")
    .select("*")
    .eq("staff_id", staffId);
  if (error) throw error;
  return (data ?? []) as MerchantStaffPermission[];
}

/** 3.4/4.7:商家管理員逐項開關某位服務人員的自助功能區塊(規則 2.11:僅限商家管理員)。 */
export async function setStaffPermission(
  staffId: string,
  sectionKey: StaffPermissionSectionKey | string,
  granted: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_staff_permission", {
    p_staff_id: staffId,
    p_section_key: sectionKey,
    p_granted: granted,
  });
  if (error) throw error;
}

// =========================================================================
// 3.15/5.1:我的行事曆彙整查詢。
// =========================================================================
export async function fetchMyBookingSchedule(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<MyBookingScheduleItem[]> {
  const { data, error } = await supabase.rpc("get_my_booking_schedule", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return (data ?? []) as unknown as MyBookingScheduleItem[];
}

// =========================================================================
// SPECS-INDEX #977 第 4 批(2026-10-06):主要服務人員確認接單。
// 後端 public.staff_confirm_booking 自己檢查「本人 + 主要服務人員 + 在職 + 行事曆檢視 + 待確認」,
// 同交易寫操作紀錄與商家管理員的鈴鐺通知。這裡**不呼叫任何 LINE / 推播 dispatch**(規格一之 4)。
// 回傳只有 {id, status}(後端刻意不回整列,避免客戶電話地址繞過遮蔽),成功後由呼叫端重查行事曆。
// =========================================================================
export async function staffConfirmBooking(bookingId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_confirm_booking", { p_booking_id: bookingId });
  if (error) throw error;
}

// =========================================================================
// v2 §10.2.1:我的商家某一天的營業時間(供時間軸格線/時段排休分頁共用)。
// =========================================================================
export async function fetchMyDayBusinessHours(
  staffId: string,
  date: string,
): Promise<MyDayBusinessHours> {
  const { data, error } = await supabase.rpc("get_my_day_business_hours", {
    p_staff_id: staffId,
    p_date: date,
  });
  if (error) throw error;
  return data as unknown as MyDayBusinessHours;
}

// =========================================================================
// SPECS-INDEX #644:服務人員自助讀取自己某一天的「全天休假/時段排休/跨店佔用」狀態明細
// (供 MyCalendarTimelineView.tsx 渲染用)。型別直接重用 booking 模組(CalendarPage.tsx 也是讀
// 同一組資料形狀)匯出的 DayScheduleOnLeave/DayScheduleAvailabilityOverride/
// DayScheduleForeignBooking,不重新定義一份重複的型別。
// =========================================================================
export interface MyDayScheduleState {
  on_leave: DayScheduleOnLeave | null;
  availability_overrides: DayScheduleAvailabilityOverride[];
  foreign_bookings: DayScheduleForeignBooking[];
}

export async function fetchMyDayScheduleState(
  staffId: string,
  date: string,
): Promise<MyDayScheduleState> {
  const { data, error } = await supabase.rpc("get_my_day_schedule_state", {
    p_staff_id: staffId,
    p_date: date,
  });
  if (error) throw error;
  return data as unknown as MyDayScheduleState;
}

/** SPECS-INDEX #644:服務人員自助讀取自己所屬商家的行事曆排程狀態顏色設定(全天休假/時段排休/
 * 跨店佔用)。一般服務人員不符合 can_manage_bookings,讀不到 merchant_calendar_state_styles
 * 表本身的 RLS SELECT 政策,所以改呼叫 SECURITY DEFINER 的 get_my_calendar_state_styles
 * (只檢查 is_own_staff_row),不是直接 supabase.from(...) 查表。查無資料的 key fallback 成
 * DEFAULT_CALENDAR_STATE_STYLES,跟商家設定頁讀取用的 fetchMerchantCalendarStateStyles
 * 保持同一套 fallback 慣例,兩邊看到的顏色最終一致。 */
export async function fetchMyCalendarStateStyles(staffId: string): Promise<CalendarStateStyleMap> {
  const { data, error } = await supabase.rpc("get_my_calendar_state_styles", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  return parseMyCalendarStateStyles(data);
}

/**
 * get_my_calendar_state_styles 回傳 `{ state_type: 色碼, ..., opacity: { state_type: 透明度 } }`
 * (#1050 起多了 opacity;舊格式沒有 opacity 也讀得懂)。缺的一律 fallback 成 DEFAULT_CALENDAR_STATE_STYLES,
 * 跟商家設定頁 fetchMerchantCalendarStateStyles 共用同一支 buildCalendarStateStyleMap。
 */
export function parseMyCalendarStateStyles(data: unknown): CalendarStateStyleMap {
  const raw =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const opacityRaw =
    raw["opacity"] && typeof raw["opacity"] === "object" && !Array.isArray(raw["opacity"])
      ? (raw["opacity"] as Record<string, unknown>)
      : {};
  const rows = Object.entries(raw)
    .filter(([key, value]) => key !== "opacity" && typeof value === "string")
    .map(([key, value]) => ({ state_type: key, color: value as string, opacity: opacityRaw[key] }));
  return buildCalendarStateStyleMap(rows);
}

/** SPECS-INDEX #1049(R6):服務人員自己的每週可預約時段(只有星期幾 / 開始 / 結束)。 */
export interface MyAvailabilityWindow {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

/**
 * SPECS-INDEX #1049(R6):服務人員行事曆時間軸畫「自己的每週可預約時段」用。
 * staff_availability_windows 的 SELECT 政策只放行「可管理營業時間的人」或「有自己排休權限的按件計酬服務人員」,
 * 其他服務人員直接查表會拿到 0 筆(看起來像沒有時段)。不放寬 RLS,改呼叫 SECURITY DEFINER 的
 * get_my_staff_availability_windows(只回本人、只回 day_of_week / start_time / end_time,檢查平台功能開關)。
 */
export async function fetchMyAvailabilityWindows(staffId: string): Promise<MyAvailabilityWindow[]> {
  const { data, error } = await supabase.rpc("get_my_staff_availability_windows", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  return (data ?? []).map((w) => ({
    day_of_week: w.day_of_week,
    start_time: w.start_time,
    end_time: w.end_time,
  }));
}

/** SPECS-INDEX #860:服務人員自助讀取自己所屬商家的「訂單狀態顏色設定」(待確認/已確認/
 * 已完成/已取消四個色碼),讓服務人員端行事曆的預約色塊跟商家端 CalendarPage.tsx 完全一致
 * (在此之前服務人員端用的是寫死的 Tailwind class,商家把顏色改成什麼都不會反映到服務人員手機上)。
 *
 * 🔴 為什麼不是 supabase.from("merchant_booking_status_colors")直接查表:
 *    那張表只有一條 SELECT 政策,條件是 private.can_manage_bookings(merchant_id),而
 *    can_manage_bookings 只認商家管理員與客服,**不認服務人員** ⇒ 純服務人員身分直接查表一定是
 *    0 筆(2026-09-30 用正式庫的真實服務人員帳號實測確認過)。所以改呼叫 SECURITY DEFINER 的
 *    get_my_booking_status_colors(只檢查 is_own_staff_row、merchant_id 由函式內部解出來,
 *    呼叫端無法指定 ⇒ 讀不到別家商家的顏色)。
 *    寫法刻意逐字比照下面 fetchMyCalendarStateStyles 的既有先例(同一個問題、姊妹表、同一種解法),
 *    不是另外發明一套。
 *
 * 查無資料的 key 一律 fallback 成 DEFAULT_BOOKING_STATUS_COLORS,跟商家端
 * fetchMerchantBookingStatusColors 同一套 fallback 慣例,兩邊看到的顏色最終一致。 */
export async function fetchMyBookingStatusColors(staffId: string): Promise<BookingStatusColorMap> {
  const { data, error } = await supabase.rpc("get_my_booking_status_colors", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  const raw = (data ?? {}) as unknown as Record<string, string>;
  return {
    pendingConfirmation:
      raw["pending_confirmation_color"] ?? DEFAULT_BOOKING_STATUS_COLORS.pendingConfirmation,
    accepted: raw["accepted_color"] ?? DEFAULT_BOOKING_STATUS_COLORS.accepted,
    completed: raw["completed_color"] ?? DEFAULT_BOOKING_STATUS_COLORS.completed,
    cancelled: raw["cancelled_color"] ?? DEFAULT_BOOKING_STATUS_COLORS.cancelled,
  };
}

// =========================================================================
// 5.3:我的單日例外(staff_availability_overrides)查詢——受 3.14 疊加後的 RLS 保護,
// 前端直接 supabase.from(...) 讀取即可,寫入一律透過既有的 set_staff_day_override/
// clear_staff_day_override(模組 6 對外介面,已在 3.14 疊加自助分支)。
// =========================================================================
export async function fetchMyAvailabilityOverrides(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffAvailabilityOverride[]> {
  const { data, error } = await supabase
    .from("staff_availability_overrides")
    .select("*")
    .eq("staff_id", staffId)
    .gte("override_date", startDate)
    .lte("override_date", endDate)
    .order("override_date", { ascending: true })
    .order("slot_start_time", { ascending: true });
  if (error) throw error;
  return (data ?? []) as StaffAvailabilityOverride[];
}

// =========================================================================
// 3.16/5.5:服務人員自助編輯個人資料。
// =========================================================================
export interface UpdateMyStaffProfileInput {
  staffId: string;
  name: string;
  nickname?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  intro?: string | null;
}

export async function updateMyStaffProfile(input: UpdateMyStaffProfileInput): Promise<void> {
  // 已知的既有踩坑(比照 platform-admin/api.ts 的既有 4 個基準錯誤,這裡刻意避免重蹈覆轍):
  // supabase gen types 對 Postgres text 參數一律推導成 `string`(不是 `string | null`),即使資料庫
  // 函式實際上完全能接受 null——這是產生器的已知限制,不是真正的執行期限制。這裡改傳空字串而不是
  // null:update_my_staff_profile 內部用 nullif(trim(coalesce(p_xxx, '')), '') 正規化
  // nickname/phone/intro,空字串跟 null 效果完全相同;avatar_url 沒有這層正規化,
  // 但呼叫端(EditMyStaffProfileDialog)一律用「目前已知的值」預先帶入表單再送出整組五個欄位
  // (不是部分更新),所以這裡不會有「不小心把既有頭像洗掉」的風險。
  //
  // ✅ 2026-09-24:p_contact_email 已經跟著 merchant_staff.contact_email 欄位一起移除
  // (migration 20260924040800,使用者裁決「客服和服務人員應該也是一樣只需要一個 Email 即可」),
  // 該 migration 已套用到正式資料庫、types.ts 也重新產生過,所以這裡送的就是最終的 6 個參數。
  // (界線:public.merchants.contact_email —— 商家本身對外給消費者看的聯絡信箱 —— 一律保留,
  //  跟這次移除的「人」的 contact_email 是兩回事。)
  const { error } = await supabase.rpc("update_my_staff_profile", {
    p_staff_id: input.staffId,
    p_name: input.name.trim(),
    p_nickname: input.nickname ?? "",
    p_phone: input.phone ?? "",
    p_avatar_url: input.avatarUrl ?? "",
    p_intro: input.intro ?? "",
  });
  if (error) throw error;
}

// =========================================================================
// 3.20/4.6:頭像自助上傳,路徑慣例 <merchant_id>/self/<staff_id>/<檔名>(對應判斷 8,
// 跟既有管理員路徑 <merchant_id>/<檔名> 分開,避免同商家服務人員互相覆蓋頭像)。
// 格式/大小限制比照既有標準(png/jpg/webp、單檔 2MB),改寫自
// src/modules/staff-agent/StaffAvatarUploader.tsx 的既有邏輯。
// =========================================================================
const STAFF_AVATAR_BUCKET = "staff-avatars";
const MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function validateStaffAvatarFile(file: File): string | null {
  if (
    !ALLOWED_AVATAR_MIME_TYPES.includes(file.type as (typeof ALLOWED_AVATAR_MIME_TYPES)[number])
  ) {
    return "只能上傳 PNG、JPG 或 WEBP 格式的圖片";
  }
  if (file.size > MAX_AVATAR_SIZE_BYTES) {
    return "檔案大小不能超過 2MB，請壓縮後再上傳";
  }
  return null;
}

export async function uploadMyStaffAvatar(
  merchantId: string,
  staffId: string,
  file: File,
): Promise<string> {
  const validationError = validateStaffAvatarFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  // #1052 H2-12:副檔名由實際檔案類型決定,不沿用原檔名。
  const ext = imageExtensionForMime(file.type);
  const path = `${merchantId}/self/${staffId}/avatar-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STAFF_AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(STAFF_AVATAR_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// =========================================================================
// SPECS-INDEX #977 第 7 批(2026-10-07):「服務人員新增編輯訂單」開關生效。
// 服務人員一律打 staff_ 開頭的包裝 RPC(後端自己檢查本人 + 兩個開關 + 行事曆檢視 + 主要服務人員),
// 不直接打 create_booking / update_booking 等既有函式(那些只認管理員 / 客服)。
// 包裝 RPC **一律不回整列 bookings**,這裡的回傳型別也只寫實際拿得到的欄位。
// 通知:成功後比照商家端 booking/api.ts 的 createBooking / updateBooking / cancelBooking / completeBooking / moveBooking,
// 用同樣的事件 fire-and-forget 呼叫 dispatchLineNotification / dispatchPushNotification
// (Edge Function 端多了一道 can_staff_dispatch_booking_notification 放行服務人員本人)。
// previousStaffId 一律不帶:服務人員不能換主要服務人員。
// =========================================================================

/**
 * staff_get_booking_form_options 的回傳(只有本店的選項,沒有客戶 / 會員 / 其他服務人員)。
 * #986 第 9 批:多了料錢(總開關 + 本店上架品項;關著時品項是空陣列)、建單時間間隔、服務項目描述。
 */
export interface StaffBookingFormOptions {
  staff_id: string;
  staff_name: string;
  industry_type: string;
  service_items: {
    id: string;
    name: string;
    price: number;
    duration_minutes: number;
    category_id: string | null;
    /** #986 第 9 批:服務項目描述(沒填 = null)。舊版後端沒有這個鍵 ⇒ undefined。 */
    description?: string | null;
  }[];
  service_categories: { id: string; name: string }[];
  payment_methods: { id: string; name: string }[];
  tax_settings: { tax_mode: string; tax_value: number } | null;
  business_hours: { day_of_week: number; is_closed: boolean }[];
  /** #986 第 9 批:料錢成本總開關(查無 = false)。 */
  material_cost_enabled?: boolean;
  /** #986 第 9 批:本店上架料錢品項(總開關關著 ⇒ [])。 */
  material_cost_items?: { id: string; name: string; amount: number }[];
  /** #986 第 9 批:建單時間間隔(5 / 10 / 15 / 30,後端已把其他值轉成 30)。 */
  start_time_interval_minutes?: number;
}

export async function fetchStaffBookingFormOptions(
  staffId: string,
): Promise<StaffBookingFormOptions> {
  const { data, error } = await supabase.rpc("staff_get_booking_form_options", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  return data as unknown as StaffBookingFormOptions;
}

/** staff_get_booking_for_edit 的回傳。notes_hidden = true 時 notes 一定是 null(後端不回原文)。 */
export interface StaffBookingForEdit {
  id: string;
  merchant_id: string;
  staff_id: string;
  status: string;
  start_at: string;
  end_at: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  customer_address: string | null;
  customer_notes: string | null;
  notes: string | null;
  notes_hidden: boolean;
  custom_total_amount_enabled: boolean;
  custom_total_amount: number | null;
  discount_enabled: boolean;
  discount_mode: string | null;
  discount_value: number | null;
  tax_enabled: boolean;
  tax_mode_snapshot: string | null;
  tax_value_snapshot: number | null;
  payment_method_id: string | null;
  payment_method_name_snapshot: string | null;
  custom_duration_enabled: boolean;
  custom_duration_minutes: number | null;
  member_id: string | null;
  member_name_snapshot: string | null;
  points_planned: number;
  points_planned_auto: number;
  points_planned_overridden: boolean;
  points_redeemed: number;
  points_redeem_amount_snapshot: number;
  service_items: {
    service_item_id: string;
    name: string;
    quantity: number;
    unit_price_snapshot: number;
  }[];
  /** 協助人員只有姓名(唯讀顯示「由商家指派」)。 */
  assistant_names: string[];
  /**
   * #986 第 9 批:這張單目前的料錢(金額是訂單上的快照;is_active = false 代表品項已下架)。
   * 舊版後端沒有這個鍵 ⇒ undefined。
   */
  material_costs?: {
    material_cost_item_id: string;
    name: string;
    /** 第 11 批 F #993 起語意是「單價」快照。 */
    amount_snapshot: number;
    /** 第 11 批 F #993:數量;舊版後端沒有 ⇒ undefined(當 1)。 */
    quantity?: number;
    is_active: boolean;
  }[];
}

export async function fetchStaffBookingForEdit(bookingId: string): Promise<StaffBookingForEdit> {
  const { data, error } = await supabase.rpc("staff_get_booking_for_edit", {
    p_booking_id: bookingId,
  });
  if (error) throw error;
  return data as unknown as StaffBookingForEdit;
}

export async function fetchMyBookableStartTimes(params: {
  staffId: string;
  date: string;
  durationMinutes: number;
  excludeBookingId: string | null;
}): Promise<string[]> {
  const { data, error } = await supabase.rpc("staff_list_my_bookable_start_times", {
    p_staff_id: params.staffId,
    p_date: params.date,
    p_duration_minutes: params.durationMinutes,
    ...(params.excludeBookingId ? { p_exclude_booking_id: params.excludeBookingId } : {}),
  });
  if (error) throw error;
  return (data ?? []) as string[];
}

function buildStaffServiceItemsJsonb(items: BookingServiceItemSelectionInput[]) {
  return items.map((item) => ({
    service_item_id: item.serviceItemId,
    quantity: item.quantity,
    unit_price: item.unitPrice,
  }));
}

/** 紅利預覽:沒有會員參數 —— 後端自己決定(新增 = 依電話;編輯 = 這張單現有的會員)。 */
export async function staffPreviewBookingPoints(params: {
  staffId: string;
  bookingId: string | null;
  customerPhone: string;
  serviceItems: BookingServiceItemSelectionInput[];
  customTotalAmountEnabled?: boolean | undefined;
  customTotalAmount?: number | null | undefined;
  discountEnabled?: boolean | undefined;
  discountMode?: string | null | undefined;
  discountValue?: number | null | undefined;
  taxEnabled?: boolean | undefined;
  taxMode?: string | null | undefined;
  taxValue?: number | null | undefined;
}): Promise<unknown> {
  const { data, error } = await supabase.rpc("staff_preview_booking_points", {
    p_staff_id: params.staffId,
    // gen types 把 uuid / numeric 參數推成非 null,資料庫端接受 null(= 新增模式 / 沒填)。
    p_booking_id: params.bookingId as string,
    p_customer_phone: params.customerPhone,
    p_service_items: buildStaffServiceItemsJsonb(params.serviceItems),
    p_custom_total_amount_enabled: params.customTotalAmountEnabled ?? false,
    p_custom_total_amount: (params.customTotalAmount ?? null) as number,
    p_discount_enabled: params.discountEnabled ?? false,
    p_discount_mode: (params.discountMode ?? null) as string,
    p_discount_value: (params.discountValue ?? null) as number,
    p_tax_enabled: params.taxEnabled ?? false,
    p_tax_mode: (params.taxMode ?? null) as string,
    p_tax_value: (params.taxValue ?? null) as number,
  });
  if (error) throw error;
  return data;
}

/**
 * 建單 / 改單共用的表單欄位(沒有協助人員、會員、隱藏備註 —— 後端根本沒有這些參數)。
 * #986 第 9 批:多了料錢(使用者裁決「服務人員跟客服一樣可看可改料錢」);第 11 批 F #993 改成
 * materialCostItems(品項 + 數量 + 自訂成本單價)。
 */
export interface StaffBookingFormFields {
  serviceItems: BookingServiceItemSelectionInput[];
  startAt: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  notes?: string | null;
  customerAddress?: string | null;
  customerNotes?: string | null;
  customTotalAmountEnabled?: boolean;
  customTotalAmount?: number | null;
  discountEnabled?: boolean;
  discountMode?: string | null;
  discountValue?: number | null;
  taxEnabled?: boolean;
  taxMode?: string | null;
  taxValue?: number | null;
  paymentMethodId?: string | null;
  customDurationEnabled?: boolean;
  customDurationMinutes?: number | null;
  /**
   * #986 第 9 批 / 第 11 批 F #993:料錢 {品項, 數量, 單價}。undefined = 不帶這個參數(建單 = 不帶料錢、
   * 改單 = 後端維持現有料錢,連同數量與單價);陣列(含空陣列 = 全部拿掉)= 用這個值。
   * 表單送出時一律帶目前勾選的陣列。
   */
  materialCostItems?: BookingMaterialCostSelectionInput[];
}

function buildStaffFormArgs(input: StaffBookingFormFields) {
  return {
    p_service_items: buildStaffServiceItemsJsonb(input.serviceItems),
    p_start_at: input.startAt,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    ...(input.customerEmail ? { p_customer_email: input.customerEmail } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
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
    ...(input.materialCostItems !== undefined
      ? { p_material_cost_items: buildMaterialCostItemsJsonb(input.materialCostItems) }
      : {}),
  };
}

export interface StaffCreateBookingInput extends StaffBookingFormFields {
  staffId: string;
  pointsOverride?: number | null;
  pointsRedeemed?: number;
  pointsRedeemMemberId?: string | null;
}

/** staff_create_booking 的回傳 = 建單成功提示(buildBookingCreatedToast)需要的欄位。 */
export interface StaffCreatedBooking {
  id: string;
  merchant_id: string;
  status: string;
  member_id: string | null;
  member_name_snapshot: string | null;
  member_auto_created: boolean;
  final_amount_snapshot: number;
  points_planned: number;
  points_redeemed: number;
  points_redeem_amount_snapshot: number;
}

export async function staffCreateBooking(
  input: StaffCreateBookingInput,
): Promise<StaffCreatedBooking> {
  const { data, error } = await supabase.rpc("staff_create_booking", {
    p_staff_id: input.staffId,
    ...buildStaffFormArgs(input),
    p_points_redeemed: input.pointsRedeemed ?? 0,
    ...(input.pointsOverride !== null && input.pointsOverride !== undefined
      ? { p_points_override: input.pointsOverride }
      : {}),
    p_points_redeem_member_id: (input.pointsRedeemMemberId ?? null) as string,
  });
  if (error) throw error;
  const created = data as unknown as StaffCreatedBooking;
  // 跟商家端 createBooking 一樣:LINE + 推播 booking_created,不等待、吞掉錯誤。
  dispatchLineNotification({
    merchantId: created.merchant_id,
    bookingId: created.id,
    eventType: "booking_created",
  });
  dispatchPushNotification({
    merchantId: created.merchant_id,
    bookingId: created.id,
    eventType: "booking_created",
  });
  return created;
}

export interface StaffUpdateBookingInput extends StaffBookingFormFields {
  bookingId: string;
  pointsOverride?: number | null;
  pointsRedeemed?: number | null;
  pointsOverrideReset?: boolean;
  pointsRedeemMemberId?: string | null;
  /** 推播的一句話摘要(同商家端 updateBooking 的 changeSummary)。 */
  changeSummary?: string | null;
}

export interface StaffUpdatedBooking {
  id: string;
  merchant_id: string;
  status: string;
  start_at: string;
  staff_id: string;
}

// #986 使用者裁決：服務人員改單 / 拖拉不通知客戶，不可加 LINE
export async function staffUpdateBooking(
  input: StaffUpdateBookingInput,
): Promise<StaffUpdatedBooking> {
  const { data, error } = await supabase.rpc("staff_update_booking", {
    p_booking_id: input.bookingId,
    ...buildStaffFormArgs(input),
    // 同商家端 updateBooking:折抵一律帶 key(null = 維持原折抵)。
    p_points_redeemed: (input.pointsRedeemed ?? null) as number,
    ...(input.pointsOverride !== null && input.pointsOverride !== undefined
      ? { p_points_override: input.pointsOverride }
      : {}),
    p_points_override_reset: input.pointsOverrideReset ?? false,
    p_points_redeem_member_id: (input.pointsRedeemMemberId ?? null) as string,
  });
  if (error) throw error;
  const updated = data as unknown as StaffUpdatedBooking;
  // 跟商家端 updateBooking 一樣只發推播 booking_updated;不能換人 ⇒ 不帶 previousStaffId。
  dispatchPushNotification({
    merchantId: updated.merchant_id,
    bookingId: updated.id,
    eventType: "booking_updated",
    ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
  });
  return updated;
}

export interface StaffBookingStatusResult {
  id: string;
  merchant_id: string;
  status: string;
}

export async function staffCancelBooking(
  bookingId: string,
  reason?: string | null,
): Promise<StaffBookingStatusResult> {
  const { data, error } = await supabase.rpc("staff_cancel_booking", {
    p_booking_id: bookingId,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw error;
  const result = data as unknown as StaffBookingStatusResult;
  // 同商家端 cancelBooking:LINE + 推播 booking_cancelled。
  dispatchLineNotification({
    merchantId: result.merchant_id,
    bookingId: result.id,
    eventType: "booking_cancelled",
  });
  dispatchPushNotification({
    merchantId: result.merchant_id,
    bookingId: result.id,
    eventType: "booking_cancelled",
  });
  return result;
}

export async function staffCompleteBooking(bookingId: string): Promise<StaffBookingStatusResult> {
  const { data, error } = await supabase.rpc("staff_complete_booking", { p_booking_id: bookingId });
  if (error) throw error;
  const result = data as unknown as StaffBookingStatusResult;
  // 同商家端 completeBooking:只發 LINE booking_completed。
  dispatchLineNotification({
    merchantId: result.merchant_id,
    bookingId: result.id,
    eventType: "booking_completed",
  });
  return result;
}

/**
 * 拖拉改時間(只改時間、不能轉派)。吃的是拖拉接線層(calendarBookingDrag.tsx)同一份 MoveBookingInput,
 * 但只用 bookingId / targetStartAt / expectedStartAt —— 被拖的 / 目標 / 預期服務人員一律由後端固定成自己。
 * 回傳形狀跟 MoveBookingResult 相容(booking 只有 id / merchant_id,previous / next 沒有 assistant_staff_id)。
 * 成功後比照商家端 moveBooking 發推播 booking_updated(changeSummary 同一支 computeBookingChangeSummary;
 * 不能換人 ⇒ 不帶 previousStaffId)。「復原」= 再呼叫一次這支搬回原時間。
 */
// #986 使用者裁決：服務人員改單 / 拖拉不通知客戶，不可加 LINE
export async function staffMoveBooking(
  input: Pick<MoveBookingInput, "bookingId" | "targetStartAt" | "expectedStartAt">,
): Promise<MoveBookingResult> {
  const { data, error } = await supabase.rpc("staff_move_booking", {
    p_booking_id: input.bookingId,
    p_target_start_at: input.targetStartAt,
    p_expected_start_at: input.expectedStartAt,
  });
  if (error) throw error;
  const result = data as unknown as MoveBookingResult;
  const merchantId = result.booking["merchant_id"];
  if (typeof merchantId === "string" && merchantId) {
    const changeSummary = computeBookingChangeSummary({
      original: {
        startAt: result.previous.start_at,
        serviceItemIds: [],
        staffId: result.previous.staff_id,
      },
      next: {
        startAt: result.next.start_at,
        serviceItemIds: [],
        staffId: result.next.staff_id,
        staffName: null,
        formattedStartAt: `${isoToTaipeiDateKey(result.next.start_at)} ${isoToTaipeiTime(result.next.start_at)}`,
      },
    });
    dispatchPushNotification({
      merchantId,
      bookingId: result.booking.id,
      eventType: "booking_updated",
      changeSummary,
    });
  }
  return result;
}

/** 開 / 關自己某一格(半小時)。回傳衝突的既有預約筆數(只提示不擋)。 */
export async function staffSetMySlot(params: {
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}): Promise<number> {
  const { data, error } = await supabase.rpc("staff_set_my_slot", {
    p_staff_id: params.staffId,
    p_date: params.date,
    p_start_time: params.startTime,
    p_end_time: params.endTime,
    p_is_available: params.isAvailable,
  });
  if (error) throw error;
  return (data ?? 0) as number;
}
