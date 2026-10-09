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

// ===========================================================================
// SPECS-INDEX #1025 第三輪(使用者 2026-10-09 補充):
//   ① 細項列在大項底下(縮排)  ② 大項打開時細項預設全部打開;大項關時細項變灰不能操作(值保留)
//   ③ 所有開關「先調整、按儲存才生效」—— 下面是草稿(draft)的純邏輯,畫面只負責顯示。
// ===========================================================================

/** 有 key / parent_key 的一列(功能清單、商家功能兩種列都適用)。 */
interface FeatureNode {
  parent_key: string | null;
}
const keyOfRow = (row: { key?: string; feature_key?: string }) =>
  (row.feature_key ?? row.key) as string;

/** 這個主功能底下的細部功能 key。 */
export function childKeysOf(
  parentKey: string,
  rows: readonly (FeatureNode & { key?: string; feature_key?: string })[],
): string[] {
  return rows.filter((r) => r.parent_key === parentKey).map(keyOfRow);
}

/**
 * 切換一個開關後的新草稿(② 的規則):
 *   ・主功能打開 ⇒ 底下細部功能全部跟著打開(之後可以再個別關)
 *   ・主功能關掉 ⇒ 細部功能的值不動(畫面變灰,T9)
 *   ・細部功能 ⇒ 只改自己
 */
export function toggleDraft(
  draft: Readonly<Record<string, boolean>>,
  key: string,
  next: boolean,
  rows: readonly (FeatureNode & { key?: string; feature_key?: string })[],
): Record<string, boolean> {
  const result: Record<string, boolean> = { ...draft, [key]: next };
  const row = rows.find((r) => keyOfRow(r) === key);
  if (row && row.parent_key === null && next) {
    for (const child of childKeysOf(key, rows)) result[child] = true;
  }
  return result;
}

/** 細部功能而且主功能在草稿裡是關的 ⇒ 變灰不能操作。 */
export function isLockedByParent(
  parentKey: string | null,
  draft: Readonly<Record<string, boolean>>,
): boolean {
  return parentKey !== null && draft[parentKey] !== true;
}

/** 草稿跟原本不一樣的項目(依 keys 的順序)。 */
export function draftChanges(
  keys: readonly string[],
  original: Readonly<Record<string, boolean>>,
  draft: Readonly<Record<string, boolean>>,
): { key: string; enabled: boolean }[] {
  return keys
    .filter((k) => draft[k] !== undefined && draft[k] !== original[k])
    .map((k) => ({ key: k, enabled: draft[k] as boolean }));
}

/** 「功能開關」頁:新開商家預設的格子識別(產業 + 功能)。 */
export const presetCellKey = (industryType: string, featureKey: string) =>
  `${industryType}:${featureKey}`;

/** 「功能開關」頁的草稿:新開商家預設(每格)+ 全部商家開／關(每個功能:true / false / 沒有動作)。 */
export interface FeatureSettingsDraft {
  presets: Record<string, boolean>;
  bulk: Record<string, boolean>;
}

/**
 * 「全部商家開啟／關閉」放進草稿(按儲存才生效):
 *   ・同一列兩個產業的「新開商家預設」預設一起改成同一個值(= 原規格「同時把新開商家的預設值也改成一樣」預設打勾;
 *     使用者儲存前可以再把預設開關改回來)
 *   ・主功能「全部開啟」⇒ 底下細部功能也一起「全部開啟」(②)
 *   ・主功能「全部關閉」⇒ 細部功能已經排的動作取消(細部的值保留,T9)
 */
export function stageBulk(
  draft: FeatureSettingsDraft,
  key: string,
  enabled: boolean,
  rows: readonly (FeatureNode & { key: string })[],
  industryTypes: readonly string[],
): FeatureSettingsDraft {
  const presets = { ...draft.presets };
  const bulk = { ...draft.bulk, [key]: enabled };
  const setPresets = (k: string, v: boolean) => {
    for (const t of industryTypes) presets[presetCellKey(t, k)] = v;
  };
  setPresets(key, enabled);
  const row = rows.find((r) => r.key === key);
  if (row && row.parent_key === null) {
    for (const child of childKeysOf(key, rows)) {
      if (enabled) {
        bulk[child] = true;
        setPresets(child, true);
      } else {
        delete bulk[child];
      }
    }
  }
  return { presets, bulk };
}

/** 取消某一列已排的「全部商家開／關」(主功能取消時,細部功能跟著它排的動作一起取消)。新開商家預設不動。 */
export function unstageBulk(
  draft: FeatureSettingsDraft,
  key: string,
  rows: readonly (FeatureNode & { key: string })[],
): FeatureSettingsDraft {
  const bulk = { ...draft.bulk };
  delete bulk[key];
  const row = rows.find((r) => r.key === key);
  if (row && row.parent_key === null) {
    for (const child of childKeysOf(key, rows)) delete bulk[child];
  }
  return { presets: draft.presets, bulk };
}

/** 新開商家預設的開關切換(同 toggleDraft 的主 / 細部規則,只在同一個產業內連動)。 */
export function togglePresetDraft(
  draft: FeatureSettingsDraft,
  industryType: string,
  key: string,
  next: boolean,
  rows: readonly (FeatureNode & { key: string })[],
): FeatureSettingsDraft {
  const presets = { ...draft.presets, [presetCellKey(industryType, key)]: next };
  const row = rows.find((r) => r.key === key);
  if (row && row.parent_key === null && next) {
    for (const child of childKeysOf(key, rows)) presets[presetCellKey(industryType, child)] = true;
  }
  return { presets, bulk: draft.bulk };
}

/** 「全部商家」那一列的按鈕能不能按:細部功能的主功能已排「全部關閉」⇒ 不能(主功能會關,細部做了也沒作用)。 */
export function isBulkLockedByParent(
  parentKey: string | null,
  bulk: Readonly<Record<string, boolean>>,
): boolean {
  return parentKey !== null && bulk[parentKey] === false;
}
