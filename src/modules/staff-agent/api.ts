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
  // SPECS-INDEX #595/#596:merchant_staff.phone 資料庫層已改為 NOT NULL + 台灣手機號碼格式
  // CHECK 約束(20260922140000_req595_596 migration),型別跟著改成不可為 null,呼叫端(表單)
  // 必須自行保證送進來的是已驗證過的非空字串,這裡不再用 toNullIfEmpty 把空字串靜默轉成 null。
  phone?: string;
  // ⚠️ 這裡原本有一個 contactEmail(merchant_staff.contact_email)。2026-09-24 使用者裁決把它
  // 整個拿掉了(欄位本身也 drop 了,見 migration 20260924040800):
  //   「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
  //   「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
  // 服務人員唯一的 Email 就是登入 Email(auth.users,透過「邀請登入」建立),不要加回來。
  intro?: string | null;
  avatarUrl?: string | null;
  isListed?: boolean;
  advanceBookingDays?: number | null;
  // ⚠️ 這裡原本有一個 bookingWindowMinDays(merchant_staff.booking_window_min_days)。
  // 該欄位已於 2026-09-24 從資料庫移除(migration 20260924040200),「預約天數」三個欄位收斂成
  // advanceBookingDays(最少要提前幾天)+ bookingWindowMaxDays(最遠可預約到幾天後)兩個。
  // 不要加回來。
  bookingWindowMaxDays?: number | null;
  noTimeSlotLimit?: boolean;
  unlimitedBackendEdit?: boolean;
  directAcceptAfterMerchantConfirm?: boolean;
  autoAcceptBooking?: boolean;
  showMemberInfo?: boolean;
  googleCalendarSyncEnabled?: boolean;
  canCreateEditOrders?: boolean;
  canUploadConstructionPhotos?: boolean;
  /** 模組 7(排班與休假管理)§1.1/§4.1:計酬類型,'monthly_salary'(月薪制)/'piece_rate'
   * (按件計酬)。不指定時資料庫層預設回填 'piece_rate'(第〇節判斷 1)。 */
  compensationType?: "monthly_salary" | "piece_rate";
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
      // phone 現在是 NOT NULL 欄位,不能用 toNullIfEmpty(空字串會變成 null 而違反約束)。
      phone: input.phone?.trim() ?? "",
      intro: toNullIfEmpty(input.intro),
      avatar_url: input.avatarUrl ?? null,
      is_listed: input.isListed ?? false,
      advance_booking_days: input.advanceBookingDays ?? null,
      booking_window_max_days: input.bookingWindowMaxDays ?? null,
      no_time_slot_limit: input.noTimeSlotLimit ?? false,
      unlimited_backend_edit: input.unlimitedBackendEdit ?? false,
      direct_accept_after_merchant_confirm: input.directAcceptAfterMerchantConfirm ?? false,
      auto_accept_booking: input.autoAcceptBooking ?? false,
      show_member_info: input.showMemberInfo ?? false,
      google_calendar_sync_enabled: input.googleCalendarSyncEnabled ?? false,
      can_create_edit_orders: input.canCreateEditOrders ?? false,
      can_upload_construction_photos: input.canUploadConstructionPhotos ?? false,
      compensation_type: input.compensationType ?? "piece_rate",
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
    // phone 現在是 NOT NULL 欄位,不能用 toNullIfEmpty——呼叫端傳 phone 這個 key 進來時,
    // 一定要保證是已驗證過的非空字串(見 StaffListPage.tsx §8.1 的表單驗證)。
    ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
    ...(input.intro !== undefined ? { intro: toNullIfEmpty(input.intro) } : {}),
    ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
    ...(input.isListed !== undefined ? { is_listed: input.isListed } : {}),
    ...(input.advanceBookingDays !== undefined
      ? { advance_booking_days: input.advanceBookingDays }
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
    ...(input.compensationType !== undefined ? { compensation_type: input.compensationType } : {}),
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

/** 對應規格書「服務人員管理優化與硬刪除」§3.3/§3.4:真正刪除(硬刪除)一位服務人員。
 * 只能對 status='removed' 的服務人員操作,且資料庫端會檢查四張歷史事實表(訂單/助手身份訂單/
 * 請假紀錄/抽成紀錄)完全沒有牽連才會真的執行,否則回傳清楚列出筆數的中文錯誤訊息(用既有的
 * getErrorMessage() 顯示,不要被截斷或改寫成通用文字)。 */
export async function hardDeleteMerchantStaff(staffId: string): Promise<void> {
  const { error } = await supabase.rpc("hard_delete_merchant_staff", {
    p_staff_id: staffId,
  });
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

// =========================================================================
// 2026-09-24 使用者裁決(客服管理補上「編輯」與「恢復」)。使用者裁決原文:
//   ・客服的聯絡 Email:「客服可自行編輯或管理員可協助編輯。」
//   ・「重新啟用…指的應該是移除後[恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」
//   ・「要做。」
//
// ⚠️⚠️ 同日後續裁決推翻了上面第一條的前提:「聯絡 Email」這個欄位本身被廢除了。原話:
//        「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
//        「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
//      merchant_agents.contact_email 欄位已經 drop(migration 20260924040800),客服唯一的 Email
//      就是登入 Email(merchant_agents.invited_email / auth.users,有自己一套
//      request_agent_login_email_change 流程)。所以「編輯」對話框裡不再有聯絡 Email 欄位。
//
// 對應的資料庫契約:
//   public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text,
//                                p_job_title text) returns merchant_agents
//     → 商家管理員「或客服本人」可呼叫,只開放那四個欄位。
//     ⚠️ 這支函式的簽章變動過兩次,migration 裡把每個舊簽章都 drop 掉了:
//        第一版 5 參數(…p_contact_email)→ 20260924040500 的 6 參數(…p_contact_email, p_job_title)
//        → 20260924040800 的 5 參數(…p_job_title,拿掉 contact_email)。
//        注意最後這一版跟第一版**型別完全相同**(只有第 5 個參數名不同),所以 migration 必須
//        先 drop 才建得起來(create or replace 不允許改參數名),詳見該 migration 的說明。
//        呼叫端從原本「update_merchant_agent + update_my_agent_profile 兩支都呼叫」收斂成
//        單一呼叫,四個欄位在同一個 UPDATE 語句裡,是天然的原子交易,不再需要處理「一半存成功、
//        一半失敗」的部分儲存情境。
//   public.restore_merchant_agent(p_agent_id uuid) returns merchant_agents
//     → 只有商家管理員可呼叫,把 status 從 'removed' 改回 'active'。
//   p_phone 有格式約束(09 開頭 10 碼),函式會回白話中文錯誤訊息(用既有的 getErrorMessage()
//   顯示,不要改寫成通用文字)。
//
// ✅ 這兩支函式已經上線,types.ts 也重新產生過,所以下面兩個呼叫都是一般的 supabase.rpc(...),
//    跟本檔案其他 RPC 呼叫完全一致。

/** 2026-09-24:編輯既有客服的四個欄位(姓名/暱稱/電話/職位)。
 * 商家管理員或客服本人都可以呼叫(權限判斷在資料庫端的 SECURITY DEFINER 函式裡,前端只負責不要
 * 顯示做不到的入口)。刻意「不」開放 invited_email(那是邀請/登入用的信箱,有自己一套
 * request_agent_login_email_change 流程,不能從「編輯基本資料」側面被改掉)。
 * ⚠️ 原本還有第五個欄位 contactEmail(merchant_agents.contact_email),2026-09-24 使用者裁決
 *    「客服和服務人員應該也是一樣只需要一個 Email 即可」之後,欄位本身已經 drop,這裡也移除。
 * 電話格式驗證前端先做一次(isValidTaiwanMobilePhone),資料庫端還會再擋一次,兩層都在。 */
export interface UpdateMerchantAgentInput {
  name: string;
  nickname?: string | null;
  /** 2026-09-24:資料庫端已補上 p_job_title(每個舊簽章都已 drop),所以這支函式現在一次涵蓋
   * 四個欄位,呼叫端不需要再額外呼叫 update_my_agent_profile 去補職位。
   * update_my_agent_profile 已被完全涵蓋、視為廢棄(依主腦指示這次先不刪除那支資料庫函式)。
   *
   * ⚠️ 這個欄位刻意設成「必填」(沒有 `?`),即使它允許 null。原因:這支 RPC 是整列覆蓋,五個
   * 參數每次都會送出,漏送 jobTitle 會讓 toNullIfEmpty(undefined) 回傳 null,把對方原本的職位
   * 靜默清空。設成必填可以把這種資料遺失變成「編譯時就報錯」,強迫每個呼叫端明確決定要寫入什麼
   * (不想改動就把現值原樣傳回來),而不是靠人記得。 */
  jobTitle: string | null;
  /** merchant_agents.phone 是 NOT NULL 欄位(見 types.ts 產生的 Row 型別),所以這裡不用
   * toNullIfEmpty——空字串會變成 null 而違反約束。呼叫端(編輯表單)必須自行保證送進來的是
   * 已經用 isValidTaiwanMobilePhone 驗證過的非空字串,寫法比照本檔案 addMerchantStaff() 對
   * merchant_staff.phone 的既有處理。 */
  phone: string;
}

export async function updateMerchantAgent(
  agentId: string,
  input: UpdateMerchantAgentInput,
): Promise<MerchantAgent> {
  // 既有踩坑(完全比照 staff-portal/api.ts updateMyStaffProfile() 對 update_my_staff_profile 的
  // 既有處理,不自己另發明一套):supabase gen types 對 Postgres text 參數一律推導成 `string`
  // (不是 `string | null`),即使資料庫函式實際上完全能接受 null——這是產生器的已知限制,不是
  // 執行期限制。所以 nickname/jobTitle 這兩個「可以清空」的欄位改傳空字串而不是 null:
  // update_merchant_agent 內部用 nullif(btrim(coalesce(p_xxx, '')), '') 正規化這兩個參數,
  // 空字串跟 null 寫進資料庫的結果完全相同(都是 NULL),行為沒有任何差別。
  const { data, error } = await supabase.rpc("update_merchant_agent", {
    p_agent_id: agentId,
    p_name: input.name.trim(),
    p_nickname: input.nickname ?? "",
    p_phone: input.phone.trim(),
    p_job_title: input.jobTitle ?? "",
  });
  if (error) throw error;
  return data as MerchantAgent;
}

/** 2026-09-24:把已移除(status='removed')的客服恢復成 active。只有商家管理員可以呼叫。
 * 命名上刻意跟畫面上的按鈕文字「恢復」一致(比照 StaffListPage.tsx 服務人員那邊「恢復」按鈕的
 * 既有用語),不叫「重新啟用」——使用者裁決時已經確認這兩個講的是同一件事。 */
export async function restoreMerchantAgent(agentId: string): Promise<MerchantAgent> {
  const { data, error } = await supabase.rpc("restore_merchant_agent", {
    p_agent_id: agentId,
  });
  if (error) throw error;
  return data as MerchantAgent;
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

// =========================================================================
// 模組 14(服務人員端)規格書 5.1/規則 2.10:角色判斷用的小工具查詢——回傳目前登入者在某商家
// 「自己的」服務人員紀錄(若有)。比照上面 fetchMyAgentRow 的既有精神,單純查詢 merchant_staff
// (RLS 已透過 3.3 疊加允許 user_id = auth.uid() 讀自己那一列,不限制 status/login_status,
// 讓被移除的服務人員仍能讀到「自己被移除了」的誠實狀態——規則判斷交給呼叫端自行檢查)。
// =========================================================================
export async function fetchMyStaffRow(
  merchantId: string,
  userId: string,
): Promise<MerchantStaff | null> {
  const { data, error } = await supabase
    .from("merchant_staff")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as MerchantStaff | null) ?? null;
}

// =========================================================================
// 對應規格書「首頁外殼與主題色優化」1.2/1.3:首頁個人資料卡片(客服這一半)。
// =========================================================================

/** @deprecated 2026-09-24 起已無呼叫端,功能被 updateMerchantAgent() 完全涵蓋——
 * update_merchant_agent 補上 p_job_title 之後,一支呼叫就能寫姓名/暱稱/電話/職位,
 * 而且是單一 UPDATE 語句的原子交易。依主腦指示這次「先留著不刪除」(資料庫那支函式也還在),
 * 但不要在新程式碼裡使用它;之後確認沒有其他依賴時可以連同資料庫函式一起移除。
 *
 * 1.3:客服自助編輯自己的暱稱/職位,呼叫 SECURITY DEFINER RPC update_my_agent_profile
 * (資料庫端只檢查呼叫者是不是這筆紀錄本人,不是權限判斷)。姓名沿用既有的 name 欄位,不開放編輯,
 * 這裡只開放 nickname/job_title 兩個欄位,跟資料庫 RPC 的參數一致。 */
export async function updateMyAgentProfile(
  merchantId: string,
  nickname: string,
  jobTitle: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_my_agent_profile", {
    p_merchant_id: merchantId,
    p_nickname: nickname,
    p_job_title: jobTitle,
  });
  if (error) throw error;
}

// =========================================================================
// 對應規格書(帳號登入安全性優化)2.4.1/2.4.2/2.4.3:登入信箱變更機制,服務人員/客服共用一套
// 型別跟包裝函式(兩邊的資料庫函式參數/回傳形狀完全一致,差在 p_staff_id/p_agent_id 這個參數
// 名稱,這裡各自包一層,呼叫端不需要在意底層是哪一支 RPC)。
// =========================================================================

/** 2.4.3 回傳形狀,管理員查詢某位服務人員/客服目前實際的登入信箱與兩種待驗證狀態(規則 2.3.3)。 */
export interface LoginEmailStatus {
  /** 目前真正的登入 email(即時查 auth.users),還沒開通登入的人是 null。 */
  currentLoginEmail: string | null;
  /** 管理員建議的新信箱,本人還沒按套用。 */
  pendingAdminSuggestedEmail: string | null;
  /** 本人已經按套用,Supabase 原生的待驗證新信箱(auth.users.new_email)。 */
  pendingConfirmationEmail: string | null;
  /** 上面那筆待驗證信件的寄出時間(auth.users.email_change_sent_at)。 */
  pendingConfirmationSentAt: string | null;
}

function toLoginEmailStatus(row: {
  current_login_email: string | null;
  pending_admin_suggested_email: string | null;
  pending_confirmation_email: string | null;
  pending_confirmation_sent_at: string | null;
}): LoginEmailStatus {
  return {
    currentLoginEmail: row.current_login_email,
    pendingAdminSuggestedEmail: row.pending_admin_suggested_email,
    pendingConfirmationEmail: row.pending_confirmation_email,
    pendingConfirmationSentAt: row.pending_confirmation_sent_at,
  };
}

/** 2.4.1:商家管理員建議服務人員的新登入信箱(只寫入 pending 欄位,不寄出任何信件,規則 2.3.1)。 */
export async function requestStaffLoginEmailChange(
  staffId: string,
  newEmail: string,
): Promise<void> {
  const { error } = await supabase.rpc("request_staff_login_email_change", {
    p_staff_id: staffId,
    p_new_email: newEmail,
  });
  if (error) throw error;
}

/** 2.4.1:商家管理員建議客服的新登入信箱,設計理由完全比照 requestStaffLoginEmailChange。 */
export async function requestAgentLoginEmailChange(
  agentId: string,
  newEmail: string,
): Promise<void> {
  const { error } = await supabase.rpc("request_agent_login_email_change", {
    p_agent_id: agentId,
    p_new_email: newEmail,
  });
  if (error) throw error;
}

/** 2.4.2:管理員撤回建議,或服務人員本人套用/忽略建議後清除這筆紀錄。 */
export async function clearStaffPendingLoginEmail(staffId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_staff_pending_login_email", {
    p_staff_id: staffId,
  });
  if (error) throw error;
}

/** 2.4.2:客服版本,設計理由完全比照 clearStaffPendingLoginEmail。 */
export async function clearAgentPendingLoginEmail(agentId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_agent_pending_login_email", {
    p_agent_id: agentId,
  });
  if (error) throw error;
}

/** 2.4.3:管理員查詢某位服務人員目前的登入信箱狀態(人員管理頁 2.5.3 用)。 */
export async function fetchStaffLoginEmailStatus(staffId: string): Promise<LoginEmailStatus> {
  const { data, error } = await supabase
    .rpc("get_staff_login_email_status", { p_staff_id: staffId })
    .single();
  if (error) throw error;
  return toLoginEmailStatus(data);
}

/** 2.4.3:客服版本,設計理由完全比照 fetchStaffLoginEmailStatus。 */
export async function fetchAgentLoginEmailStatus(agentId: string): Promise<LoginEmailStatus> {
  const { data, error } = await supabase
    .rpc("get_agent_login_email_status", { p_agent_id: agentId })
    .single();
  if (error) throw error;
  return toLoginEmailStatus(data);
}
