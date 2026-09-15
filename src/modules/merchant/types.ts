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

export const INDUSTRY_TYPE_LABELS: Record<IndustryType, string> = {
  on_site_dispatch: "到府派工",
  in_store_beauty: "美業到店",
};

export const INDUSTRY_TYPE_DESCRIPTIONS: Record<IndustryType, string> = {
  on_site_dispatch: "師傅到客戶指定地點提供服務,例如冷氣、水電、防水工程。",
  in_store_beauty: "客戶到店消費,例如美髮、美容、按摩、整骨。",
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
