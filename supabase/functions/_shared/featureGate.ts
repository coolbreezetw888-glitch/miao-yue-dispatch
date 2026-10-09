// SPECS-INDEX #1025 功能開關 第 2 批(FG2-F01):Edge Function 自己檢查「這間店有沒有開這個平台功能」。
// 規格書 .project/specs/功能開關.md 第六節 X7:用 service role 讀寫時沒有 RLS 保護,每支 Edge Function
// 都要**自己明確檢查**功能開關,不能假設上游(畫面、資料庫)擋過。
//
// 做法:用 service role client 呼叫 public.internal_merchant_has_feature(只 grant 給 service_role;
// 內容只呼叫 private.merchant_has_feature —— key 不在功能清單 ⇒ false、細部功能在主功能關時 ⇒ false)。
//
// 回傳:
//   true    ⇒ 開著
//   false   ⇒ 沒開(呼叫端照規格:不送 / 回 403「這個功能目前沒有開放。」)
//   "error" ⇒ 查詢失敗(呼叫端一律當「不能送」處理:fail closed,不擅自發送)
//
// 🔒 這支檔案刻意不 import 任何 Deno / supabase-js 的東西(只靠窄介面),前端 Vitest 也能直接測。

export const MERCHANT_FEATURE_DISABLED_MESSAGE = "這個功能目前沒有開放。";

/** FG-2 三個功能 key(跟資料庫 platform_features.key 一致)。 */
export const FEATURE_LINE_NOTIFICATIONS = "line_notifications";
export const FEATURE_LINE_MARKETING = "line_marketing";
export const FEATURE_PUSH_NOTIFICATIONS = "push_notifications";

/** 略過原因代碼(寫進 customer_line_outbox.last_error、push_notification_log.skip_reason)。 */
export const FEATURE_DISABLED_REASON = "feature_disabled";

export interface FeatureRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type FeatureCheckResult = boolean | "error";

/** 呼叫 internal_merchant_has_feature。只有資料庫明確回 true 才算開著。 */
export async function checkMerchantFeature(
  client: FeatureRpcClient,
  merchantId: string,
  featureKey: string,
): Promise<FeatureCheckResult> {
  try {
    const { data, error } = await client.rpc("internal_merchant_has_feature", {
      p_merchant_id: merchantId,
      p_feature_key: featureKey,
    });
    if (error) return "error";
    return data === true;
  } catch {
    return "error";
  }
}

/**
 * 同一次執行內,同一間店同一個功能只問資料庫一次(排程一次處理很多列時用)。
 * 查詢失敗("error")不快取,下一列會再問一次。
 */
export function createMerchantFeatureCache(client: FeatureRpcClient) {
  const cache = new Map<string, boolean>();
  return async function cachedCheck(merchantId: string, featureKey: string): Promise<FeatureCheckResult> {
    const key = `${merchantId}:${featureKey}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const result = await checkMerchantFeature(client, merchantId, featureKey);
    if (result !== "error") cache.set(key, result);
    return result;
  };
}
