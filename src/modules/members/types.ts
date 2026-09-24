// 模組 10:會員與紅利 — 型別定義。
// 對應規格書 .project/specs/會員與紅利.md 第一節資料表。其他模組若需要用到會員相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks 取得,不要直接 import Supabase 產生的
// Tables<'members'> 等型別(呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type Member = Tables<"members">;
export type MerchantMemberSettings = Tables<"merchant_member_settings">;
export type MemberPointTransaction = Tables<"member_point_transactions">;
/** #615(SPECS-INDEX):商家自訂會員等級清單,純分類標籤用途,這次不跟紅利點數倍率或其他權益掛勾。 */
export type MerchantMemberTier = Tables<"merchant_member_tiers">;

export type MemberStatus = "active" | "removed";

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: "上架中",
  removed: "已下架",
};

export type MemberTierStatus = "active" | "removed";

/** #619(SPECS-INDEX):核發獎勵資格判斷條件,取代原本單一的 require_verified_phone_for_rewards
 * boolean 開關。 */
export type RewardConditionMode = "none" | "phone_verified" | "line_bound" | "either" | "both";

export const REWARD_CONDITION_MODE_LABELS: Record<RewardConditionMode, string> = {
  none: "不限制",
  phone_verified: "只看電話已驗證",
  line_bound: "只看 LINE 已綁定",
  either: "電話已驗證或 LINE 已綁定,任一即可",
  both: "電話已驗證且 LINE 已綁定,兩者都要符合",
};

export type MemberPointTransactionType =
  "earn_booking" | "referral_bonus" | "birthday_bonus" | "manual_adjustment" | "redeem";

export const MEMBER_POINT_TRANSACTION_TYPE_LABELS: Record<MemberPointTransactionType, string> = {
  earn_booking: "消費核發",
  referral_bonus: "推薦獎勵",
  birthday_bonus: "生日贈點",
  manual_adjustment: "手動調整",
  redeem: "兌換使用",
};

/** 1.1 查無資料時前端一律套用的預設值(財務謹慎設計,第〇節判斷 3——不能自己「幫」商家填入
 * 非零數字)。points_feature_enabled 預設 true(#617,.project/specs/會員與紅利.md §10.5:
 * 沿用目前既有商家的實際使用狀況)。#618/#619(SPECS-INDEX)疊加:phone_required_to_create/
 * require_verified_phone_for_rewards 兩個開關已移除,新增 reward_condition_mode/policy_enabled/
 * policy_content 的預設值。 */
export const DEFAULT_MERCHANT_MEMBER_SETTINGS: Pick<
  MerchantMemberSettings,
  | "points_earn_rate"
  | "referral_bonus_points"
  | "birthday_bonus_points"
  | "points_feature_enabled"
  | "reward_condition_mode"
  | "policy_enabled"
  | "policy_content"
> = {
  points_earn_rate: 0,
  referral_bonus_points: 0,
  birthday_bonus_points: 0,
  points_feature_enabled: true,
  reward_condition_mode: "none",
  policy_enabled: false,
  policy_content: null,
};

/** §3.12 get_member_point_history 回傳的一筆點數異動明細。 */
export interface MemberPointHistoryEntry {
  id: string;
  transactionType: MemberPointTransactionType;
  pointsDelta: number;
  balanceAfter: number;
  note: string | null;
  bookingId: string | null;
  bookingStartAt: string | null;
  relatedMemberId: string | null;
  relatedMemberName: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

/** §3.13 get_member_related_bookings 回傳的一筆相關訂單摘要。 */
export interface MemberRelatedBooking {
  id: string;
  startAt: string;
  status: string;
  finalAmountSnapshot: number;
  serviceItemNames: string[];
  earnedPoints: number | null;
}

/** §3.14 get_member_referrals 回傳的一筆推薦名單項目。 */
export interface MemberReferral {
  id: string;
  name: string;
  status: MemberStatus;
  referralRewardedAt: string | null;
  createdAt: string;
}

/** 4.1 會員列表搜尋用的最小欄位集合。#615/#616(SPECS-INDEX)疊加:新增 tierId/isBlacklisted
 * 供列表頁顯示/篩選。 */
export interface MemberSummary {
  id: string;
  name: string;
  phone: string | null;
  referralCode: string;
  pointsBalance: number;
  status: MemberStatus;
  tierId: string | null;
  isBlacklisted: boolean;
}

/** §10.2.1(SPECS-INDEX #614)get_members_by_phone 回傳的一筆同電話既有客戶。電話不當唯一鍵,
 * 只當查詢索引——同一支電話底下可能有多筆不同客戶(例如家庭成員共用市話)。 */
export interface MemberPhoneMatchCandidate {
  memberId: string;
  name: string;
  phone: string | null;
  lastBookingDate: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
}
