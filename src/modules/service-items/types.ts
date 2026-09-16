// 模組 4:服務項目管理 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到服務項目/服務分類相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得,不要直接 import Supabase 產生的 Tables<'service_items'> 等型別
// (呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type ServiceCategory = Tables<"service_categories">;
export type ServiceItem = Tables<"service_items">;

export type ServiceItemType = "primary" | "addon";
export type ServiceItemStatus = "active" | "removed";

export const SERVICE_ITEM_TYPE_LABELS: Record<ServiceItemType, string> = {
  primary: "主要服務",
  addon: "加價服務",
};

/** 4.1 邊界情況:category_id 為 NULL 時前端一律顯示成這個虛擬分類(規則 2.1),
 * 不對應任何真實的 service_categories 資料列。 */
export const UNCATEGORIZED_LABEL = "未分類";
