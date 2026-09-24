// 模組 1:商家與集團管理 — 資料存取層
// 這裡是唯一直接呼叫 supabase.from('merchants' / 'groups' / 'merchant_admins' / 'merchant_feature_flags')
// 或 supabase.rpc(...) 的地方。其他模組不應該直接操作這幾張表(見規格書第五節「對外介面」說明),
// 一律透過 context.tsx 匯出的 hooks，或視需要直接 import 這個檔案裡的函式。

import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type { IndustryType, MerchantAdminUser, MerchantWithGroup } from "./types";

export const MERCHANT_LOGO_BUCKET = "merchant-logos";
/** 規則 2.6:LOGO 上傳格式與大小限制。 */
export const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;
export const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

function toUndefinedIfEmpty(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 5.2 對外介面:回傳目前使用者能存取的所有商家清單(含所屬集團基本資料)。 */
export async function fetchAccessibleMerchants(): Promise<MerchantWithGroup[]> {
  const { data, error } = await supabase
    .from("merchants")
    .select("*, group:groups(id, name)")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as MerchantWithGroup[];
}

export interface CreateGroupAndMerchantInput {
  name: string;
  industryType: IndustryType;
  address?: string;
  contactEmail?: string;
  intro?: string;
}

/**
 * tsconfig 開了 exactOptionalPropertyTypes，RPC 的 Args 型別裡 `p_address?: string` 這類
 * 選填參數不能直接被賦值 `undefined` —— 要嘛整個 key 不出現，要嘛給一個真正的 string。
 * 這個小工具依此規則組出乾淨的 optional 欄位物件，避免每個呼叫點都要重複同樣的 spread 技巧。
 */
function optionalTextField(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/** 3.2:Onboarding(4.1)呼叫的 RPC,原子性建立集團+第一間商家。 */
export async function createGroupAndMerchant(input: CreateGroupAndMerchantInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_group_and_merchant", {
    p_name: input.name.trim(),
    p_industry_type: input.industryType,
    ...optionalTextField("p_address", toUndefinedIfEmpty(input.address)),
    ...optionalTextField("p_contact_email", toUndefinedIfEmpty(input.contactEmail)),
    ...optionalTextField("p_intro", toUndefinedIfEmpty(input.intro)),
  });

  if (error) throw error;
  return data as string;
}

export interface CreateMerchantInGroupInput extends CreateGroupAndMerchantInput {
  groupId: string;
}

/** 3.3:新增分店流程(4.4)呼叫的 RPC,原子性新增分店。 */
export async function createMerchantInGroup(input: CreateMerchantInGroupInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_merchant_in_group", {
    p_group_id: input.groupId,
    p_name: input.name.trim(),
    p_industry_type: input.industryType,
    ...optionalTextField("p_address", toUndefinedIfEmpty(input.address)),
    ...optionalTextField("p_contact_email", toUndefinedIfEmpty(input.contactEmail)),
    ...optionalTextField("p_intro", toUndefinedIfEmpty(input.intro)),
  });

  if (error) throw error;
  return data as string;
}

export interface UpdateMerchantSettingsInput {
  name?: string;
  industryType?: IndustryType;
  address?: string | null;
  phone?: string | null;
  contactEmail?: string | null;
  intro?: string | null;
  themePreset?: string | null;
  themeCustomColor?: string | null;
  announcementEnabled?: boolean;
  announcementContent?: string | null;
  logoUrl?: string | null;
}

/**
 * 4.2 商家設定頁存檔。
 * 2026-09-23 使用者推翻原本的規則 2.1(industry_type 建立後鎖定):資料庫層的
 * merchants_lock_industry_type trigger 已拿掉(見 migration
 * 20260923040000_allow_industry_type_change),這裡因此開放接受 industryType 參數,
 * 商家管理員可在設定頁隨時切換。唯一受影響的既有行為是 private.industry_requires_customer_address()
 * (新增/編輯預約時客戶地址欄位是否顯示/必填),不影響既有訂單資料。
 */
export async function updateMerchantSettings(
  merchantId: string,
  input: UpdateMerchantSettingsInput,
): Promise<void> {
  const payload: TablesUpdate<"merchants"> = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.industryType !== undefined ? { industry_type: input.industryType } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.contactEmail !== undefined ? { contact_email: input.contactEmail } : {}),
    ...(input.intro !== undefined ? { intro: input.intro } : {}),
    ...(input.themePreset !== undefined ? { theme_preset: input.themePreset } : {}),
    ...(input.themeCustomColor !== undefined ? { theme_custom_color: input.themeCustomColor } : {}),
    ...(input.announcementEnabled !== undefined
      ? { announcement_enabled: input.announcementEnabled }
      : {}),
    ...(input.announcementContent !== undefined
      ? { announcement_content: input.announcementContent }
      : {}),
    ...(input.logoUrl !== undefined ? { logo_url: input.logoUrl } : {}),
  };

  const { error } = await supabase.from("merchants").update(payload).eq("id", merchantId);
  if (error) throw error;
}

/** 規則 2.2:軟刪除(停用)。真正的「至少保留一間啟用中商家」檢查在資料庫 trigger,這裡只是發出 UPDATE。 */
export async function disableMerchant(merchantId: string): Promise<void> {
  const { error } = await supabase
    .from("merchants")
    .update({ status: "disabled" })
    .eq("id", merchantId);
  if (error) throw error;
}

export async function enableMerchant(merchantId: string): Promise<void> {
  const { error } = await supabase
    .from("merchants")
    .update({ status: "active" })
    .eq("id", merchantId);
  if (error) throw error;
}

/**
 * 規則 2.6:LOGO 上傳格式與大小限制 —— 前端要在送出前擋下，不要送到 Storage 才失敗。
 * 回傳 null 代表通過驗證，否則回傳可以直接顯示給使用者的錯誤訊息。
 */
export function validateLogoFile(file: File): string | null {
  if (!ALLOWED_LOGO_MIME_TYPES.includes(file.type as (typeof ALLOWED_LOGO_MIME_TYPES)[number])) {
    return "只能上傳 PNG、JPG 或 WEBP 格式的圖片";
  }
  if (file.size > MAX_LOGO_SIZE_BYTES) {
    return "檔案大小不能超過 2MB，請壓縮後再上傳";
  }
  return null;
}

/** 3.5:上傳商家 LOGO。路徑慣例 `<merchant_id>/<檔名>`,對應 Storage RLS 政策的解析邏輯。 */
export async function uploadMerchantLogo(merchantId: string, file: File): Promise<string> {
  const validationError = validateLogoFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const ext = file.name.includes(".") ? file.name.split(".").pop() : "png";
  const path = `${merchantId}/logo-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(MERCHANT_LOGO_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(MERCHANT_LOGO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** 5.4 對外介面:回傳某商家目前的管理員名單,供模組 3 直接複用查詢邏輯。
 * 2026-09-24:這支 RPC 的回傳新增了 display_name/job_title/phone 三個欄位
 * (嚴格超集,非破壞性),讓管理員名單能顯示「暱稱 / 手機 / Email」而不是只有一個 email。
 * 那個 Email 就是 `email`(登入帳號,來自 auth.users)——使用者裁決一個人只有一個 Email,
 * merchant_admins 沒有 contact_email 欄位。
 * ⚠️ 這三個欄位對既有管理員都可能是 null(資料庫端刻意不做 coalesce,見 migration
 * 20260924040700 的 comment),本地的 MerchantAdminUser 型別因此宣告成 `string | null`。
 * 自動產生的 types.ts 把 RETURNS TABLE 的欄位一律推導成非 nullable(產生器的已知限制,
 * 它看不出哪些欄位可能是 null),那個型別比真實情況窄,所以這裡用 `as` 放寬到真實形狀即可,
 * 不需要 `as unknown as`。 */
export async function fetchMerchantAdminUsers(merchantId: string): Promise<MerchantAdminUser[]> {
  const { data, error } = await supabase.rpc("get_merchant_admin_users", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as MerchantAdminUser[];
}

// =========================================================================
// 對應規格書「首頁外殼與主題色優化」1.2/1.3:首頁個人資料卡片(管理員這一半)。
// =========================================================================

export interface MyAdminProfile {
  displayName: string | null;
  jobTitle: string | null;
  /** 2026-09-24 使用者新裁決(管理員也要能填電話):原話「我認為需要,因為這會影響到
   * 整個系統判斷這個管理員與集團的關聯或者這個管理員在系統內的資料(以我這個廠商視角)」——
   * 他是平台方,要能掌握每位商家管理員的聯絡方式。
   * ⚠️ merchant_admins.phone 是 nullable(既有管理員沒有這個值),所以這個欄位在畫面上是
   * 「選填」,不要照抄客服/服務人員那邊的必填邏輯。
   * ⚠️ 這裡刻意**沒有** contactEmail:同日使用者裁決「登入和聯絡信箱應該要是一致的(所以理論上
   * 不該出現不同的信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」一個人只有一個
   * Email,就是登入 Email(從 supabase.auth 的 session / auth.users 讀,不在這個 profile 裡)。 */
  phone: string | null;
}

/**
 * 首頁個人資料卡片用:讀取目前登入者自己在指定商家的 display_name/job_title。
 * 直接查 merchant_admins(既有 SELECT 政策 is_merchant_admin(merchant_id) 已經足夠讓管理員看到
 * 這間店所有管理員的列,包含自己這一列,不需要另開 RPC)——但這張表一間店可能有多位管理員,
 * 一定要多帶 eq('user_id', userId) 篩出「自己」這一列,不能只憑 merchant_id 篩選,否則
 * .maybeSingle() 在多位管理員時會直接報錯,也會抓錯人的資料。
 * 找不到列(理論上不會發生,呼叫端只在確認角色是 admin 時才會呼叫)回傳 null。
 */
export async function fetchMyAdminProfile(
  merchantId: string,
  userId: string,
): Promise<MyAdminProfile | null> {
  // 只讀這張卡片真正用得到的三個欄位(比照本檔案其他查詢的既有慣例,用具名 select 而不是 `*`,
  // 避免多搬一整列欄位、也讓「這個畫面依賴哪些欄位」一眼可讀)。
  // ⚠️ display_name / job_title / phone 三個欄位在資料庫裡本來就是 nullable(既有管理員從來沒有
  // 被強迫填過,phone 更是 2026-09-24 才新增的欄位),所以下面直接沿用它們的 null——
  // MyAdminProfile 三個欄位都宣告成 `string | null`,這個 null 是真實資料狀態,不是防禦性補值,
  // 畫面上的 fallback 文字由呼叫端負責(見 MerchantSettingsPage / 首頁個人資料卡片)。
  const { data, error } = await supabase
    .from("merchant_admins")
    .select("display_name, job_title, phone")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    displayName: data.display_name,
    jobTitle: data.job_title,
    phone: data.phone,
  };
}

/** 1.3:管理員自助編輯自己的姓名/職位/電話,呼叫 SECURITY DEFINER RPC
 * update_my_admin_profile(資料庫端只檢查呼叫者是不是這筆紀錄本人,不是權限判斷)。
 *
 * ⚠️ 2026-09-24 破壞性改動:這支 RPC 從 3 參數變成 4 參數,**舊的 3 參數重載已經被 drop**
 * (避免 PostgREST 解析到孤兒重載)。新簽章的參數順序是:
 *     p_merchant_id, p_display_name, p_job_title, p_phone
 * 下面送出的四個 key 跟它逐一對應,數量與名稱完全一致。
 * ⚠️ 開發過程中曾短暫有過一個 5 參數版本(多一個 p_contact_email),同日被使用者推翻:
 *    「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」——一個人只有一個 Email,
 *    就是登入 Email。那個 5 參數簽章也在 migration 裡一併 drop 掉了,不要再送 p_contact_email。
 * phone 是 nullable 欄位(「清空」是合法操作),所以這裡的參數型別保持 `string | null`,
 * 由呼叫端決定要寫入號碼還是清空。 */
export async function updateMyAdminProfile(
  merchantId: string,
  displayName: string,
  jobTitle: string,
  phone: string | null,
): Promise<void> {
  // 既有踩坑(比照 staff-portal/api.ts updateMyStaffProfile() 對 update_my_staff_profile 的既有
  // 處理,不自己另發明一套):supabase gen types 對 Postgres text 參數一律推導成 `string`
  // (不是 `string | null`),即使資料庫函式實際上完全能接受 null——這是產生器的已知限制,不是
  // 執行期限制。所以「清空電話」這件事在這裡送空字串而不是 null:update_my_admin_profile 內部用
  // nullif(btrim(coalesce(p_phone, '')), '') 正規化,空字串跟 null 寫進資料庫的結果完全相同
  // (都是 NULL,而且都會跳過 ^09\d{8}$ 格式檢查),行為沒有任何差別。
  const { error } = await supabase.rpc("update_my_admin_profile", {
    p_merchant_id: merchantId,
    p_display_name: displayName,
    p_job_title: jobTitle,
    p_phone: phone ?? "",
  });
  if (error) throw error;
}

/** 5.3 對外介面:讀取某個功能開關目前的值。找不到列時視為「未設定」,回傳 null。 */
export async function getFeatureFlag(
  merchantId: string,
  featureKey: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("merchant_feature_flags")
    .select("enabled")
    .eq("merchant_id", merchantId)
    .eq("feature_key", featureKey)
    .maybeSingle();

  if (error) throw error;
  return data?.enabled ?? null;
}

/**
 * 5.3 對外介面:寫入某個功能開關的值。
 *
 * 2026-09-16 品管打回修正(SPECS-INDEX 編號 123/127/142):模組 5 是第一個真的呼叫這支函式
 * 「寫入」的模組(`/app/business-hours` 頁面的「嚴格工時衝突檢查」開關)。新商家的
 * `merchant_feature_flags` 一開始是 0 筆，原本這裡只用 `.update()`，UPDATE 影響 0 筆但
 * Supabase 不會因此報錯，導致前端誤以為寫入成功，實際上資料庫完全沒有這一筆列。
 * 改成 upsert(以 `merchant_id, feature_key` 這組 unique 約束當 onConflict 目標，見
 * migration `20260915100000_merchant_group_schema.sql` 1.4 節的 `unique (merchant_id, feature_key)`），
 * 讓新商家第一次設定任何功能開關時能正確新增一筆，已有資料的商家再次修改時則正確更新既有列、
 * 不會意外新增重複列。
 *
 * 對應的 RLS 政策見 `20260916150000_merchant_feature_flags_insert_policy.sql`——
 * 原本只有 UPDATE 政策(`merchant_feature_flags_update`，比照 `can_manage_business_hours`)，
 * 這次一併補上同樣判斷條件的 INSERT 政策，upsert 底層的 INSERT 分支才不會被 RLS 擋下。
 */
export async function setFeatureFlag(
  merchantId: string,
  featureKey: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: merchantId, feature_key: featureKey, enabled },
      { onConflict: "merchant_id,feature_key" },
    );
  if (error) throw error;
}
