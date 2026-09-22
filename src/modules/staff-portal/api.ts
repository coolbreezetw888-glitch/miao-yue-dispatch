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
import type { Tables } from "@/integrations/supabase/types";
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
  contactEmail?: string | null;
  avatarUrl?: string | null;
  intro?: string | null;
}

export async function updateMyStaffProfile(input: UpdateMyStaffProfileInput): Promise<void> {
  // 已知的既有踩坑(比照 platform-admin/api.ts 的既有 4 個基準錯誤,這裡刻意避免重蹈覆轍):
  // supabase gen types 對 Postgres text 參數一律推導成 `string`(不是 `string | null`),即使資料庫
  // 函式實際上完全能接受 null——這是產生器的已知限制,不是真正的執行期限制。這裡改傳空字串而不是
  // null:update_my_staff_profile 內部用 nullif(trim(coalesce(p_xxx, '')), '') 正規化
  // nickname/phone/contact_email/intro,空字串跟 null 效果完全相同;avatar_url 沒有這層正規化,
  // 但呼叫端(EditMyStaffProfileDialog)一律用「目前已知的值」預先帶入表單再送出整組六個欄位
  // (不是部分更新),所以這裡不會有「不小心把既有頭像洗掉」的風險。
  const { error } = await supabase.rpc("update_my_staff_profile", {
    p_staff_id: input.staffId,
    p_name: input.name.trim(),
    p_nickname: input.nickname ?? "",
    p_phone: input.phone ?? "",
    p_contact_email: input.contactEmail ?? "",
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
    return "檔案大小不能超過 2MB,請壓縮後再上傳";
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

  const ext = file.name.includes(".") ? file.name.split(".").pop() : "png";
  const path = `${merchantId}/self/${staffId}/avatar-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STAFF_AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(STAFF_AVATAR_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
