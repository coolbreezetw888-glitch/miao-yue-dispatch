// 模組 10:會員與紅利 — 資料存取層 + 第五節「對外介面」。
// 這裡是唯一直接呼叫 supabase.from('members' / 'merchant_member_settings' /
// 'member_point_transactions') 或 supabase.rpc('create_member' / 'update_member' / ...) 的地方。
// 其他模組不應該直接操作這三張表(規格書第五節「對外介面」),一律 import 這個檔案匯出的
// hooks/functions(比照模組 8 api.ts 把 hooks 跟底層 supabase 呼叫放同一個檔案的既有簡化慣例)。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3/4/5/6/7/8/9 已經確立的踩坑):`error` 不是真正的 Error 實例,
// 一律用 `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import type {
  BirthdayBonusGrant,
  BirthdayLineStatus,
  EarnMode,
  Member,
  MemberDetail,
  MemberPhoneMatchCandidate,
  MemberPointHistoryEntry,
  MemberPointTransactionType,
  MemberReferral,
  MemberRelatedBooking,
  MemberStatus,
  MemberSummary,
  MemberTierStatus,
  MerchantMemberSettings,
  MerchantMemberTier,
  MerchantPointFormula,
  PointFormulaServiceItem,
  RewardConditionMode,
} from "./types";
import { DEFAULT_MERCHANT_MEMBER_SETTINGS } from "./types";
import { stabilizePointHistoryOrder } from "./memberPointHistoryOrder";

// =========================================================================
// §3.2/§5.x:merchant_member_settings 讀寫。不包 RPC,直接開放 RLS,前端 upsert。
// =========================================================================
export async function fetchMerchantMemberSettings(
  merchantId: string,
): Promise<MerchantMemberSettings | null> {
  const { data, error } = await supabase
    .from("merchant_member_settings")
    .select("*")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** 對外介面:回傳某商家目前的會員設定;查無資料(還沒特別設定過)時 fallback 成預設值。 */
export function useMerchantMemberSettings(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantMemberSettings | typeof DEFAULT_MERCHANT_MEMBER_SETTINGS> {
  return useQuery({
    queryKey: ["members-module", "merchant-member-settings", merchantId],
    queryFn: async () => {
      const row = await fetchMerchantMemberSettings(merchantId as string);
      return row ?? DEFAULT_MERCHANT_MEMBER_SETTINGS;
    },
    enabled: Boolean(merchantId),
  });
}

/**
 * 紅利系統重構 批次 7(v2.4 裁決 21 ①):會員詳情頁判斷「紅利功能開沒開」的唯一來源。
 *
 * 🔴 為什麼不能用 useMerchantMemberSettings:merchant_member_settings 的 SELECT 政策只放行
 *    member_points / member_settings 這類「規則」鑰匙,**不放行 members 鑰匙**。只有 members 鑰匙的客服
 *    打開會員詳情頁時,RLS 查無列 ⇒ hook 退回預設值 points_feature_enabled = true ⇒ 功能明明關了,
 *    點數卡片卻顯示出來(QA 2026-10-01 截圖重現,正式庫現況即如此)。
 *    改由 SECURITY DEFINER 的 get_merchant_points_feature_enabled 回傳一個布林(members 或
 *    member_points 鑰匙任一即可),不放寬表政策。
 */
export async function fetchMerchantPointsFeatureEnabled(merchantId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_merchant_points_feature_enabled", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return data === true;
}

export function useMerchantPointsFeatureEnabled(
  merchantId: string | null | undefined,
): UseQueryResult<boolean> {
  return useQuery({
    queryKey: ["members-module", "points-feature-enabled", merchantId],
    queryFn: () => fetchMerchantPointsFeatureEnabled(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/**
 * 紅利系統重構 批次 6(§3.14):`merchant_member_settings` 的寫入改成**局部 patch**。
 *
 * 🔴 為什麼不再是「整列 upsert」:原本的 `upsertMerchantMemberSettings` 要求呼叫端把**每一個**欄位都帶上,
 *    兩個頁面(紅利點數管理 / 會員系統設定)各自從自己手上的 settings 抄一份整列送回去。紅利系統重構一口氣
 *    多了 13 個欄位,只要任何一頁漏帶一欄,整列 upsert 就會把那一欄**默默寫回預設值**(規格書 §3.14 點名的
 *    「整列 upsert 模式的固有陷阱」)。
 *    改成:呼叫端只送「這次真的要改的欄位」。PostgREST 的 upsert(merge-duplicates)只會更新 payload 裡有的
 *    欄位,沒帶的欄位維持資料庫裡的值 —— 達到規格書要的「先讀再寫」效果(不會把別的欄位洗回預設),
 *    而且連「拿過時的值整列寫回去」的競態都一起消失(兩個分頁各存各的欄位,不會互相蓋掉)。
 *    第一次存(還沒有設定列)時走 INSERT,沒帶的欄位吃 schema 預設值 —— 跟 seed_default_member_settings 一致。
 *
 * ⚠️ 權限邊界不變:資料庫的 protect_merchant_member_settings_rule_columns trigger 只看「值有沒有真的變」,
 *    會員系統設定頁只送政策兩欄,本來就不會碰到規則欄位的檢查。
 */
export interface MerchantMemberSettingsPatch {
  /** #617:商家是否啟用紅利點數功能。 */
  pointsFeatureEnabled?: boolean;
  rewardConditionMode?: RewardConditionMode;
  // §1.1 A 紅利計算
  earnMode?: EarnMode;
  basicPointsPerOrder?: number;
  basicMinAmount?: number;
  basicTieredEnabled?: boolean;
  // §1.1 B 點數使用
  redeemPointsUnit?: number;
  redeemAmountUnit?: number;
  redeemMaxRatioPercent?: number;
  // §1.1 C 推薦系統
  referralInviterRewardEnabled?: boolean;
  referralBonusPoints?: number;
  referralSubsequentBonusPoints?: number;
  referralInviterEarningEnabled?: boolean;
  referralInviteeEarningEnabled?: boolean;
  // §1.1 D 生日獎勵
  birthdayBonusEnabled?: boolean;
  birthdayBonusPoints?: number;
  birthdayLineMessage?: string;
  // 會員政策(會員系統設定頁)
  policyEnabled?: boolean;
  policyContent?: string | null;
}

const SETTINGS_PATCH_COLUMNS: Record<
  keyof MerchantMemberSettingsPatch,
  keyof TablesInsert<"merchant_member_settings">
> = {
  pointsFeatureEnabled: "points_feature_enabled",
  rewardConditionMode: "reward_condition_mode",
  earnMode: "earn_mode",
  basicPointsPerOrder: "basic_points_per_order",
  basicMinAmount: "basic_min_amount",
  basicTieredEnabled: "basic_tiered_enabled",
  redeemPointsUnit: "redeem_points_unit",
  redeemAmountUnit: "redeem_amount_unit",
  redeemMaxRatioPercent: "redeem_max_ratio_percent",
  referralInviterRewardEnabled: "referral_inviter_reward_enabled",
  referralBonusPoints: "referral_bonus_points",
  referralSubsequentBonusPoints: "referral_subsequent_bonus_points",
  referralInviterEarningEnabled: "referral_inviter_earning_enabled",
  referralInviteeEarningEnabled: "referral_invitee_earning_enabled",
  birthdayBonusEnabled: "birthday_bonus_enabled",
  birthdayBonusPoints: "birthday_bonus_points",
  birthdayLineMessage: "birthday_line_message",
  policyEnabled: "policy_enabled",
  policyContent: "policy_content",
};

/** 純函式:把 patch 轉成資料庫欄位。`undefined` 的欄位**不放進 payload**(那就是「不改」)。 */
export function buildMerchantMemberSettingsPayload(
  merchantId: string,
  patch: MerchantMemberSettingsPatch,
): TablesInsert<"merchant_member_settings"> {
  const row: Record<string, unknown> = { merchant_id: merchantId };
  for (const key of Object.keys(SETTINGS_PATCH_COLUMNS) as (keyof MerchantMemberSettingsPatch)[]) {
    const value = patch[key];
    if (value !== undefined) row[SETTINGS_PATCH_COLUMNS[key]] = value;
  }
  return row as TablesInsert<"merchant_member_settings">;
}

export async function saveMerchantMemberSettings(
  merchantId: string,
  patch: MerchantMemberSettingsPatch,
): Promise<void> {
  const { error } = await supabase
    .from("merchant_member_settings")
    .upsert(buildMerchantMemberSettingsPayload(merchantId, patch), { onConflict: "merchant_id" });
  if (error) throw error;
}

// =========================================================================
// 紅利系統重構 §3.9 / §4.2:進階派點公式(merchant_point_formulas)。
// 讀:RLS 直讀(SELECT 要 member_points 鑰匙);寫:一律走 upsert_member_point_formulas 批次儲存,
// 不在前端逐列 insert/update/delete(重複檢查、原子性、IDOR 檢查都在那支函式裡)。
// =========================================================================
export async function fetchMerchantPointFormulas(
  merchantId: string,
): Promise<MerchantPointFormula[]> {
  const { data, error } = await supabase
    .from("merchant_point_formulas")
    .select(
      "id, merchant_id, name, enabled, service_item_id, min_unit_price, points_per_unit, sort_order, created_at, updated_at",
    )
    .eq("merchant_id", merchantId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, min_unit_price: Number(row.min_unit_price) }));
}

export function pointFormulasQueryKey(merchantId: string | null | undefined) {
  return ["members-module", "point-formulas", merchantId] as const;
}

export function useMerchantPointFormulas(
  merchantId: string | null | undefined,
  enabled = true,
): UseQueryResult<MerchantPointFormula[]> {
  return useQuery({
    queryKey: pointFormulasQueryKey(merchantId),
    queryFn: () => fetchMerchantPointFormulas(merchantId as string),
    enabled: Boolean(merchantId) && enabled,
  });
}

export interface PointFormulaInput {
  id: string | null;
  name: string;
  enabled: boolean;
  serviceItemId: string | null;
  minUnitPrice: number;
  pointsPerUnit: number;
  sortOrder: number;
}

export async function upsertMemberPointFormulas(
  merchantId: string,
  formulas: PointFormulaInput[],
): Promise<MerchantPointFormula[]> {
  const { data, error } = await supabase.rpc("upsert_member_point_formulas", {
    p_merchant_id: merchantId,
    p_formulas: formulas.map((f) => ({
      id: f.id,
      name: f.name,
      enabled: f.enabled,
      service_item_id: f.serviceItemId,
      min_unit_price: f.minUnitPrice,
      points_per_unit: f.pointsPerUnit,
      sort_order: f.sortOrder,
    })),
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, min_unit_price: Number(row.min_unit_price) }));
}

/** 公式下拉要列的服務項目(只有 id / 名稱 / 現價 / 狀態)。走窄函式,不放寬 service_items 表層政策。 */
export async function fetchPointFormulaServiceItems(
  merchantId: string,
): Promise<PointFormulaServiceItem[]> {
  const { data, error } = await supabase.rpc("get_point_formula_service_items", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    price: Number(row.price),
    status: row.status === "removed" ? "removed" : "active",
  }));
}

export function pointFormulaServiceItemsQueryKey(merchantId: string | null | undefined) {
  return ["members-module", "point-formula-service-items", merchantId] as const;
}

export function usePointFormulaServiceItems(
  merchantId: string | null | undefined,
  enabled = true,
): UseQueryResult<PointFormulaServiceItem[]> {
  return useQuery({
    queryKey: pointFormulaServiceItemsQueryKey(merchantId),
    queryFn: () => fetchPointFormulaServiceItems(merchantId as string),
    enabled: Boolean(merchantId) && enabled,
  });
}

// =========================================================================
// 紅利系統重構 §3.8 / §4.5:生日點數發送紀錄(最近 50 筆)。
// 權限:members 或 member_points 任一(第 10 題);「重新整理」只是重新查這支,不會觸發發送。
// =========================================================================
export async function fetchBirthdayBonusGrants(merchantId: string): Promise<BirthdayBonusGrant[]> {
  const { data, error } = await supabase.rpc("get_birthday_bonus_grants", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    memberName: row.member_name,
    points: row.points,
    bonusYear: row.bonus_year,
    anchorDate: row.anchor_date,
    lineStatus: row.line_status as BirthdayLineStatus,
    lineError: row.line_error ?? null,
    grantedAt: row.granted_at,
    lineAttemptedAt: row.line_attempted_at ?? null,
  }));
}

export function birthdayBonusGrantsQueryKey(merchantId: string | null | undefined) {
  return ["members-module", "birthday-bonus-grants", merchantId] as const;
}

export function useBirthdayBonusGrants(
  merchantId: string | null | undefined,
  enabled = true,
): UseQueryResult<BirthdayBonusGrant[]> {
  return useQuery({
    queryKey: birthdayBonusGrantsQueryKey(merchantId),
    queryFn: () => fetchBirthdayBonusGrants(merchantId as string),
    enabled: Boolean(merchantId) && enabled,
  });
}

// =========================================================================
// §3.3~§3.5:members 讀寫。members 表本身「RPC only」寫入,SELECT 直接開放 RLS。
// =========================================================================
export interface CreateMemberInput {
  merchantId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null; // ISO date (yyyy-mm-dd)
  notes?: string | null;
  referredByMemberId?: string | null;
  /** #615(SPECS-INDEX):選填,指派會員等級,須屬於同商家且未下架。 */
  tierId?: string | null;
}

export async function createMember(input: CreateMemberInput): Promise<Member> {
  const { data, error } = await supabase.rpc("create_member", {
    p_merchant_id: input.merchantId,
    p_name: input.name,
    ...(input.phone ? { p_phone: input.phone } : {}),
    ...(input.email ? { p_email: input.email } : {}),
    ...(input.birthday ? { p_birthday: input.birthday } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
    ...(input.referredByMemberId ? { p_referred_by_member_id: input.referredByMemberId } : {}),
    ...(input.tierId ? { p_tier_id: input.tierId } : {}),
  });
  if (error) throw error;
  return data as Member;
}

export interface UpdateMemberInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  notes?: string | null;
  /** #615(SPECS-INDEX):選填,重新指派會員等級,傳 null 清空成未分級。 */
  tierId?: string | null;
}

export async function updateMember(memberId: string, input: UpdateMemberInput): Promise<Member> {
  // `as string` 在下面四個欄位只是安撫型別檢查,不影響實際送出的值:supabase gen types 對
  // update_member 這幾個參數推導成 `string`(不含 null),但用 pg_get_function_arguments 對照
  // 正式環境確認過,函式簽章就是一般的 text 參數,沒有 not null 限制,完全接受 null——這是型別
  // 產生工具目前版本的已知落差,不是真的資料庫限制。繼續照常送出 null(不是空字串),保留「使用者
  // 故意清空這個欄位」的語意,不跟「沒有填」混在一起。
  const { data, error } = await supabase.rpc("update_member", {
    p_member_id: memberId,
    p_name: input.name,
    p_phone: (input.phone ?? null) as string,
    p_email: (input.email ?? null) as string,
    p_birthday: (input.birthday ?? null) as string,
    p_notes: (input.notes ?? null) as string,
    // 同上,p_tier_id 一樣接受 null(清空成未分級),型別產生工具的已知落差,見上方註解。
    p_tier_id: (input.tierId ?? null) as string,
  });
  if (error) throw error;
  return data as Member;
}

export async function deactivateMember(memberId: string): Promise<Member> {
  const { data, error } = await supabase.rpc("deactivate_member", { p_member_id: memberId });
  if (error) throw error;
  return data as Member;
}

export async function reactivateMember(memberId: string): Promise<Member> {
  const { data, error } = await supabase.rpc("reactivate_member", { p_member_id: memberId });
  if (error) throw error;
  return data as Member;
}

/** §3.5(第〇節判斷 1):這是人工標記,不是真的簡訊驗證,呼叫端按鈕文案要清楚說明這一點。 */
export async function setMemberPhoneVerified(memberId: string, verified: boolean): Promise<Member> {
  const { data, error } = await supabase.rpc("set_member_phone_verified", {
    p_member_id: memberId,
    p_verified: verified,
  });
  if (error) throw error;
  return data as Member;
}

// =========================================================================
// §10.4(SPECS-INDEX #616):會員黑名單。純警告用途,不擋建單。
// =========================================================================
export async function setMemberBlacklistStatus(
  memberId: string,
  isBlacklisted: boolean,
  reason?: string | null,
): Promise<Member> {
  const { data, error } = await supabase.rpc("set_member_blacklist_status", {
    p_member_id: memberId,
    p_is_blacklisted: isBlacklisted,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw error;
  return data as Member;
}

// =========================================================================
// §10.2.1(SPECS-INDEX #614):get_members_by_phone。建單頁輸入客戶電話時,列出這支電話底下
// 這個商家所有既有客戶(電話當查詢索引,不當唯一鍵)。權限只要求 orders(can_manage_bookings),
// 不需要 members 權限,呼應規則 2.10 既有精神。
// =========================================================================
interface RawMemberPhoneMatchCandidate {
  member_id: string;
  name: string;
  phone: string | null;
  last_booking_date: string | null;
  is_blacklisted: boolean;
  blacklist_reason: string | null;
  /** SPECS-INDEX #936(20261001010100 migration 新增)。用 `?:` 是刻意的:那支 migration 若沒有
   *  上線,回傳就不會有這個 key,下面一律當成 null,點選候選時不動地址欄,不會壞。 */
  last_booking_address?: string | null;
}

export async function fetchMembersByPhone(
  merchantId: string,
  phone: string,
): Promise<MemberPhoneMatchCandidate[]> {
  const { data, error } = await supabase.rpc("get_members_by_phone", {
    p_merchant_id: merchantId,
    p_phone: phone,
  });
  if (error) throw error;
  return ((data ?? []) as unknown as RawMemberPhoneMatchCandidate[]).map((row) => ({
    memberId: row.member_id,
    name: row.name,
    phone: row.phone,
    lastBookingDate: row.last_booking_date,
    isBlacklisted: row.is_blacklisted,
    blacklistReason: row.blacklist_reason,
    lastBookingAddress: row.last_booking_address ?? null,
  }));
}

export function useMembersByPhone(
  merchantId: string | null | undefined,
  phone: string,
): UseQueryResult<MemberPhoneMatchCandidate[]> {
  return useQuery({
    queryKey: ["members-module", "phone-match", merchantId, phone],
    queryFn: () => fetchMembersByPhone(merchantId as string, phone),
    enabled: Boolean(merchantId) && phone.trim().length > 0,
  });
}

// =========================================================================
// §10.3(SPECS-INDEX #615):merchant_member_tiers 讀寫。比照 payment_methods 的既有做法,不包
// RPC,直接開放 RLS(SELECT 同時放行 can_manage_members/can_manage_member_settings,
// INSERT/UPDATE 只允許 can_manage_member_settings)。
// =========================================================================
export async function fetchMerchantMemberTiers(
  merchantId: string,
  activeOnly = false,
): Promise<MerchantMemberTier[]> {
  let query = supabase
    .from("merchant_member_tiers")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("sort_order", { ascending: true });
  if (activeOnly) {
    query = query.eq("status", "active");
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as MerchantMemberTier[];
}

export function useMerchantMemberTiers(
  merchantId: string | null | undefined,
  activeOnly = false,
): UseQueryResult<MerchantMemberTier[]> {
  return useQuery({
    queryKey: ["members-module", "member-tiers", merchantId, activeOnly],
    queryFn: () => fetchMerchantMemberTiers(merchantId as string, activeOnly),
    enabled: Boolean(merchantId),
  });
}

export interface UpsertMemberTierInput {
  name: string;
  sortOrder?: number;
}

export async function addMemberTier(
  merchantId: string,
  input: UpsertMemberTierInput,
): Promise<MerchantMemberTier> {
  const { data, error } = await supabase
    .from("merchant_member_tiers")
    .insert({
      merchant_id: merchantId,
      name: input.name.trim(),
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as MerchantMemberTier;
}

export async function updateMemberTier(
  tierId: string,
  input: Partial<UpsertMemberTierInput>,
): Promise<void> {
  const { error } = await supabase
    .from("merchant_member_tiers")
    .update({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    })
    .eq("id", tierId);
  if (error) throw error;
}

async function setMemberTierStatus(tierId: string, status: MemberTierStatus): Promise<void> {
  const { error } = await supabase
    .from("merchant_member_tiers")
    .update({ status })
    .eq("id", tierId);
  if (error) throw error;
}

/** 軟刪除(下架),不算危險操作,比照 payment_methods/material_cost_items 既有慣例。下架不會連帶
 * 清空既有會員的 tier_id(#615 §10.3 規則)。 */
export async function removeMemberTier(tierId: string): Promise<void> {
  return setMemberTierStatus(tierId, "removed");
}

export async function reactivateMemberTier(tierId: string): Promise<void> {
  return setMemberTierStatus(tierId, "active");
}

/** §5.1 對外介面:唯讀搜尋清單,供 4.1 會員管理列表頁 + 4.1 NewMemberDialog 的推薦人搜尋使用,
 * 也保留給之後任何需要「選擇/建立會員」入口的模組直接複用。search 為空字串時回傳全部(依狀態
 * 篩選由呼叫端自行處理)。 */
const POSTGREST_PAGE_SIZE = 1000;

/**
 * fetchMerchantMembersList 這支查詢實際會拿到的原始欄位。
 *
 * 🟢 **2026-09-30 收尾:型別擋板已經移除。**
 * `identity_verified_at` 已經隨 #908 的 migration 進了 `src/integrations/supabase/types.ts`
 * (資料庫產生的那份已重新產生),所以原本掛在下面兩處查詢尾端的
 * `.overrideTypes<MembersListRow[], { merge: false }>()` **已經拆掉**。
 * 那個擋板當初只是為了讓 #918/#919/#920 這批介面工作能跟 #908 的 migration **平行進行** ——
 * 欄位還不存在時,supabase-js 的 select 字串型別解析會把整個結果判成
 * `SelectQueryError<"column 'identity_verified_at' does not exist on 'members'">`,`npx tsc` 直接紅。
 * 🔴 **不要再加回來**:overrideTypes 會擋掉 select 字串的真實型別檢查,欄位打錯字時 tsc 就抓不到了。
 *
 * 📌 這個手寫型別本身**刻意留著**,不是擋板的殘骸:
 *   1. 下面的 `let data` / `const pages`(分頁迴圈要先宣告再累加)需要一個具名型別;
 *   2. 拆掉擋板之後,它變成 select 字串的**契約檢查** —— 少 select 一個欄位、或資料庫欄位型別變了,
 *      `tsc` 會在指派那一行直接報錯,而不是等到執行時畫面上才少一塊資料。
 */
type MembersListRow = {
  id: string;
  name: string;
  phone: string | null;
  referral_code: string;
  points_balance: number;
  status: string;
  tier_id: string | null;
  is_blacklisted: boolean;
  /** #908「已完成身分驗證」的時間;null = 尚未驗證。 */
  identity_verified_at: string | null;
};

export async function fetchMerchantMembersList(
  merchantId: string,
  search?: string,
  /** 模組 12(資料匯入與報表匯出)§3.9/§6:報表匯出中心需要「全部會員、不分頁」，但 PostgREST
   * 有 db.max_rows 上限(這個專案設定 1000，見 supabase/config.toml)。為 true 時改用 .range()
   * 分頁迴圈抓完所有符合條件的資料再合併回傳；不帶這個參數(既有呼叫端)行為完全不變。 */
  unpaged?: boolean,
): Promise<MemberSummary[]> {
  function buildQuery() {
    // 🔴 #918/#919:只多加 identity_verified_at 一個欄位,**維持逐一列欄位的寫法**,
    //    不要改成 select("*")(資安清單 #6:以後新增的欄位會自動跟著外流)。
    //    identity_verified_via 依 #908 備註刻意不帶到前端。
    //    ⚠️ 這個欄位由 #908 的 migration 建立;migration 還沒套用時這支查詢會失敗
    //    (PostgREST 回「column does not exist」),名單頁會走 isError 分支顯示「讀不到會員名單」。
    let query = supabase
      .from("members")
      .select(
        "id, name, phone, referral_code, points_balance, status, tier_id, is_blacklisted, identity_verified_at",
      )
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false });

    if (search && search.trim()) {
      const term = search.trim();
      query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,referral_code.ilike.%${term}%`);
    }
    return query;
  }

  let data: MembersListRow[];
  if (unpaged) {
    const pages: MembersListRow[] = [];
    let offset = 0;
    for (;;) {
      const { data: page, error } = await buildQuery().range(
        offset,
        offset + POSTGREST_PAGE_SIZE - 1,
      );
      if (error) throw error;
      pages.push(...(page ?? []));
      if (!page || page.length < POSTGREST_PAGE_SIZE) break;
      offset += POSTGREST_PAGE_SIZE;
    }
    data = pages;
  } else {
    const { data: rows, error } = await buildQuery();
    if (error) throw error;
    data = rows ?? [];
  }

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    referralCode: row.referral_code,
    pointsBalance: row.points_balance,
    status: row.status as MemberStatus,
    tierId: row.tier_id,
    isBlacklisted: row.is_blacklisted,
    // #918/#919:兩層狀態的判定欄位。`?? null` 是保險 —— 舊資料或型別上的 undefined 一律當成未驗證。
    identityVerifiedAt: row.identity_verified_at ?? null,
  }));
}

export function useMerchantMembersList(
  merchantId: string | null | undefined,
  search: string,
  unpaged?: boolean,
): UseQueryResult<MemberSummary[]> {
  return useQuery({
    queryKey: ["members-module", "members-list", merchantId, search, unpaged ?? false],
    queryFn: () => fetchMerchantMembersList(merchantId as string, search, unpaged),
    enabled: Boolean(merchantId),
  });
}

/**
 * 🔴 詳情頁要抓的欄位,**逐一列舉,刻意不是 `select("*")`**(2026-10-01 品管打回)。
 *
 * 兩個理由,缺一個都還是要這樣寫:
 *   ① `identity_verified_via` 依 #908 裁決**刻意不回傳給前端**(「畫面不需要知道」)。
 *      原本這裡是 `select("*")`,等於 types.ts 的註解寫著「前端不要去 select 它」、
 *      同一個模組的這支函式卻正在 select 它 —— 那一欄一路送到瀏覽器的 network 面板。
 *   ② 資安清單 #6:「表層政策給的是整列,以後新增的欄位會自動跟著外流」⇒ 逐一列欄位,
 *      少回一個欄位就少一個資訊面。名單頁的 `fetchMerchantMembersList` 本來就是這樣寫的。
 *
 * 🔴 這串欄位必須跟 `types.ts` 的 `MemberDetail` 一致(那邊也寫了同一句提醒)。
 *    順序照 members 表的欄位習慣排,加欄位時兩邊一起加。
 *    ⚠️ 刻意**沒有**列進來的欄位(不是漏掉):
 *      ・`identity_verified_via` —— #908 明確裁決不給前端。
 *      ・`line_bound` / `line_user_id` —— 詳情頁的 LINE 區塊是 MemberLineBindingSection
 *        自己另外抓的,這一頁不需要。
 *      ・`user_id` / `created_by_user_id` / `blacklisted_by_user_id` / `blacklisted_at` /
 *        `referred_by_member_id` / `referral_rewarded_at` / `last_birthday_bonus_year` /
 *        `phone_verified_at` / `created_at` / `updated_at` —— 畫面上沒有任何地方顯示。
 */
const MEMBER_DETAIL_COLUMNS =
  "id, merchant_id, name, phone, email, birthday, notes, status, tier_id, points_balance, referral_code, is_blacklisted, blacklist_reason, phone_verified, identity_verified_at, identity_first_verified_at";

export async function fetchMember(memberId: string): Promise<MemberDetail | null> {
  const { data, error } = await supabase
    .from("members")
    .select(MEMBER_DETAIL_COLUMNS)
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function useMember(
  memberId: string | null | undefined,
): UseQueryResult<MemberDetail | null> {
  return useQuery({
    queryKey: ["members-module", "member-detail", memberId],
    queryFn: () => fetchMember(memberId as string),
    enabled: Boolean(memberId),
  });
}

// =========================================================================
// §3.7/§3.8:紅利點數核發是後端 complete_booking 疊加自動觸發,前端不直接呼叫
// compute_member_loyalty_points(該函式已 revoke 所有角色的 execute 權限)。
// =========================================================================

// =========================================================================
// §3.9/§3.10:兌換/手動調整點數。
// =========================================================================
export async function redeemMemberPoints(
  memberId: string,
  points: number,
  note: string,
): Promise<Member> {
  const { data, error } = await supabase.rpc("redeem_member_points", {
    p_member_id: memberId,
    p_points: points,
    p_note: note,
  });
  if (error) throw error;
  return data as Member;
}

/** §3.10(規則 2.6 核心):只有商家管理員能成功,前端只需要把管理員以外的人擋在按鈕外——
 * 資料庫層 private.is_merchant_admin 才是真正的安全邊界。 */
export async function adjustMemberPoints(
  memberId: string,
  pointsDelta: number,
  note: string,
): Promise<Member> {
  const { data, error } = await supabase.rpc("adjust_member_points", {
    p_member_id: memberId,
    p_points_delta: pointsDelta,
    p_note: note,
  });
  if (error) throw error;
  return data as Member;
}

// =========================================================================
// §3.12/§5.2:點數異動歷史。
// =========================================================================
interface RawMemberPointHistoryRow {
  id: string;
  transaction_type: MemberPointTransactionType;
  points_delta: number;
  balance_after: number;
  note: string | null;
  booking_id: string | null;
  booking_start_at: string | null;
  related_member_id: string | null;
  related_member_name: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export async function fetchMemberPointHistory(
  memberId: string,
): Promise<MemberPointHistoryEntry[]> {
  const { data, error } = await supabase.rpc("get_member_point_history", { p_member_id: memberId });
  if (error) throw error;
  // #946:RPC 只依 created_at desc 排;同一交易寫入的多筆時間完全相同,先後不固定 ⇒
  // 用 stabilizePointHistoryOrder 依「餘額接龍」把那幾筆排回真實寫入順序(理由見該檔檔頭)。
  return stabilizePointHistoryOrder(
    ((data ?? []) as unknown as RawMemberPointHistoryRow[]).map(toMemberPointHistoryEntry),
  );
}

function toMemberPointHistoryEntry(row: RawMemberPointHistoryRow): MemberPointHistoryEntry {
  return {
    id: row.id,
    transactionType: row.transaction_type,
    pointsDelta: row.points_delta,
    balanceAfter: row.balance_after,
    note: row.note ?? null,
    bookingId: row.booking_id ?? null,
    bookingStartAt: row.booking_start_at ?? null,
    relatedMemberId: row.related_member_id ?? null,
    relatedMemberName: row.related_member_name ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at,
  };
}

/** §5.2 對外介面:也是模組 13(客戶端自助預約)之後「我的紅利點數」直接依賴的介面。 */
export function useMemberPointHistory(
  memberId: string | null | undefined,
): UseQueryResult<MemberPointHistoryEntry[]> {
  return useQuery({
    queryKey: ["members-module", "point-history", memberId],
    queryFn: () => fetchMemberPointHistory(memberId as string),
    enabled: Boolean(memberId),
  });
}

// =========================================================================
// §3.13/§5.2:相關訂單清單(一之二節方向二,SECURITY DEFINER 繞過 bookings_select)。
// =========================================================================
interface RawMemberRelatedBookingRow {
  id: string;
  start_at: string;
  status: string;
  final_amount_snapshot: number;
  service_item_names: string[] | null;
  earned_points: number | null;
  // 紅利系統重構 §3.13(批次 7)
  points_planned: number | null;
  points_redeemed: number | null;
  points_planned_overridden: boolean | null;
  // #844 §4.8(migration C):earned_points 改成本單本會員的有效入帳;新增被收回點數
  reversed_points: number | null;
}

export async function fetchMemberRelatedBookings(
  memberId: string,
): Promise<MemberRelatedBooking[]> {
  const { data, error } = await supabase.rpc("get_member_related_bookings", {
    p_member_id: memberId,
  });
  if (error) throw error;
  return ((data ?? []) as unknown as RawMemberRelatedBookingRow[]).map((row) => ({
    id: row.id,
    startAt: row.start_at,
    status: row.status,
    finalAmountSnapshot: Number(row.final_amount_snapshot),
    serviceItemNames: row.service_item_names ?? [],
    earnedPoints: row.earned_points ?? null,
    pointsPlanned: row.points_planned ?? 0,
    pointsRedeemed: row.points_redeemed ?? 0,
    pointsPlannedOverridden: row.points_planned_overridden === true,
    reversedPoints: row.reversed_points ?? 0,
  }));
}

export function useMemberRelatedBookings(
  memberId: string | null | undefined,
): UseQueryResult<MemberRelatedBooking[]> {
  return useQuery({
    queryKey: ["members-module", "related-bookings", memberId],
    queryFn: () => fetchMemberRelatedBookings(memberId as string),
    enabled: Boolean(memberId),
  });
}

// =========================================================================
// §3.14/§5.2:推薦名單。保留給模組 13 之後客戶自助介面「我的推薦名單」直接複用。
// =========================================================================
interface RawMemberReferralRow {
  id: string;
  name: string;
  status: MemberStatus;
  referral_rewarded_at: string | null;
  created_at: string;
}

export async function fetchMemberReferrals(memberId: string): Promise<MemberReferral[]> {
  const { data, error } = await supabase.rpc("get_member_referrals", { p_member_id: memberId });
  if (error) throw error;
  return ((data ?? []) as unknown as RawMemberReferralRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    referralRewardedAt: row.referral_rewarded_at ?? null,
    createdAt: row.created_at,
  }));
}

export function useMemberReferrals(
  memberId: string | null | undefined,
): UseQueryResult<MemberReferral[]> {
  return useQuery({
    queryKey: ["members-module", "referrals", memberId],
    queryFn: () => fetchMemberReferrals(memberId as string),
    enabled: Boolean(memberId),
  });
}

// =========================================================================
// §3.17/§3.18/§5.5:模組 2(超級管理員後台)專用掛鉤點。這次沒有任何 UI 使用,純粹是給模組 2
// 之後串接用的建構塊。
// =========================================================================
export async function platformExportMerchantMembersSnapshot(merchantId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("platform_export_merchant_members_snapshot", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return data;
}

export async function platformPurgeMerchantMembersAndPoints(merchantId: string): Promise<void> {
  const { error } = await supabase.rpc("platform_purge_merchant_members_and_points", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
}
