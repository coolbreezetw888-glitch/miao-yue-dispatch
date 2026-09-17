// 模組 1:商家與集團管理 — 型別定義
// 對應規格書「名詞對照」與第一節資料表。其他模組若需要用到商家/集團相關型別，
// 一律從這個檔案或 context.tsx 匯出的 hooks 取得，不要直接 import Supabase 產生的 Tables<'merchants'>。

import type { Tables } from "@/integrations/supabase/types";

export type Merchant = Tables<"merchants">;
export type Group = Tables<"groups">;
export type MerchantFeatureFlag = Tables<"merchant_feature_flags">;

/** 對應規格書 1.2 industry_type 欄位的 check 限制,建立後鎖定不可修改(規則 2.1)。 */
export type IndustryType = "on_site_dispatch" | "in_store_beauty";

export const INDUSTRY_TYPES: IndustryType[] = ["on_site_dispatch", "in_store_beauty"];

/** 建單表單細節修正規格書第一節(定案):in_store_beauty 只改顯示文字成「到店服務」,
 * 不限定特定產業別(呼應「到府派工」的對比命名),資料庫實際值 industry_type='in_store_beauty' 不變。 */
export const INDUSTRY_TYPE_LABELS: Record<IndustryType, string> = {
  on_site_dispatch: "到府派工",
  in_store_beauty: "到店服務",
};

export const INDUSTRY_TYPE_DESCRIPTIONS: Record<IndustryType, string> = {
  on_site_dispatch: "師傅到客戶指定地點提供服務,例如冷氣、水電、防水工程。",
  in_store_beauty: "客戶到店消費,例如美髮美容、按摩整骨、洗車美容等。",
};

/** 建單表單細節修正規格書第二節第 2 點:哪些產業類型的建單表單需要必填「客戶地址」欄位,
 * 做成可擴充對照表,不要把判斷式寫死散落在前端各處。之後新增產業類型時,只要在這裡補一筆即可。
 * **重要**:資料庫層(create_booking/update_booking)有一份對應的判斷邏輯
 * (private.industry_requires_customer_address,見 supabase/migrations/20260917110100 開頭的檔案),
 * 兩邊必須保持一致——以後在這裡新增產業類型時,要記得同步修改資料庫那一份,避免前後端判斷不一致。 */
export const INDUSTRY_REQUIRES_CUSTOMER_ADDRESS: Record<IndustryType, boolean> = {
  on_site_dispatch: true,
  in_store_beauty: false,
};

export type MerchantStatus = "active" | "disabled";

/** 5.1/5.2 對外介面回傳的商家資料,額外附上所屬集團的基本資訊(id、name)方便切換器分組顯示。 */
export interface MerchantWithGroup extends Merchant {
  group: Pick<Group, "id" | "name"> | null;
}

export interface MerchantAdminUser {
  id: string;
  merchant_id: string;
  user_id: string;
  email: string;
  created_at: string;
}
