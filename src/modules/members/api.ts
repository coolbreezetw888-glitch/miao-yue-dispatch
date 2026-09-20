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
import type {
  Member,
  MemberPointHistoryEntry,
  MemberPointTransactionType,
  MemberReferral,
  MemberRelatedBooking,
  MemberStatus,
  MemberSummary,
  MerchantMemberSettings,
} from "./types";
import { DEFAULT_MERCHANT_MEMBER_SETTINGS } from "./types";

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

export interface UpsertMerchantMemberSettingsInput {
  phoneRequiredToCreate: boolean;
  requireVerifiedPhoneForRewards: boolean;
  pointsEarnRate: number;
  referralBonusPoints: number;
  birthdayBonusPoints: number;
}

export async function upsertMerchantMemberSettings(
  merchantId: string,
  input: UpsertMerchantMemberSettingsInput,
): Promise<void> {
  const { error } = await supabase.from("merchant_member_settings").upsert(
    {
      merchant_id: merchantId,
      phone_required_to_create: input.phoneRequiredToCreate,
      require_verified_phone_for_rewards: input.requireVerifiedPhoneForRewards,
      points_earn_rate: input.pointsEarnRate,
      referral_bonus_points: input.referralBonusPoints,
      birthday_bonus_points: input.birthdayBonusPoints,
    },
    { onConflict: "merchant_id" },
  );
  if (error) throw error;
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
  });
  if (error) throw error;
  return data as Member;
}

/** §5.1 對外介面:4.4 MemberPickerField「找不到?建立新會員」快速建立入口專用的精簡版本。 */
export async function createMemberQuick(
  merchantId: string,
  name: string,
  phone?: string | null,
  birthday?: string | null,
): Promise<Member> {
  return createMember({ merchantId, name, phone: phone ?? null, birthday: birthday ?? null });
}

export interface UpdateMemberInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  notes?: string | null;
}

export async function updateMember(memberId: string, input: UpdateMemberInput): Promise<Member> {
  const { data, error } = await supabase.rpc("update_member", {
    p_member_id: memberId,
    p_name: input.name,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
    p_birthday: input.birthday ?? null,
    p_notes: input.notes ?? null,
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

/** §5.1 對外介面:唯讀搜尋清單,供 4.1 會員管理列表頁 + 4.4 MemberPickerField 使用,也保留給
 * 之後任何需要「選擇/建立會員」入口的模組直接複用。search 為空字串時回傳全部(依狀態篩選由
 * 呼叫端自行處理)。 */
const POSTGREST_PAGE_SIZE = 1000;

export async function fetchMerchantMembersList(
  merchantId: string,
  search?: string,
  /** 模組 12(資料匯入與報表匯出)§3.9/§6:報表匯出中心需要「全部會員、不分頁」，但 PostgREST
   * 有 db.max_rows 上限(這個專案設定 1000，見 supabase/config.toml)。為 true 時改用 .range()
   * 分頁迴圈抓完所有符合條件的資料再合併回傳；不帶這個參數(既有呼叫端)行為完全不變。 */
  unpaged?: boolean,
): Promise<MemberSummary[]> {
  function buildQuery() {
    let query = supabase
      .from("members")
      .select("id, name, phone, referral_code, points_balance, status")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false });

    if (search && search.trim()) {
      const term = search.trim();
      query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%,referral_code.ilike.%${term}%`);
    }
    return query;
  }

  let data: {
    id: string;
    name: string;
    phone: string | null;
    referral_code: string;
    points_balance: number;
    status: string;
  }[];
  if (unpaged) {
    const pages: typeof data = [];
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

export async function fetchMember(memberId: string): Promise<Member | null> {
  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function useMember(memberId: string | null | undefined): UseQueryResult<Member | null> {
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
// §3.11:生日贈點被動核發。4.1 會員管理列表頁載入時呼叫。
// =========================================================================
export async function grantPendingBirthdayBonuses(merchantId: string): Promise<number> {
  const { data, error } = await supabase.rpc("grant_pending_birthday_bonuses", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
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
  return ((data ?? []) as unknown as RawMemberPointHistoryRow[]).map((row) => ({
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
  }));
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
