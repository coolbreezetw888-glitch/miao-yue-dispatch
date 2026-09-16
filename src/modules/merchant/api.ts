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
  address?: string | null;
  contactEmail?: string | null;
  intro?: string | null;
  themePreset?: string | null;
  themeCustomColor?: string | null;
  announcementEnabled?: boolean;
  announcementContent?: string | null;
  logoUrl?: string | null;
}

/**
 * 4.2 商家設定頁存檔。刻意不接受 industryType 參數 —— industry_type 建立後鎖定(規則 2.1),
 * 這裡連欄位都不開放傳入，從介面設計上直接排除誤用的可能，資料庫層的 trigger 是最後一道防線。
 */
export async function updateMerchantSettings(
  merchantId: string,
  input: UpdateMerchantSettingsInput,
): Promise<void> {
  const payload: TablesUpdate<"merchants"> = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
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

/** 5.4 對外介面:回傳某商家目前的管理員名單(含 email),供模組 3 直接複用查詢邏輯。 */
export async function fetchMerchantAdminUsers(merchantId: string): Promise<MerchantAdminUser[]> {
  const { data, error } = await supabase.rpc("get_merchant_admin_users", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as MerchantAdminUser[];
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
