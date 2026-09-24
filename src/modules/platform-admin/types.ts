// 模組 2:超級管理員/平台管理後台(核心層)— 型別定義
// 對應規格書「名詞對照」與第一節資料表。

import type { Group, IndustryType, Merchant } from "@/modules/merchant/types";

/** 介面 4.3/4.4 用:商家 + 所屬集團基本資料 + 管理員人數(管理員人數見 api.ts 的補充讀取函式)。 */
export interface PlatformMerchantRow extends Merchant {
  group: Pick<Group, "id" | "name"> | null;
  admin_count: number;
}

/** 介面 4.5 用:集團基本資料 + 目前的集團管理者 user_id。 */
export type PlatformGroupRow = Pick<Group, "id" | "name" | "group_admin_user_id">;

// ---------------------------------------------------------------------------
// 規格書「超級管理員商家詳情強化」#699:商家詳情頁兩張唯讀名單卡片的列型別。
//
// 欄位與 migration 20260924042000 裡 platform_get_merchant_staff /
// platform_get_merchant_agents 的 `returns table(...)` **一對一對齊**。
//
// ⚠️ 這個專案開了 tsconfig 的 `exactOptionalPropertyTypes: true`(見 api.ts 開頭
//    SupabaseCallError 那段註解),所以「可能是 null 的欄位」一律寫成 `| null` 的**必填**
//    屬性,不要寫成 `?:` 可選屬性——兩者在這個模式下語意不同。
//
// ⚠️ 為什麼不直接用 Supabase 產生的型別:自動產生的 types.ts 對 `returns table(...)` 的
//    每一欄都標成非 null(PostgreSQL 的函式簽章無法表達某一欄可能是 null),但
//    login_email / nickname / user_id / job_title 實際上都可能是 null。用這裡自己宣告的
//    型別,畫面層才會被型別系統強迫處理「沒填」的情況(fallback 見 personDisplay.ts)。
// ---------------------------------------------------------------------------

/** #702 服務人員名單卡片的一列。對應 platform_get_merchant_staff 的回傳形狀。 */
export interface PlatformStaffRow {
  id: string;
  merchant_id: string;
  /** 還沒開通登入的服務人員是 null。 */
  user_id: string | null;
  name: string;
  nickname: string | null;
  phone: string;
  /** 資料庫值是 'monthly_salary' | 'piece_rate';中文顯示用 STAFF_COMPENSATION_TYPE_LABELS。 */
  compensation_type: string;
  /** 'active' | 'removed'(removed 是軟刪除,名單上照樣顯示,排最後)。 */
  status: string;
  /** 'not_invited' | 'invited' | 'active';跟 status 是兩回事,見規格書第一節。 */
  login_status: string;
  /** 已註冊的人是 auth.users 的登入信箱,還沒註冊的人退回邀請信箱,都沒有就是 null。 */
  login_email: string | null;
  created_at: string;
}

/** #703 客服名單卡片的一列。對應 platform_get_merchant_agents 的回傳形狀。
 *  ⚠️ 客服**沒有** compensation_type、也**沒有** login_status,不要為了跟服務人員對稱而補上。 */
export interface PlatformAgentRow {
  id: string;
  merchant_id: string;
  /** 已邀請但還沒註冊的客服是 null。 */
  user_id: string | null;
  name: string;
  nickname: string | null;
  phone: string;
  job_title: string | null;
  /** 'invited' | 'active' | 'removed'。 */
  status: string;
  /** 客服的 invited_email 是 NOT NULL,所以實務上不會是 null;型別仍保守寫成可為 null。 */
  login_email: string | null;
  created_at: string;
}

/** 介面 4.6 用:單一項產業預設功能組合。 */
export interface IndustryFeaturePresetRow {
  id: string;
  industry_type: IndustryType;
  feature_key: string;
  default_enabled: boolean;
}
