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

/** #986 第 9 批:服務項目描述上限(資料庫 CHECK service_items_description_length_check 同一個數字)。 */
export const SERVICE_ITEM_DESCRIPTION_MAX_LENGTH = 200;

/** #986 第 9 批:描述送出前的整理 —— 前後空白去掉,空字串 / 只有空白 / 沒帶 ⇒ null(資料庫不存空字串)。 */
export function normalizeServiceItemDescription(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * #986 第 9 批:描述的欄位錯誤(超過上限才有)。用 Array.from 算字數,跟資料庫 char_length 一樣以「字」計算
 * (中文、emoji 都算一個字),不會因為 UTF-16 代理對多算。
 */
export function serviceItemDescriptionError(raw: string): string | null {
  const trimmed = raw.trim();
  return Array.from(trimmed).length > SERVICE_ITEM_DESCRIPTION_MAX_LENGTH
    ? "項目描述最多 200 個字"
    : null;
}

export function serviceItemDescriptionLength(raw: string): number {
  return Array.from(raw.trim()).length;
}
