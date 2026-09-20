// 模組 12(資料匯入/報表匯出，含產業轉移機制)— 型別定義。
// 對應規格書 .project/specs/資料匯入與報表匯出.md 第一節資料表。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantBulkOperation = Tables<"merchant_bulk_operations">;

export type BulkOperationType =
  "member_import" | "historical_booking_import" | "industry_transfer_members";

export const BULK_OPERATION_TYPE_LABELS: Record<BulkOperationType, string> = {
  member_import: "會員匯入",
  historical_booking_import: "歷史訂單匯入",
  industry_transfer_members: "產業轉移(會員搬遷)",
};

export type MemberImportWriteMode = "insert_only" | "upsert_by_phone";

/** §0 名詞對照:欄位對應(column mapping)。key 是秒約的目標欄位,value 是使用者選定對應的 CSV
 * 標題文字(空字串代表「不對應」)。 */
export type ColumnMapping = Record<string, string>;

export interface BulkOperationErrorItem {
  row_number: number;
  raw_data: Record<string, unknown>;
  error_message: string;
}

/** §3.5 rollback_bulk_operation 回傳的復原結果摘要。 */
export interface RollbackResult {
  restoredCount: number;
  skippedCount: number;
  skippedReasons: Array<{ entity_table: string; entity_id: string; reason: string }>;
}

/** 4.1 步驟一:匯入類型。 */
export type ImportKind = "members" | "historical_bookings";

/** 4.1 步驟二/三:會員匯入的目標欄位清單(對應 import_members_batch 的 row JSON 形狀)。 */
export const MEMBER_IMPORT_TARGET_FIELDS: Array<{
  key: string;
  label: string;
  required: boolean;
}> = [
  { key: "name", label: "姓名", required: true },
  { key: "phone", label: "電話", required: false },
  { key: "email", label: "Email", required: false },
  { key: "birthday", label: "生日(YYYY-MM-DD)", required: false },
  { key: "notes", label: "備註", required: false },
  { key: "referrer_value", label: "推薦人電話/推薦碼", required: false },
  { key: "starting_points_balance", label: "起始點數餘額", required: false },
];

/** 4.1 步驟二:歷史訂單匯入的目標欄位清單(對應 import_historical_bookings_batch 的 row JSON
 * 形狀)。staff_id 不在這裡直接對應——那是步驟三「數值對應」透過服務人員文字欄位間接產生。 */
export const HISTORICAL_BOOKING_IMPORT_TARGET_FIELDS: Array<{
  key: string;
  label: string;
  required: boolean;
}> = [
  { key: "customer_name", label: "客戶姓名", required: true },
  { key: "customer_phone", label: "客戶電話", required: true },
  { key: "customer_email", label: "客戶 Email", required: false },
  { key: "customer_address", label: "客戶地址", required: false },
  { key: "customer_notes", label: "客戶備註", required: false },
  { key: "staff_name", label: "服務人員(文字姓名，下一步驟對應)", required: true },
  { key: "start_at", label: "預約時間(ISO 格式，例如 2024-01-01T10:00:00+08:00)", required: true },
  { key: "duration_minutes", label: "服務時長(分鐘，留空預設 60 分鐘)", required: false },
  { key: "status", label: "狀態(已完成/已取消)", required: false },
  { key: "service_description", label: "服務內容描述", required: false },
  { key: "final_amount", label: "訂單金額", required: true },
  { key: "subtotal_amount", label: "小計金額(選填)", required: false },
  { key: "discount_amount", label: "折扣金額(選填)", required: false },
  { key: "tax_amount", label: "稅金金額(選填)", required: false },
  { key: "payment_method", label: "付款方式(選填)", required: false },
  { key: "member_phone", label: "會員電話(選填，用來連結既有會員)", required: false },
];
