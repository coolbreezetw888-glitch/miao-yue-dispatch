// SPECS-INDEX #1025 功能開關:超級管理員畫面共用的純函式(排序、標籤判斷、紀錄文字)。

import type { MerchantFeatureRow } from "@/modules/merchant/features";

import type { PlatformFeatureRow } from "./types";

/**
 * 功能清單的顯示順序:主功能依 sort_order,細部功能緊跟在自己的主功能後面(也依 sort_order)。
 * 主功能不在清單裡的細部功能(理論上不會發生)排在最後,不丟掉。
 */
export function orderFeaturesForDisplay(rows: readonly PlatformFeatureRow[]): PlatformFeatureRow[] {
  const bySort = (a: PlatformFeatureRow, b: PlatformFeatureRow) =>
    a.sort_order - b.sort_order || a.key.localeCompare(b.key);
  const parents = rows.filter((r) => r.parent_key === null).sort(bySort);
  const parentKeys = new Set(parents.map((p) => p.key));
  const result: PlatformFeatureRow[] = [];
  for (const parent of parents) {
    result.push(parent);
    result.push(...rows.filter((r) => r.parent_key === parent.key).sort(bySort));
  }
  result.push(
    ...rows.filter((r) => r.parent_key !== null && !parentKeys.has(r.parent_key)).sort(bySort),
  );
  return result;
}

/** 商家詳情「功能開關」卡:開關目前顯示的值(有列用列值,沒有列用資料庫算好的 effective)。 */
export function featureSwitchValue(row: MerchantFeatureRow): boolean {
  return row.granted ?? row.effective;
}

/** 「跟產業預設不同」標籤:這間店的值 ≠ 這間店目前產業的預設(產業沒設預設時不比較)。 */
export function differsFromPreset(row: MerchantFeatureRow): boolean {
  if (row.preset_enabled === null) return false;
  return featureSwitchValue(row) !== row.preset_enabled;
}

/** 細部功能而且主功能關著 ⇒ 開關變灰不能切,顯示「主功能關閉中」。 */
export function isParentOff(row: MerchantFeatureRow, rows: readonly MerchantFeatureRow[]): boolean {
  if (row.parent_key === null) return false;
  const parent = rows.find((r) => r.feature_key === row.parent_key);
  return parent ? parent.effective !== true : true;
}

/** 這個主功能底下有沒有細部功能(關閉確認窗要多一句)。 */
export function hasChildFeatures(
  row: MerchantFeatureRow,
  rows: readonly MerchantFeatureRow[],
): boolean {
  return row.parent_key === null && rows.some((r) => r.parent_key === row.feature_key);
}

/** 變更紀錄的「開→關 / 關→開」文字。原本沒有列(old = null)時只寫結果。 */
export function featureLogChangeText(oldEnabled: boolean | null, newEnabled: boolean): string {
  const label = (v: boolean) => (v ? "開" : "關");
  if (oldEnabled === null) return newEnabled ? "設為開" : "設為關";
  return `${label(oldEnabled)}→${label(newEnabled)}`;
}
