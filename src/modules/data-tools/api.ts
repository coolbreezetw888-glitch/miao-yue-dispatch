// 模組 12(資料匯入/報表匯出，含產業轉移機制)— 資料存取層 + 第五節「對外介面」。
// 這裡是唯一直接呼叫 supabase.rpc('import_members_batch' / 'import_historical_bookings_batch' /
// 'rollback_bulk_operation' / 'transfer_members_to_merchant' / 'get_merchant_bulk_operations' /
// 'platform_list_merchant_bulk_operations') 的地方。其他模組不應該直接查詢
// merchant_bulk_operations/merchant_bulk_operation_items 這兩張表(規格書第五節「對外介面」)。
//
// 錯誤訊息顯示注意事項(沿用既有模組已經確立的踩坑):`error` 不是真正的 Error 實例，一律用
// `if (error) throw error` 丟出，畫面上用 getErrorMessage() 取訊息。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  BulkOperationErrorItem,
  MemberImportWriteMode,
  MerchantBulkOperation,
  RollbackResult,
} from "./types";

// =========================================================================
// §3.1:會員批次匯入。
// =========================================================================
export async function importMembersBatch(
  merchantId: string,
  writeMode: MemberImportWriteMode,
  rows: Record<string, unknown>[],
): Promise<string> {
  const { data, error } = await supabase.rpc("import_members_batch", {
    p_merchant_id: merchantId,
    p_write_mode: writeMode,
    p_rows: rows as never,
  });
  if (error) throw error;
  return data as string;
}

// =========================================================================
// §3.4:歷史訂單批次匯入。
// =========================================================================
export async function importHistoricalBookingsBatch(
  merchantId: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  const { data, error } = await supabase.rpc("import_historical_bookings_batch", {
    p_merchant_id: merchantId,
    p_rows: rows as never,
  });
  if (error) throw error;
  return data as string;
}

// =========================================================================
// §3.5:一鍵復原。
// =========================================================================
export async function rollbackBulkOperation(operationId: string): Promise<RollbackResult> {
  const { data, error } = await supabase.rpc("rollback_bulk_operation", {
    p_operation_id: operationId,
  });
  if (error) throw error;
  const raw = data as unknown as {
    restored_count: number;
    skipped_count: number;
    skipped_reasons: Array<{ entity_table: string; entity_id: string; reason: string }>;
  };
  return {
    restoredCount: raw.restored_count,
    skippedCount: raw.skipped_count,
    skippedReasons: raw.skipped_reasons ?? [],
  };
}

// =========================================================================
// §3.6:產業轉移(會員搬遷)。
// =========================================================================
export async function transferMembersToMerchant(
  sourceMerchantId: string,
  targetMerchantId: string,
  memberIds: string[],
): Promise<string> {
  const { data, error } = await supabase.rpc("transfer_members_to_merchant", {
    p_source_merchant_id: sourceMerchantId,
    p_target_merchant_id: targetMerchantId,
    p_member_ids: memberIds,
  });
  if (error) throw error;
  return data as string;
}

// =========================================================================
// §3.7/§5.1:批次操作歷史查詢，供 4.2 匯入紀錄頁使用。
// =========================================================================
export async function getMerchantBulkOperations(
  merchantId: string,
): Promise<MerchantBulkOperation[]> {
  const { data, error } = await supabase.rpc("get_merchant_bulk_operations", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as MerchantBulkOperation[];
}

/** §5.1 對外介面:回傳某商家的批次操作歷史，供 4.2 使用，也保留給任何之後需要「這個商家有沒有
 * 做過批次匯入」的模組直接複用。 */
export function useMerchantBulkOperations(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantBulkOperation[]> {
  return useQuery({
    queryKey: ["data-tools-module", "bulk-operations", merchantId],
    queryFn: () => getMerchantBulkOperations(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// §3.8/§5.2:模組 2(超級管理員後台)專用掛鉤點。這次沒有任何 UI 使用。
// =========================================================================
export async function platformListMerchantBulkOperations(
  merchantId: string,
): Promise<MerchantBulkOperation[]> {
  const { data, error } = await supabase.rpc("platform_list_merchant_bulk_operations", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data ?? []) as MerchantBulkOperation[];
}

/** error_report 欄位是 jsonb，前端讀取時做型別收斂。 */
export function parseErrorReport(errorReport: unknown): BulkOperationErrorItem[] {
  if (!Array.isArray(errorReport)) return [];
  return errorReport as BulkOperationErrorItem[];
}
