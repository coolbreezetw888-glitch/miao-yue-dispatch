// SPECS-INDEX #1025 功能開關 FG1-U04:商家後台讀「這間店開了哪些平台功能」的共用 hook。
// 規格書 .project/specs/功能開關.md(第 2 版)第二節「隱藏的前端做法」、T10、FG1-U04。
//
// 資料來源:public.get_merchant_features(merchant_id)(FG1-F04,SECURITY DEFINER,內部檢查呼叫者
// 屬於這間店)。`effective` 已經是資料庫算好的最終結果(含「細部功能在主功能關時一律關」T5),
// 前端只照抄,不自己重算。
//
// 🔴 這裡只是畫面上的「藏起來」(F3=A:沒開通就整個看不到)。真正的擋住點在資料庫(T6):
//    就算有人繞過畫面直接打 API,資料庫一樣會擋。所以讀取失敗時**不擅自顯示也不擅自隱藏**,
//    hasFeature 回 undefined(= 還不知道),交給呼叫端顯示骨架。

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import { useCurrentMerchant } from "./context";

/** 第 1 批的三個功能 key(跟資料庫 platform_features.key 一致)。 */
export const MERCHANT_FEATURE_KEYS = {
  onlineBooking: "online_booking",
  dataImport: "data_import",
  reportExport: "report_export",
} as const;

export type MerchantFeatureKey = (typeof MERCHANT_FEATURE_KEYS)[keyof typeof MERCHANT_FEATURE_KEYS];

/** get_merchant_features 回傳的一列。 */
export interface MerchantFeatureRow {
  feature_key: string;
  name: string;
  description: string;
  off_impact: string;
  parent_key: string | null;
  sort_order: number;
  /** 這間店那一列的值;沒有列時為 null。 */
  granted: boolean | null;
  /** merchant_has_feature 的結果(最終是否可用)。 */
  effective: boolean;
  /** 這間店目前產業的預設值;沒有設定時為 null。 */
  preset_enabled: boolean | null;
}

/** query key 含 merchant id:切換分店時自動重讀(邊界 3)。 */
export const merchantFeaturesQueryKey = (merchantId: string | null | undefined) =>
  ["merchant-module", "merchant-features", merchantId ?? null] as const;

export async function fetchMerchantFeatures(merchantId: string): Promise<MerchantFeatureRow[]> {
  const { data, error } = await supabase.rpc("get_merchant_features", {
    p_merchant_id: merchantId,
  });
  if (error) {
    // 丟真正的 Error(platform-admin skill:Supabase 的 error 不是 Error 實例)。
    throw Object.assign(new Error(error.message), { code: error.code, hint: error.hint });
  }
  return (data ?? []) as MerchantFeatureRow[];
}

/**
 * 純函式:這個功能現在是開還是關。
 *   - rows 還沒有(讀取中 / 讀取失敗)⇒ undefined(還不知道)
 *   - 清單裡沒有這個 key ⇒ false(不在功能清單的一律當關,跟資料庫 fail closed 一致)
 *   - 其他 ⇒ 那一列的 effective
 */
export function featureStatus(
  rows: readonly MerchantFeatureRow[] | undefined,
  key: string,
): boolean | undefined {
  if (!rows) return undefined;
  const row = rows.find((r) => r.feature_key === key);
  return row ? row.effective === true : false;
}

/** 讀目前商家的平台功能開關。hasFeature(key):true / false / undefined(讀取中或讀取失敗)。 */
export function useMerchantFeatures() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;

  const query = useQuery({
    queryKey: merchantFeaturesQueryKey(merchantId),
    queryFn: () => fetchMerchantFeatures(merchantId as string),
    enabled: Boolean(merchantId),
    staleTime: 30_000,
  });

  const rows = query.data;
  const hasFeature = useCallback((key: string) => featureStatus(rows, key), [rows]);

  return {
    features: rows,
    hasFeature,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
