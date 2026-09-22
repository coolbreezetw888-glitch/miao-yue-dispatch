// 模組 10:會員與紅利 — 型別定義。
// 對應規格書 .project/specs/會員與紅利.md 第一節資料表。其他模組若需要用到會員相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks 取得,不要直接 import Supabase 產生的
// Tables<'members'> 等型別(呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type Member = Tables<"members">;
export type MerchantMemberSettings = Tables<"merchant_member_settings">;
export type MemberPointTransaction = Tables<"member_point_transactions">;

export type MemberStatus = "active" | "removed";

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: "上架中",
  removed: "已下架",
};

export type MemberPointTransactionType =
  | "earn_booking"
  | "referral_bonus"
  | "birthday_bonus"
  | "manual_adjustment"
  | "redeem";

export const MEMBER_POINT_TRANSACTION_TYPE_LABELS: Record<MemberPointTransactionType, string> = {
  earn_booking: "消費核發",
  referral_bonus: "推薦獎勵",
  birthday_bonus: "生日贈點",
  manual_adjustment: "手動調整",
  redeem: "兌換使用",
};

/** 1.1 查無資料時前端一律套用的預設值(財務謹慎設計,第〇節判斷 3——不能自己「幫」商家填入
 * 非零數字)。points_feature_enabled 預設 true(#617,.project/specs/會員與紅利.md §10.5:
 * 沿用目前既有商家的實際使用狀況)。 */
export const DEFAULT_MERCHANT_MEMBER_SETTINGS: Pick<
  MerchantMemberSettings,
  | "phone_required_to_create"
  | "require_verified_phone_for_rewards"
  | "points_earn_rate"
  | "referral_bonus_points"
  | "birthday_bonus_points"
  | "points_feature_enabled"
> = {
  phone_required_to_create: true,
  require_verified_phone_for_rewards: false,
  points_earn_rate: 0,
  referral_bonus_points: 0,
  birthday_bonus_points: 0,
  points_feature_enabled: true,
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

/** 4.1 會員列表搜尋用的最小欄位集合。 */
export interface MemberSummary {
  id: string;
  name: string;
  phone: string | null;
  referralCode: string;
  pointsBalance: number;
  status: MemberStatus;
}
