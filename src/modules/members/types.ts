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
  | "notes"
  | "status"
  | "tier_id"
  | "points_balance"
  | "referral_code"
  | "is_blacklisted"
  | "blacklist_reason"
  | "phone_verified"
  | "identity_verified_at"
  | "identity_first_verified_at"
>;
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
