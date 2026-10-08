// 模組 10:會員與紅利 — 型別定義。
// 對應規格書 .project/specs/會員與紅利.md 第一節資料表。其他模組若需要用到會員相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks 取得,不要直接 import Supabase 產生的
// Tables<'members'> 等型別(呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

/**
 * 🔴 SPECS-INDEX #908 給讀 `Member.identity_verified_at` 的人的提醒(這段知識不要跟著程式碼一起消失)。
 *
 * `identity_verified_at` 是「**這個人本人已經證明過他就是這支手機的主人**」,**與登入方式無關**。
 * 判定「是不是真正的會員」一律看這個欄位,**不看 `line_bound`、也不看 `phone_verified`**:
 *   ・`line_bound` 的語意是「LINE 推播管道可用」——那是**通知管道**,不是身分。
 *   ・`phone_verified` 的欄位註解自己寫著「不代表真的發送過簡訊驗證碼」——那是客服按的人工標記。
 * 兩件事不可以互相取代,畫面上也不可以合併成一個欄位顯示(規格書 §一 的裁決 + #920)。
 * 判斷與文案一律走 `memberIdentityStatus.ts` 的純函式,不要在元件裡 inline 寫 `!== null`。
 *
 * 📌 `identity_verified_via`(用哪一種方式驗的)依 #908 備註**刻意不回傳給前端**
 *    (「畫面不需要知道」)⇒ 前端不要去 select 它,也不要拿它做判斷。
 *    🔴 2026-10-01 品管打回後補上真正的守門:詳情頁不再走 `.select("*")`,改走下面的
 *    `MemberDetail`(逐一列舉欄位)。`Member` 這個型別**維持整列**,因為它描述的是
 *    `create_member` / `update_member` 這些 `returns public.members` 的 RPC 實際回傳的內容
 *    (那些 RPC 真的會把整列送回瀏覽器 —— 已回報主腦,那屬於後端 migration 的範圍,不在
 *    這次打回的六項裡)。**畫面要用的型別一律用 `MemberDetail`,不要用 `Member`。**
 *
 * 🟢 2026-09-30 收尾:#908 的 migration 已上線、`integrations/supabase/types.ts` 已重新產生,
 *    所以這些欄位**已經在 `Tables<"members">` 裡**,原本為了跟那批平行進行而加的
 *    `MemberIdentityVerificationColumns` 交集型別已經移除(它把欄位宣告成選填,現在只會讓人
 *    誤會欄位還沒上線)。
 */
export type Member = Tables<"members">;

/**
 * 🔴 會員**詳情頁**實際拿到的欄位集合(#908 裁決 + 2026-10-01 品管打回後新增)。
 *
 * 為什麼要有這個型別,而不是直接用 `Member`(整列):
 *   ① `identity_verified_via` 依 #908 裁決**刻意不回傳給前端** —— 原本 `fetchMember` 用的是
 *      `.select("*")`,等於同一個模組一邊在註解裡寫「前端不要 select 它」、一邊又在 select 它。
 *   ② 資安清單 #6 的既有原則:「表層政策給的是整列,以後新增的欄位會自動跟著外流」⇒ 逐一列欄位,
 *      少回一個欄位就少一個資訊面。`MemberSummary`(名單頁)本來就是這樣寫的,詳情頁現在對齊。
 *
 * 🔴 這份清單就是 `api.ts` 裡 `MEMBER_DETAIL_COLUMNS` 那個 select 字串,**兩邊必須一致**。
 *    詳情頁要多顯示一個欄位時,**兩個地方都要加**(只加這裡 ⇒ 執行時會是 undefined;只加
 *    select 字串 ⇒ tsc 會說型別上沒有這個屬性)。目前這 16 個欄位就是詳情頁本體與它底下的
 *    EditMemberDialog / BlacklistDialog / MemberPointsPanel 全部會讀到的欄位。
 */
export type MemberDetail = Pick<
  Member,
  | "id"
  | "merchant_id"
  | "name"
  | "phone"
  | "email"
  | "birthday"
  | "address"
  | "notes"
  | "status"
  | "tier_id"
  | "points_balance"
  | "referral_code"
  | "is_blacklisted"
  | "blacklist_reason"
  | "identity_verified_at"
  | "identity_first_verified_at"
>;
export type MerchantMemberSettings = Tables<"merchant_member_settings">;
export type MemberPointTransaction = Tables<"member_point_transactions">;
/** #615(SPECS-INDEX):商家自訂會員等級清單,純分類標籤用途,這次不跟紅利點數倍率或其他權益掛勾。 */
export type MerchantMemberTier = Tables<"merchant_member_tiers">;

/** §1.1 D:生日 LINE 文案的 schema 預設值(逐字照 migration 20261007140100,第 11 批 #989 改全形)。 */
export const DEFAULT_BIRTHDAY_LINE_MESSAGE =
  "生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。";

export type MemberStatus = "active" | "removed";

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: "上架中",
  removed: "已下架",
};

export type MemberTierStatus = "active" | "removed";

/** #619(SPECS-INDEX):核發獎勵資格判斷條件,取代原本單一的 require_verified_phone_for_rewards
 * boolean 開關。
 * 第 11 批 D(#991,2026-10-07):人工電話驗證標記退場 ⇒ 靠它的 phone_verified / either / both
 * 三個選項一併收掉(資料庫 CHECK 同步收緊成 none / line_bound),只剩 2 個選項。 */
export type RewardConditionMode = "none" | "line_bound";

export const REWARD_CONDITION_MODE_LABELS: Record<RewardConditionMode, string> = {
  none: "不限制",
  line_bound: "只看 LINE 已綁定",
};

/** 紅利系統重構 §1.5:分類帳 transaction_type 從 5 種擴成 10 種(CHECK 在批次 1)。 */
export type MemberPointTransactionType =
  | "earn_booking"
  | "referral_bonus"
  | "referral_repeat_bonus"
  | "birthday_bonus"
  | "manual_adjustment"
  | "redeem"
  | "redeem_booking"
  | "redeem_booking_refund"
  | "earn_booking_reversal"
  | "referral_bonus_reversal";

/** 文案逐字照規格書 §1.5 表格「白話」欄(§4.8)。 */
export const MEMBER_POINT_TRANSACTION_TYPE_LABELS: Record<MemberPointTransactionType, string> = {
  earn_booking: "消費核發",
  referral_bonus: "推薦獎勵(首次)",
  referral_repeat_bonus: "推薦獎勵(後續)",
  birthday_bonus: "生日贈點",
  manual_adjustment: "手動調整",
  redeem: "兌換使用",
  redeem_booking: "訂單折抵",
  // v2.4 裁決 22 L5:原本 §1.5 寫「訂單取消退回折抵」,但改單換會員 / 改點數也會寫這一類,改成中性說法。
  redeem_booking_refund: "訂單折抵退回",
  // #844:還原完成與取消已完成訂單都會寫這一類 ⇒ 不再只寫「取消」(原「訂單取消回收點數」)。
  earn_booking_reversal: "訂單收回點數",
  referral_bonus_reversal: "推薦獎勵回收",
};

/** 分類帳讀到不認得的類型(例如之後又擴充、前端還沒更新)時顯示原始代碼,不要顯示空白。 */
export function memberPointTransactionTypeLabel(type: string): string {
  return (MEMBER_POINT_TRANSACTION_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

/** 1.1 查無資料時前端一律套用的預設值(財務謹慎設計,第〇節判斷 3——不能自己「幫」商家填入
 * 非零數字)。points_feature_enabled 預設 true(#617,.project/specs/會員與紅利.md §10.5:
 * 沿用目前既有商家的實際使用狀況)。#618/#619(SPECS-INDEX)疊加:phone_required_to_create/
 * require_verified_phone_for_rewards 兩個開關已移除,新增 reward_condition_mode/policy_enabled/
 * policy_content 的預設值。
 *
 * 紅利系統重構 批次 6(§3.14):舊的 points_earn_rate 已 drop;改成 §1.1 A/B/C/D 全部新欄位,
 * 每一個值都**逐字照 migration 20261001020000 的 DEFAULT**(資料庫跟前端兩邊的預設值必須一致,
 * 否則「還沒有設定列」的商家打開設定頁,看到的值跟第一次存檔後資料庫實際寫入的值會不一樣)。
 *
 * 🔴 判斷 13(規格書顯眼警告;v2.4 裁決 21 ① 更正前提):merchant_member_settings 的 SELECT 政策只放行
 *    **member_settings / member_points** 鑰匙(**不放行 members**)。其他人呼叫 `useMerchantMemberSettings`
 *    時 RLS 查無列 ⇒ 會靜默回到這組預設值(`points_feature_enabled = true`)。
 *    ⇒ 只有紅利點數管理頁(MemberPointsPage)、會員系統設定頁(MemberSettingsPage)可以拿它判斷「紅利開沒開」。
 *    建單頁看 preview_booking_points 的 feature_enabled;帳務報表看 get_merchant_billing_summary 的
 *    points_feature_enabled;會員詳情頁看 get_merchant_points_feature_enabled(useMerchantPointsFeatureEnabled)。 */
export const DEFAULT_MERCHANT_MEMBER_SETTINGS: Pick<
  MerchantMemberSettings,
  | "points_feature_enabled"
  | "reward_condition_mode"
  | "earn_mode"
  | "basic_points_per_order"
  | "basic_min_amount"
  | "basic_tiered_enabled"
  | "redeem_points_unit"
  | "redeem_amount_unit"
  | "redeem_max_ratio_percent"
  | "referral_inviter_reward_enabled"
  | "referral_bonus_points"
  | "referral_subsequent_bonus_points"
  | "referral_inviter_earning_enabled"
  | "referral_invitee_earning_enabled"
  | "birthday_bonus_enabled"
  | "birthday_bonus_points"
  | "birthday_line_message"
  | "policy_enabled"
  | "policy_content"
> = {
  points_feature_enabled: true,
  reward_condition_mode: "none",
  earn_mode: "basic",
  basic_points_per_order: 0,
  basic_min_amount: 0,
  basic_tiered_enabled: false,
  redeem_points_unit: 0,
  redeem_amount_unit: 0,
  redeem_max_ratio_percent: 0,
  referral_inviter_reward_enabled: false,
  referral_bonus_points: 0,
  referral_subsequent_bonus_points: 0,
  referral_inviter_earning_enabled: true,
  referral_invitee_earning_enabled: true,
  birthday_bonus_enabled: false,
  birthday_bonus_points: 0,
  birthday_line_message: DEFAULT_BIRTHDAY_LINE_MESSAGE,
  policy_enabled: false,
  policy_content: null,
};

/** 前端拿到的會員設定:有設定列就是整列,沒有就是上面的預設值。兩者共同擁有的欄位就是設定頁會用到的全部。 */
export type MemberSettingsView = typeof DEFAULT_MERCHANT_MEMBER_SETTINGS;

// =========================================================================
// 紅利系統重構(§1.2 / §1.3 / §3.8):紅利計算模式、進階公式、生日發送紀錄。
// =========================================================================

/** §1.1 A:紅利計算模式。basic = 基本設定(整張訂單一個規則);advanced = 進階設定(逐服務項目公式)。 */
export type EarnMode = "basic" | "advanced";

/** §1.2 merchant_point_formulas 一列(門檻轉成 number)。 */
export type MerchantPointFormula = Omit<Tables<"merchant_point_formulas">, "min_unit_price"> & {
  min_unit_price: number;
};

/** get_point_formula_service_items 回傳的一筆(公式下拉用)。 */
export interface PointFormulaServiceItem {
  id: string;
  name: string;
  price: number;
  status: "active" | "removed";
}

/** §1.3 + v2.4 主腦裁決第 19/20 條:生日 LINE 發送狀態,共 7 種。 */
export type BirthdayLineStatus =
  | "pending"
  | "sent"
  | "failed"
  | "skipped_not_bound"
  | "skipped_not_connected"
  | "skipped_member_removed"
  | "skipped_merchant_disabled";

/** §4.5 生日分頁「LINE 狀態」欄的中文標籤。v2.4 第 20 條:兩個新略過狀態用指定文案,
 *  不可借用「未綁定」(那會讓商家以為是會員沒綁 LINE)。 */
export const BIRTHDAY_LINE_STATUS_LABELS: Record<BirthdayLineStatus, string> = {
  pending: "待發送",
  sent: "已發送",
  failed: "發送失敗",
  skipped_not_bound: "未綁定略過",
  skipped_not_connected: "商家未連線略過",
  skipped_member_removed: "會員已下架，未發送",
  skipped_merchant_disabled: "商家已停用，未發送",
};

/** get_birthday_bonus_grants 回傳的一筆生日發送紀錄。 */
export interface BirthdayBonusGrant {
  id: string;
  memberName: string;
  points: number;
  bonusYear: number;
  anchorDate: string;
  lineStatus: BirthdayLineStatus;
  lineError: string | null;
  grantedAt: string;
  lineAttemptedAt: string | null;
}

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
  /**
   * #844 §4.8:本單、本會員的**有效入帳**(入帳 − 收回);從未入帳為 null。
   * (紅利批次 7 以前是「任意一筆 earn_booking 的毛額」,已改。)
   */
  earnedPoints: number | null;
  /** #844 §4.8:本單、本會員被收回的點數(正數),沒有為 0。 */
  reversedPoints: number;
  /** 紅利系統重構 §3.13:預定派點(建單當下定案的快照)。 */
  pointsPlanned: number;
  /** 紅利系統重構 §3.13:這張單用了幾點折抵。 */
  pointsRedeemed: number;
  /** 紅利系統重構 §3.13:預定派點是不是客服人工設定的。 */
  pointsPlannedOverridden: boolean;
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
 * 供列表頁顯示/篩選。#918/#919 疊加:新增 identityVerifiedAt 供名單頁的「會員類型」標籤與篩選、
 * 以及會員報表 CSV 的「會員類型」欄使用。
 * 🔴 這個型別對應的 `.select(...)` **維持逐一列欄位**,不要改成 `select("*")`
 * (資安清單 #6:表層政策給的是整列,以後新增的欄位會自動跟著外流)。 */
export interface MemberSummary {
  id: string;
  name: string;
  phone: string | null;
  referralCode: string;
  pointsBalance: number;
  status: MemberStatus;
  tierId: string | null;
  isBlacklisted: boolean;
  /** #908 的「已完成身分驗證」時間;null = 尚未驗證。判斷一律走
   *  memberIdentityStatus.ts 的純函式,不要在畫面上自己寫 `!== null`。 */
  identityVerifiedAt: string | null;
}

/** §10.2.1(SPECS-INDEX #614)get_members_by_phone 回傳的一筆候選客戶。#929 之後是「前綴比對」
 * (打 0903 就列出 0903 開頭的所有會員,完全相等的排第一);#931 之後同一商家一支電話只有一位
 * active 會員。 */
export interface MemberPhoneMatchCandidate {
  memberId: string;
  name: string;
  phone: string | null;
  lastBookingDate: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  /** SPECS-INDEX #936:這位會員在本商家最近一筆有填地址的訂單地址(members 表沒有地址欄位);
   *  沒有就是 null ⇒ 點選候選時不動地址欄。 */
  lastBookingAddress: string | null;
}
