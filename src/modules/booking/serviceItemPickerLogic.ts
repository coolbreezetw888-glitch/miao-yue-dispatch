// SPECS-INDEX #979(2026-10-06):建單畫面「選擇項目」整頁的純邏輯。
// 規格:.project/specs/建單畫面與下拉刷新-第2批.md 第一節 1.2;畫面在 ServiceItemPickerPage.tsx。
//
// ─── 為什麼要一份「草稿」 ──────────────────────────────────────────────────────────
// 整頁裡的勾選 / 數量 / 自訂金額都先改在草稿上:
//   ・按「確認」⇒ applyPickerDraft 一次寫回表單的 serviceItemIds / itemQuantities / itemUnitPrices
//   ・按返回箭頭 ⇒ 草稿直接丟掉,表單維持打開整頁之前的樣子(規格 1.2 第 6 點)
//
// ─── 寫回表單之後,其餘行為一律沿用表單原本的那一套(規格 1.1 第 3 點)───────────────────
// 表單的 itemQuantities / itemUnitPrices 仍然是「字串」,金額解析、#829 單價調整判定、工時加總、
// 紅利預覽、送出 payload 都還是讀那兩份狀態,這裡**不重新實作任何計價規則**:
//   ・自訂金額關閉 = 單價寫回「原價」(新勾的項目 = service_items.price;編輯時本來就在單上的項目 =
//     那張單當初的單價快照)⇒ #829 不會誤判成「已手動調整」
//   ・自訂金額打開 = 單價寫回輸入框的字串(原本表單上的單價覆寫功能)
//   ・數量寫回時走 parseItemQuantity(清空 = 1,跟表單原本的 fallback 一致)

import { parseAmountInput } from "@/components/patterns";

import { ITEM_QUANTITY_MAX, itemQuantityError, parseItemQuantity } from "./itemQuantity";

/** 草稿裡一個已勾選項目的狀態。數量 / 金額都存字串,方便控制輸入框(跟表單一致)。 */
export interface PickerDraftEntry {
  quantity: string;
  customPriceEnabled: boolean;
  customPrice: string;
}

export interface PickerDraft {
  /** 勾選順序(寫回表單時沿用,讓表單上的摘要順序穩定)。 */
  order: string[];
  entries: Record<string, PickerDraftEntry>;
}

/** 頁籤需要的最小欄位(故意不吃整個 ServiceItem 型別,測試可以只組最小資料)。 */
export interface PickerItem {
  id: string;
  name: string;
  price: number;
  duration_minutes: number;
  category_id: string | null;
  /** #986 第 9 批:服務項目描述(沒填 = null / undefined ⇒ 卡片不留空白)。 */
  description?: string | null | undefined;
  /**
   * 第 11 批 F #993:已下架、但這張單本來就有的品項(料錢整頁用)。卡片名稱後加灰字「(已下架)」,
   * 可以保留 / 改數量 / 取消勾選;整頁只會在「這張單本來就有」時列出它,所以不能新加。
   */
  inactive?: boolean | undefined;
}

export interface PickerCategory {
  id: string;
  name: string;
}

export interface PickerTab {
  /** 分類 id;未分類用 UNCATEGORIZED_TAB_KEY。 */
  key: string;
  label: string;
  items: PickerItem[];
}

export const UNCATEGORIZED_TAB_KEY = "__uncategorized__";

/**
 * 規格 1.2 第 2、7 點:分類頁籤。
 *   ・只列「有上架項目」的分類(呼叫端傳進來的 items 已經只有上架中的,見 useMerchantServiceItems)
 *   ・順序照商家分類清單(fetchServiceCategories 依名稱排序),未分類放最後
 *   ・項目找不到對應分類(分類被刪了)一律歸未分類
 */
export function buildPickerTabs(
  items: PickerItem[],
  categories: PickerCategory[],
  uncategorizedLabel: string,
): PickerTab[] {
  const knownCategoryIds = new Set(categories.map((c) => c.id));
  const tabs: PickerTab[] = [];
  for (const category of categories) {
    const categoryItems = items.filter((item) => item.category_id === category.id);
    if (categoryItems.length > 0) {
      tabs.push({ key: category.id, label: category.name, items: categoryItems });
    }
  }
  const uncategorized = items.filter(
    (item) => item.category_id === null || !knownCategoryIds.has(item.category_id),
  );
  if (uncategorized.length > 0) {
    tabs.push({ key: UNCATEGORIZED_TAB_KEY, label: uncategorizedLabel, items: uncategorized });
  }
  return tabs;
}

/** 規格 1.2 第 2 點:預設停在「已選項目所在」的第一個分類,沒有已選就停在第一個分類。 */
export function resolveDefaultPickerTab(tabs: PickerTab[], selectedIds: string[]): string | null {
  if (tabs.length === 0) return null;
  const selected = new Set(selectedIds);
  const withSelection = tabs.find((tab) => tab.items.some((item) => selected.has(item.id)));
  return (withSelection ?? tabs[0]!).key;
}

/** 兩個金額字串代表的是不是同一個數字(「2200」與「2200.0」算相同;解析不出來的一律算不同)。 */
function sameAmount(text: string, baseline: number): boolean {
  const parsed = parseAmountInput(text);
  return parsed.ok && parsed.value === baseline;
}

/**
 * 打開整頁時,從表單目前的狀態建立草稿。
 * 已勾選項目的「自訂金額」開關:單價 ≠ 原價 ⇒ 開著(並帶入目前的單價);相同 ⇒ 關著。
 * `baselinePrice` 由呼叫端決定原價是什麼(編輯時本來就在單上的項目 = 單價快照,其餘 = 現價)。
 */
export function initPickerDraft(input: {
  serviceItemIds: string[];
  itemQuantities: Record<string, string>;
  itemUnitPrices: Record<string, string>;
  baselinePrice: (id: string) => number | null;
}): PickerDraft {
  const entries: Record<string, PickerDraftEntry> = {};
  for (const id of input.serviceItemIds) {
    const baseline = input.baselinePrice(id);
    const unitPrice = input.itemUnitPrices[id];
    const customPriceEnabled =
      unitPrice !== undefined && baseline !== null && !sameAmount(unitPrice, baseline);
    entries[id] = {
      quantity: input.itemQuantities[id] ?? "1",
      customPriceEnabled,
      customPrice: customPriceEnabled ? (unitPrice ?? "") : "",
    };
  }
  return { order: [...input.serviceItemIds], entries };
}

/** 勾選 / 取消勾選。取消時收起並清掉自訂金額(規格 1.2 第 4 點)。 */
export function togglePickerItem(draft: PickerDraft, id: string): PickerDraft {
  if (id in draft.entries) {
    const entries = { ...draft.entries };
    delete entries[id];
    return { order: draft.order.filter((x) => x !== id), entries };
  }
  return {
    order: [...draft.order, id],
    entries: {
      ...draft.entries,
      [id]: { quantity: "1", customPriceEnabled: false, customPrice: "" },
    },
  };
}

/** 數量輸入框直接打字(允許暫時是空字串,寫回時才補成 1)。沒勾選的項目會順手勾起來。 */
export function setPickerQuantityText(draft: PickerDraft, id: string, text: string): PickerDraft {
  const base = id in draft.entries ? draft : togglePickerItem(draft, id);
  return {
    ...base,
    entries: { ...base.entries, [id]: { ...base.entries[id]!, quantity: text } },
  };
}

/** − / + 按鈕。最少 1(規格 1.2 第 3 點)、最多 999(第 11 批 F-1);沒勾選的項目按 + 會順手勾起來。 */
export function stepPickerQuantity(draft: PickerDraft, id: string, delta: 1 | -1): PickerDraft {
  const current = id in draft.entries ? parseItemQuantity(draft.entries[id]!.quantity) : 0;
  const next = Math.min(ITEM_QUANTITY_MAX, Math.max(1, Math.floor(current) + delta));
  return setPickerQuantityText(draft, id, String(next));
}

/** 自訂金額開關。打開時輸入框預先帶入原價(方便改);關掉時清空(規格 1.2 第 4 點:使用原價)。 */
export function setPickerCustomPriceEnabled(
  draft: PickerDraft,
  id: string,
  enabled: boolean,
  baselinePrice: number,
): PickerDraft {
  const entry = draft.entries[id];
  if (!entry) return draft;
  return {
    ...draft,
    entries: {
      ...draft.entries,
      [id]: {
        ...entry,
        customPriceEnabled: enabled,
        customPrice: enabled ? String(baselinePrice) : "",
      },
    },
  };
}

export function setPickerCustomPrice(draft: PickerDraft, id: string, text: string): PickerDraft {
  const entry = draft.entries[id];
  if (!entry) return draft;
  return { ...draft, entries: { ...draft.entries, [id]: { ...entry, customPrice: text } } };
}

/**
 * 第 11 批 F #993:自訂單價的額外限制(料錢整頁用;服務項目不傳 = 維持原本規則)。
 * `max`:上限(料錢 = 99,999,999.99,跟資料庫 numeric(10,2) 一致);`maxDecimals`:小數最多幾位。
 */
export interface PickerCustomPriceRules {
  max?: number | undefined;
  maxDecimals?: number | undefined;
}

/** 自訂金額有開、但輸入框填錯的項目 ⇒ 錯誤訊息(確認鈕要擋住,不能只標紅)。 */
export function pickerCustomPriceErrors(
  draft: PickerDraft,
  rules: PickerCustomPriceRules = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const id of draft.order) {
    const entry = draft.entries[id];
    if (!entry || !entry.customPriceEnabled) continue;
    const parsed = parseAmountInput(entry.customPrice, { max: rules.max });
    if (!parsed.ok) {
      errors[id] = parsed.error;
      continue;
    }
    if (rules.maxDecimals !== undefined) {
      const decimals = entry.customPrice.trim().split(".")[1]?.length ?? 0;
      if (decimals > rules.maxDecimals) {
        errors[id] = `最多只能填到小數點後 ${rules.maxDecimals} 位`;
      }
    }
  }
  return errors;
}

/** 第 11 批 F #993(F-1):數量超過 999 / 不是整數的項目 ⇒ 錯誤訊息(確認鈕擋住)。 */
export function pickerQuantityErrors(draft: PickerDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const id of draft.order) {
    const entry = draft.entries[id];
    if (!entry) continue;
    const error = itemQuantityError(entry.quantity);
    if (error) errors[id] = error;
  }
  return errors;
}

export interface AppliedPickerSelection {
  serviceItemIds: string[];
  itemQuantities: Record<string, string>;
  itemUnitPrices: Record<string, string>;
  /** 這次被取消勾選的項目(呼叫端要把它們的 #829 單價快照基準一起拿掉,跟原本的「移除」一致)。 */
  removedIds: string[];
}

/**
 * 按「確認」:把草稿寫回表單要用的三份狀態。
 *
 * `hiddenSelectedIds`:原本就勾著、但整頁裡看不到的項目(編輯舊訂單時遇到已下架的項目)——
 * 維持改版前的行為:畫面上選不到,但送出時原封不動帶回去(數量 / 單價都不動)。
 */
export function applyPickerDraft(input: {
  draft: PickerDraft;
  previousIds: string[];
  previousQuantities: Record<string, string>;
  previousUnitPrices: Record<string, string>;
  hiddenSelectedIds: string[];
  baselinePrice: (id: string) => number | null;
}): AppliedPickerSelection {
  const { draft } = input;
  const hidden = input.previousIds.filter((id) => input.hiddenSelectedIds.includes(id));
  const visibleChosen = draft.order.filter((id) => !hidden.includes(id) && id in draft.entries);

  const serviceItemIds = [...hidden, ...visibleChosen];
  const itemQuantities: Record<string, string> = {};
  const itemUnitPrices: Record<string, string> = {};

  for (const id of hidden) {
    if (input.previousQuantities[id] !== undefined)
      itemQuantities[id] = input.previousQuantities[id];
    if (input.previousUnitPrices[id] !== undefined)
      itemUnitPrices[id] = input.previousUnitPrices[id];
  }
  for (const id of visibleChosen) {
    const entry = draft.entries[id]!;
    itemQuantities[id] = String(parseItemQuantity(entry.quantity));
    const baseline = input.baselinePrice(id);
    if (entry.customPriceEnabled) {
      itemUnitPrices[id] = entry.customPrice.trim();
    } else if (baseline !== null) {
      itemUnitPrices[id] = String(baseline);
    }
  }

  const removedIds = input.previousIds.filter((id) => !serviceItemIds.includes(id));
  return { serviceItemIds, itemQuantities, itemUnitPrices, removedIds };
}

/** 「大約 1 小時 30 分鐘」;0 或沒設定 ⇒ null(規格 1.2 第 3 點:有設定時長才顯示)。 */
export function formatPickerDuration(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0 && rest > 0) return `大約 ${hours} 小時 ${rest} 分鐘`;
  if (hours > 0) return `大約 ${hours} 小時`;
  return `大約 ${rest} 分鐘`;
}

/** 「NT$ 2,200」(整數不帶小數;有小數就保留)。 */
export function formatPickerPrice(price: number): string {
  return `NT$ ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
