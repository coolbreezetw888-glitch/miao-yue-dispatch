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

/** 介面 4.6 用:單一項產業預設功能組合。 */
export interface IndustryFeaturePresetRow {
  id: string;
  industry_type: IndustryType;
  feature_key: string;
  default_enabled: boolean;
}
