// 模組 3:人員與權限管理 — 資料存取層
// 這裡是唯一直接呼叫 supabase.from('merchant_staff' / 'merchant_agents' /
// 'merchant_staff_service_items' / 'merchant_agent_permissions') 或 supabase.rpc(...) /
// supabase.functions.invoke(...) 的地方。其他模組不應該直接操作這幾張表(見規格書第五節
// 「對外介面」),一律透過 context.tsx 匯出的 hooks。
//
// 錯誤訊息顯示注意事項(沿用模組 2 已經確立的踩坑,不重新發明一套):Supabase 用戶端
// `await supabase.rpc(...)` / `await supabase.from(...).xxx()` 不加 `.throwOnError()` 時,
// `error` 不是真正的 Error 實例,只是形狀像 Error 的一般物件。這裡沿用模組 1 的簡單寫法
// `if (error) throw error`(直接丟出那個一般物件),畫面上一律用
// `@/modules/platform-admin/getErrorMessage` 的 getErrorMessage() 取訊息——那支工具本來就同時
// 涵蓋「真正的 Error 實例」與「有 message 欄位的一般物件」兩種情況,不需要在這裡額外包一層
// 自訂 Error 子類別。

import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type { MerchantAgent, MerchantAgentPermission, MerchantStaff } from "./types";

export const STAFF_AVATAR_BUCKET = "staff-avatars";
/** 規格書 4.2 邊界情況:頭像上傳格式/大小限制比照模組 1 規則 2.6。 */
export const MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024;
export const ALLOWED_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

function toNullIfEmpty(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// =========================================================================
// 3.2 / 4.1:商家管理員名單操作(邀請/移除另一位管理員)。
// =========================================================================

/** 3.2:前端呼叫用,確認目前使用者是否為指定商家的管理員。 */
export async function amIMerchantAdmin(merchantId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("am_i_merchant_admin", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return Boolean(data);
}

/** 3.3/4.1:商家管理員邀請另一位管理員(只能邀請已註冊帳號)。 */
export async function inviteMerchantAdmin(merchantId: string, userEmail: string): Promise<void> {
  const { error } = await supabase.rpc("invite_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_email: userEmail.trim(),
  });
  if (error) throw error;
}

/** 3.3/4.1:商家管理員移除另一位管理員。規則 2.4 的防呆檢查在資料庫端。 */
export async function removeMerchantAdmin(merchantId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_id: userId,
  });
  if (error) throw error;
}

// =========================================================================
// 3.4 / 4.2:服務人員 CRUD。
// =========================================================================

export interface UpsertMerchantStaffInput {
  name: string;
  nickname?: string | null;
  phone?: string | null;
  contactEmail?: string | null;
  intro?: string | null;
  avatarUrl?: string | null;
  isListed?: boolean;
  advanceBookingDays?: number | null;
  bookingWindowMinDays?: number | null;
  bookingWindowMaxDays?: number | null;
  noTimeSlotLimit?: boolean;
  unlimitedBackendEdit?: boolean;
  directAcceptAfterMerchantConfirm?: boolean;
  autoAcceptBooking?: boolean;
  showMemberInfo?: boolean;
  googleCalendarSyncEnabled?: boolean;
  canCreateEditOrders?: boolean;
  canUploadConstructionPhotos?: boolean;
}

/** 3.4:回傳某商家的服務人員清單(含已移除,4.2 畫面自行依 status 篩選/標示)。 */
export async function fetchMerchantStaff(merchantId: string): Promise<MerchantStaff[]> {
  const { data, error } = await supabase
    .from("merchant_staff")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MerchantStaff[];
}

/** 3.4:新增一筆服務人員(規則 2.2,這次不涉及帳號查找,單純資料寫入)。 */
export async function addMerchantStaff(
  merchantId: string,
  input: UpsertMerchantStaffInput,
): Promise<MerchantStaff> {
  const { data, error } = await supabase
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: input.name.trim(),
      nickname: toNullIfEmpty(input.nickname),
      phone: toNullIfEmpty(input.phone),
      contact_email: toNullIfEmpty(input.contactEmail),
      intro: toNullIfEmpty(input.intro),
      avatar_url: input.avatarUrl ?? null,
      is_listed: input.isListed ?? false,
      advance_booking_days: input.advanceBookingDays ?? null,
      booking_window_min_days: input.bookingWindowMinDays ?? null,
      booking_window_max_days: input.bookingWindowMaxDays ?? null,
      no_time_slot_limit: input.noTimeSlotLimit ?? false,
      unlimited_backend_edit: input.unlimitedBackendEdit ?? false,
      direct_accept_after_merchant_confirm: input.directAcceptAfterMerchantConfirm ?? false,
      auto_accept_booking: input.autoAcceptBooking ?? false,
      show_member_info: input.showMemberInfo ?? false,
      google_calendar_sync_enabled: input.googleCalendarSyncEnabled ?? false,
      can_create_edit_orders: input.canCreateEditOrders ?? false,
      can_upload_construction_photos: input.canUploadConstructionPhotos ?? false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as MerchantStaff;
}

/** 3.4:編輯既有服務人員資料。 */
export async function updateMerchantStaff(
  staffId: string,
  input: Partial<UpsertMerchantStaffInput>,
): Promise<void> {
  const payload: TablesUpdate<"merchant_staff"> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.nickname !== undefined ? { nickname: toNullIfEmpty(input.nickname) } : {}),
    ...(input.phone !== undefined ? { phone: toNullIfEmpty(input.phone) } : {}),
    ...(input.contactEmail !== undefined
      ? { contact_email: toNullIfEmpty(input.contactEmail) }
      : {}),
    ...(input.intro !== undefined ? { intro: toNullIfEmpty(input.intro) } : {}),
    ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
    ...(input.isListed !== undefined ? { is_listed: input.isListed } : {}),
    ...(input.advanceBookingDays !== undefined
      ? { advance_booking_days: input.advanceBookingDays }
      : {}),
    ...(input.bookingWindowMinDays !== undefined
      ? { booking_window_min_days: input.bookingWindowMinDays }
      : {}),
    ...(input.bookingWindowMaxDays !== undefined
      ? { booking_window_max_days: input.bookingWindowMaxDays }
      : {}),
    ...(input.noTimeSlotLimit !== undefined ? { no_time_slot_limit: input.noTimeSlotLimit } : {}),
    ...(input.unlimitedBackendEdit !== undefined
      ? { unlimited_backend_edit: input.unlimitedBackendEdit }
      : {}),
    ...(input.directAcceptAfterMerchantConfirm !== undefined
      ? { direct_accept_after_merchant_confirm: input.directAcceptAfterMerchantConfirm }
      : {}),
    ...(input.autoAcceptBooking !== undefined
      ? { auto_accept_booking: input.autoAcceptBooking }
      : {}),
    ...(input.showMemberInfo !== undefined ? { show_member_info: input.showMemberInfo } : {}),
    ...(input.googleCalendarSyncEnabled !== undefined
      ? { google_calendar_sync_enabled: input.googleCalendarSyncEnabled }
      : {}),
    ...(input.canCreateEditOrders !== undefined
      ? { can_create_edit_orders: input.canCreateEditOrders }
      : {}),
    ...(input.canUploadConstructionPhotos !== undefined
      ? { can_upload_construction_photos: input.canUploadConstructionPhotos }
      : {}),
  };
  const { error } = await supabase.from("merchant_staff").update(payload).eq("id", staffId);
  if (error) throw error;
}

/** 規則 2.8:移除一律軟刪除(status='removed'),不做真刪除。 */
export async function removeMerchantStaff(staffId: string): Promise<void> {
  const { error } = await supabase
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", staffId);
  if (error) throw error;
}

export async function reactivateMerchantStaff(staffId: string): Promise<void> {
  const { error } = await supabase
    .from("merchant_staff")
    .update({ status: "active" })
    .eq("id", staffId);
  if (error) throw error;
}

/** 頭像上傳格式/大小驗證,前端送出前先擋下,不要送到 Storage 才失敗(比照模組 1 LogoUploader)。 */
export function validateAvatarFile(file: File): string | null {
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

/** 4.2 邊界情況:上傳服務人員頭像,路徑慣例沿用模組 1 <merchant_id>/<檔名>(改寫自 uploadMerchantLogo)。 */
export async function uploadStaffAvatar(merchantId: string, file: File): Promise<string> {
  const validationError = validateAvatarFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const ext = file.name.includes(".") ? file.name.split(".").pop() : "png";
  const path = `${merchantId}/staff-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STAFF_AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(STAFF_AVATAR_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// =========================================================================
// 1.2:服務人員 x 服務項目關聯。模組 4 定案 service_items 表結構、補上外鍵之後,
// 這裡改成真正可勾選/取消勾選(對應模組 4 規格書 4.4)。
// =========================================================================

export async function fetchStaffServiceItemIds(staffId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("merchant_staff_service_items")
    .select("service_item_id")
    .eq("staff_id", staffId);
  if (error) throw error;
  return (data ?? []).map((row) => row.service_item_id);
}

/** 模組 4 規格書 4.4:勾選某項服務項目給這位服務人員。直接呼叫既有的 RLS 政策即可
 * (模組 3 migration 已經幫 merchant_staff_service_items 補好 INSERT 政策),不需要另開 RPC。 */
export async function addStaffServiceItem(staffId: string, serviceItemId: string): Promise<void> {
  const { error } = await supabase
    .from("merchant_staff_service_items")
    .insert({ staff_id: staffId, service_item_id: serviceItemId });
  if (error) throw error;
}

/** 模組 4 規格書 4.4:取消勾選某項服務項目。直接呼叫既有的 RLS 政策即可
 * (模組 3 migration 已經幫 merchant_staff_service_items 補好 DELETE 政策),不需要另開 RPC。 */
export async function removeStaffServiceItem(
  staffId: string,
  serviceItemId: string,
): Promise<void> {
  const { error } = await supabase
    .from("merchant_staff_service_items")
    .delete()
    .eq("staff_id", staffId)
    .eq("service_item_id", serviceItemId);
  if (error) throw error;
}

// =========================================================================
// 3.5-3.9 / 4.3-4.4:客服邀請、移除、權限設定。
// =========================================================================

export interface InviteMerchantAgentInput {
  merchantId: string;
  email: string;
  name: string;
  nickname?: string | null;
  phone?: string | null;
}

export interface InviteMerchantAgentResult {
  agentId: string;
  status: "invited" | "active";
  alreadyHadAccount: boolean;
}

/**
 * 3.5:呼叫 Edge Function invite-merchant-agent。這是本模組唯一一個不打 PostgREST /rpc 端點、
 * 而是打 Edge Function 的操作——因為需要 service_role 權限呼叫 Supabase Auth Admin API,
 * 不能讓前端直接接觸那把金鑰(見規格書 3.5 邊界情況)。
 */
export async function inviteMerchantAgent(
  input: InviteMerchantAgentInput,
): Promise<InviteMerchantAgentResult> {
  const { data, error } = await supabase.functions.invoke("invite-merchant-agent", {
    body: {
      merchant_id: input.merchantId,
      email: input.email.trim(),
      name: input.name.trim(),
      nickname: toNullIfEmpty(input.nickname),
      phone: toNullIfEmpty(input.phone),
    },
  });

  if (error) {
    // supabase.functions.invoke 對非 2xx 回應丟出的 FunctionsHttpError 不含 Edge Function 回傳的
    // JSON 錯誤訊息本文,要另外從 error.context(Response 物件)讀出來,不然只會看到通用的
    // "Edge Function returned a non-2xx status code"。
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
    agent_id: string;
    status: "invited" | "active";
    already_had_account: boolean;
  };
  return {
    agentId: result.agent_id,
    status: result.status,
    alreadyHadAccount: result.already_had_account,
  };
}

/** 3.7/4.3:商家管理員移除客服(軟刪除)。 */
export async function removeMerchantAgent(agentId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_merchant_agent", { p_agent_id: agentId });
  if (error) throw error;
}

/** 3.8:客服完成設定密碼流程後,轉場頁載入時呼叫,把自己所有 invited 狀態的紀錄轉為 active。 */
export async function markAgentActiveIfSelf(): Promise<void> {
  const { error } = await supabase.rpc("mark_agent_active_if_self");
  if (error) throw error;
}

/** 回傳某商家目前所有客服(含已移除,4.3 畫面自行依 status 顯示徽章)。 */
export async function fetchMerchantAgents(merchantId: string): Promise<MerchantAgent[]> {
  const { data, error } = await supabase
    .from("merchant_agents")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MerchantAgent[];
}

/** 4.4:回傳某位客服目前的權限設定(已設定過的 section_key)。 */
export async function fetchAgentPermissions(agentId: string): Promise<MerchantAgentPermission[]> {
  const { data, error } = await supabase
    .from("merchant_agent_permissions")
    .select("*")
    .eq("agent_id", agentId);
  if (error) throw error;
  return (data ?? []) as MerchantAgentPermission[];
}

/** 3.9/4.4:商家管理員逐項開關某位客服的後台功能區塊權限。 */
export async function setAgentPermission(
  agentId: string,
  sectionKey: string,
  granted: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_agent_permission", {
    p_agent_id: agentId,
    p_section_key: sectionKey,
    p_granted: granted,
  });
  if (error) throw error;
}

// =========================================================================
// 5.1:角色判斷用的小工具查詢——回傳目前登入者在某商家「自己的」客服紀錄(若有)。
// 不透過 RLS 疊加額外邏輯,單純查詢 merchant_agents(RLS 已允許 user_id = auth.uid() 讀自己的列)。
// =========================================================================
export async function fetchMyAgentRow(
  merchantId: string,
  userId: string,
): Promise<MerchantAgent | null> {
  const { data, error } = await supabase
    .from("merchant_agents")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as MerchantAgent | null) ?? null;
}
