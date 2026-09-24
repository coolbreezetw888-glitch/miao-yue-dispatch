// 模組 2:超級管理員/平台管理後台(核心層)— 資料存取層
// 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\超級管理員後台.md
//
// 分工原則(規則 2.3、5.1):商家/集團的既有讀寫盡量沿用模組 1(@/modules/merchant/api、
// @/modules/merchant/context)現成的函式，不重工。這裡只放本模組專屬、模組 1 沒有的東西:
// 平台管理員身份查詢、代客服新增/移除管理員、集團管理者設定、產業預設功能組合的寫入，
// 以及兩個規格書沒有明列、但介面 4.3/4.5 需要的小型補充讀取函式(見下方註解)。

import { supabase } from "@/integrations/supabase/client";
import type { IndustryType } from "@/modules/merchant/types";
import type { IndustryFeaturePresetRow, PlatformGroupRow, PlatformMerchantRow } from "./types";

/**
 * 這次品管抓到的 bug 的根本原因與修法(見 getErrorMessage.ts 開頭更詳細的說明):
 * `await supabase.rpc(...)` / `await supabase.from(...).xxx()` 用「不丟例外、回傳
 * { data, error }」的預設呼叫方式時,`error` 欄位不是 `PostgrestError` 的實例,只是
 * `JSON.parse()` PostgREST 回應 body 出來的一般物件(有 message/details/hint/code 屬性,
 * 但 `instanceof Error` 是 false)。本檔案原本每個函式都寫 `if (error) throw error`,
 * 丟出去的就是這種「形狀對但不是 Error 子類別」的一般物件,導致畫面上
 * `err instanceof Error ? err.message : "請稍後再試"` 這種寫法永遠拿不到真正的訊息。
 *
 * 修法:資料存取層(這裡)統一把 Supabase 回傳的 error 轉成真正的 Error 子類別再丟出去,
 * 這樣不管上層 catch 區塊怎麼判斷 instanceof Error,都能正確拿到資料庫回傳的訊息文字
 * (例如規則 2.4/2.5 的防呆訊息、3.4 的「查無此 email」訊息)。
 */
class SupabaseCallError extends Error {
  // 這個專案開了 tsconfig 的 `exactOptionalPropertyTypes: true`,在這個模式下「可選屬性」
  // (`code?: string`)只允許「整個屬性不存在」,不允許「屬性存在但值是 undefined」。
  // 下面建構子是無條件做 `this.code = error.code` 賦值的(來源本身就可能是 undefined),
  // 所以型別要明確寫成 `string | undefined`,才等於「這個屬性可以不存在,存在時也可以是 undefined」。
  code?: string | undefined;
  details?: string | undefined;
  hint?: string | undefined;

  constructor(error: { message: string; code?: string; details?: string; hint?: string }) {
    super(error.message);
    this.name = "SupabaseCallError";
    this.code = error.code;
    this.details = error.details;
    this.hint = error.hint;
  }
}

function throwSupabaseError(error: {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}): never {
  throw new SupabaseCallError(error);
}

/** 規則 2.2/功能 3.2:前端呼叫，決定要不要顯示超級管理員後台入口/放行路由。
 * 這只是體驗層路由守衛，不是安全邊界，真正的安全邊界是疊加了 is_platform_admin() 的 RLS 政策。 */
export async function amIPlatformAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("am_i_platform_admin");
  if (error) throwSupabaseError(error);
  return Boolean(data);
}

/**
 * 介面 4.3:回傳系統裡「全部」商家(含集團名稱),語意跟模組 1 的 fetchAccessibleMerchants()
 * (我能存取的)不同,沿用同一張 merchants 表查詢,受 3.7 疊加後的 RLS 政策保護。
 *
 * 管理員人數欄位另外呼叫 platform_get_merchant_admin_counts() 補上 —— 規則 2.3 刻意不疊加
 * merchant_admins 的 RLS,平台管理員直接對 merchant_admins 做 embedded count 查詢會被既有政策
 * 擋下(只看得到自己直接管理的商家筆數)。這個函式不是規格書 3.1-3.8 明列的項目,是工程師實作
 * 時發現的缺口,已在回報中向主腦/使用者說明。
 */
export async function platformFetchAllMerchants(): Promise<PlatformMerchantRow[]> {
  const [{ data, error }, { data: countsData, error: countsError }] = await Promise.all([
    supabase
      .from("merchants")
      .select("*, group:groups(id, name)")
      .order("created_at", { ascending: true }),
    supabase.rpc("platform_get_merchant_admin_counts"),
  ]);

  if (error) throwSupabaseError(error);
  if (countsError) throwSupabaseError(countsError);

  const countByMerchantId = new Map<string, number>(
    (countsData ?? []).map((row) => [row.merchant_id, row.admin_count]),
  );

  return (data ?? []).map((row) => ({
    ...row,
    group: row.group as { id: string; name: string | null } | null,
    admin_count: countByMerchantId.get(row.id) ?? 0,
  })) as unknown as PlatformMerchantRow[];
}

/** 介面 4.4:單一商家詳情,沿用同一張 merchants 表查詢,受 3.7 疊加後的 RLS 政策保護。 */
export async function platformFetchMerchantById(
  merchantId: string,
): Promise<PlatformMerchantRow | null> {
  const { data, error } = await supabase
    .from("merchants")
    .select("*, group:groups(id, name)")
    .eq("id", merchantId)
    .maybeSingle();

  if (error) throwSupabaseError(error);
  if (!data) return null;
  return {
    ...data,
    group: data.group as { id: string; name: string | null } | null,
    admin_count: 0,
  } as unknown as PlatformMerchantRow;
}

/** 介面 4.5:讀取商家所屬集團的基本資料(含集團管理者 user_id),沿用 groups 表查詢,
 * 受 3.7 疊加後的 RLS 政策保護。 */
export async function platformFetchGroupById(groupId: string): Promise<PlatformGroupRow | null> {
  const { data, error } = await supabase
    .from("groups")
    .select("id, name, group_admin_user_id")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throwSupabaseError(error);
  return data;
}

/**
 * 介面 4.5 補充讀取函式:把 group_admin_user_id 轉成可顯示的 email。
 * 比照模組 1「auth.users 不能被前端直接 join」的原則,前端不能直接查 auth.users,
 * 這裡呼叫 platform_get_user_email() RPC(SECURITY DEFINER,內部先檢查 is_platform_admin())。
 * 同 platformFetchAllMerchants 的管理員人數,這個函式不是規格書 3.1-3.8 明列的項目。
 */
export async function platformGetUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("platform_get_user_email", { p_user_id: userId });
  if (error) throwSupabaseError(error);
  return data ?? null;
}

/** 功能 3.4:超級管理員代替商家新增管理員(對方必須已經是秒約註冊帳號)。 */
export async function platformAddMerchantAdmin(
  merchantId: string,
  userEmail: string,
): Promise<void> {
  const { error } = await supabase.rpc("platform_add_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_email: userEmail.trim(),
  });
  if (error) throwSupabaseError(error);
}

/** 功能 3.5:超級管理員代替商家移除管理員。規則 2.4 的防呆檢查(不能移到沒人能管)在資料庫端。 */
export async function platformRemoveMerchantAdmin(
  merchantId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc("platform_remove_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_id: userId,
  });
  if (error) throwSupabaseError(error);
}

/** 功能 3.6:超級管理員代替集團指定/清空集團管理者。userEmail 傳 null 代表清空。
 * 規則 2.5 的防呆檢查(清空後不能讓某間商家沒人能管)在資料庫端。 */
export async function platformSetGroupAdmin(
  groupId: string,
  userEmail: string | null,
): Promise<void> {
  const trimmedEmail = userEmail && userEmail.trim().length > 0 ? userEmail.trim() : null;
  const { error } = await supabase.rpc("platform_set_group_admin", {
    p_group_id: groupId,
    // 這裡的 `as unknown as string` 不是在掩蓋真正的型別錯誤,是在繞過型別產生器的限制:
    // PostgreSQL 的函式簽章沒有辦法表達「這個參數允許傳 null」(參數型別就只是 text),
    // 所以 Supabase 自動產生的 src/integrations/supabase/types.ts 一律把 p_user_email 標成
    // `string`。但 platform_set_group_admin 這支函式的設計本來就是「傳 null 代表清空集團
    // 管理者」(見上方註解與資料庫端函式說明),null 一定要真的送出去,不能改成空字串或省略,
    // 否則會變成「把集團管理者設成空字串帳號」而不是清空。
    // 只做型別層的斷言,runtime 行為完全不變。
    p_user_email: trimmedEmail as unknown as string,
  });
  if (error) throwSupabaseError(error);
}

/** 介面 4.6:讀取全部產業預設功能組合(不分產業,前端自行依 industry_type 分組顯示)。 */
export async function fetchIndustryFeaturePresets(): Promise<IndustryFeaturePresetRow[]> {
  const { data, error } = await supabase
    .from("industry_feature_presets")
    .select("*")
    .order("industry_type", { ascending: true })
    .order("feature_key", { ascending: true });
  if (error) throwSupabaseError(error);
  return (data ?? []) as IndustryFeaturePresetRow[];
}

/** 介面 4.6:新增一項產業預設功能組合。受功能 3.8 的 RLS 政策保護(只有平台管理員能寫入)。 */
export async function createIndustryFeaturePreset(input: {
  industryType: IndustryType;
  featureKey: string;
  defaultEnabled: boolean;
}): Promise<void> {
  const { error } = await supabase.from("industry_feature_presets").insert({
    industry_type: input.industryType,
    feature_key: input.featureKey.trim(),
    default_enabled: input.defaultEnabled,
  });
  if (error) throwSupabaseError(error);
}

/** 介面 4.6:切換某一項預設值的開關。受功能 3.8 的 RLS 政策保護。 */
export async function updateIndustryFeaturePresetEnabled(
  id: string,
  defaultEnabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("industry_feature_presets")
    .update({ default_enabled: defaultEnabled })
    .eq("id", id);
  if (error) throwSupabaseError(error);
}

/** 介面 4.6:刪除一項產業預設功能組合。規則 2.6 判斷結論:不算危險操作,不需要 JSON 備份。 */
export async function deleteIndustryFeaturePreset(id: string): Promise<void> {
  const { error } = await supabase.from("industry_feature_presets").delete().eq("id", id);
  if (error) throwSupabaseError(error);
}
