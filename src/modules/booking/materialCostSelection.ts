// 第 11 批 F #993(2026-10-07):建單 / 編輯訂單的料錢成本 ——「選擇料錢」整頁 + 表單摘要的純邏輯。
// 規格:.project/specs/改掛會員與預設文案全形-第11批.md §十三(13.3 共用方式、13.4 規則 F-1~F-9)。
//
// ─── 狀態長相(跟服務項目同構)─────────────────────────────────────────────────────────
// 表單上三份狀態:materialCostItemIds(勾選順序)、materialCostQuantities / materialCostUnitPrices
// (都是字串,方便控制輸入框)。整頁沿用 ServiceItemPickerPage + serviceItemPickerLogic(邏輯只認 id),
// 這支只負責「料錢特有」的部分:整頁要列哪些品項、原價是什麼、摘要怎麼算、送出格式。
//
// ─── 「原價」(F-3)─────────────────────────────────────────────────────────────────────
// 新加的品項 = 品項現價;編輯時本來就在單上的 = 那一列的單價快照(跟服務項目同一套,也跟 B2
// 「已在單上的不跟著改價」一致)。取消勾選後再勾回來 = 跟新加一樣用現價(比照服務項目的 #829 規則)。
//
// ─── 已下架 / 功能關閉(F-6、13.3 末段)─────────────────────────────────────────────────
// 整頁只列「上架中的品項(功能開著時)」+「這張單本來就有的品項」。本來就有、但已下架的品項
// 卡片標「(已下架)」,可以保留、改數量、取消勾選;沒在單上的已下架品項不會出現 ⇒ 不能新加。
// 功能關閉時只列這張單本來就有的品項(不能新增)。摘要一律顯示並算進合計(修掉 13.2 第 10 點缺口)。

import { parseAmountInput } from "@/components/patterns";

import { parseItemQuantity } from "./itemQuantity";
import type { PickerItem } from "./serviceItemPickerLogic";

/** 自訂成本單價上限(跟資料庫 numeric(10,2) 與後端 helper 一致,F-2)。 */
export const MATERIAL_UNIT_PRICE_MAX = 99_999_999.99;

// ─── 主腦裁決(防溢位):後端 private.parse_booking_material_cost_items /
//     private.assert_booking_material_cost_limits 同一組上限 ─────────────────────────
/** 單一料錢小計(單價 × 數量)上限。 */
export const MATERIAL_SUBTOTAL_MAX = 1_000_000;
/** 整張單料錢合計上限。 */
export const MATERIAL_TOTAL_MAX = 9_999_999.99;
export const MATERIAL_SUBTOTAL_MAX_MESSAGE = "單一料錢小計不能超過 $1,000,000";
export const MATERIAL_TOTAL_MAX_MESSAGE = "料錢合計不能超過 $9,999,999.99，請調整單價或數量";

/** 表單送出前的料錢上限檢查;沒問題回 null(有訊息 ⇒ 建立 / 儲存鈕擋住並顯示)。 */
export function materialLimitError(summary: {
  rows: { subtotal: number }[];
  total: number;
}): string | null {
  if (summary.rows.some((row) => row.subtotal > MATERIAL_SUBTOTAL_MAX)) {
    return MATERIAL_SUBTOTAL_MAX_MESSAGE;
  }
  if (summary.total > MATERIAL_TOTAL_MAX) return MATERIAL_TOTAL_MAX_MESSAGE;
  return null;
}

/** 上架中的料錢品項(商家端 fetchMerchantMaterialCostItems / 服務人員端 staff options 都是這個形狀)。 */
export interface MaterialCostOption {
  id: string;
  name: string;
  amount: number;
}

/** 編輯時這張單本來就有的料錢(開啟表單那一刻的快照;整個編輯過程不變)。 */
export type LoadedMaterialCosts = Record<string, { price: number; name: string }>;

/** 送後端的一項(api.ts 轉成 p_material_cost_items 的 {material_cost_item_id, quantity, unit_price})。 */
export interface BookingMaterialCostSelectionInput {
  materialCostItemId: string;
  quantity: number;
  /** 單價;null = 交給後端決定(這張單原本的快照 → 品項現價)。 */
  unitPrice: number | null;
}

/**
 * 「原價」(F-3)。
 * `snapshotBaseline`:編輯時本來就在單上、而且這次還沒被取消勾選過的品項的單價快照。
 */
export function materialBaselinePrice(
  id: string,
  snapshotBaseline: LoadedMaterialCosts,
  activeItems: MaterialCostOption[],
  loaded: LoadedMaterialCosts,
): number | null {
  const snapshot = snapshotBaseline[id];
  if (snapshot) return snapshot.price;
  const active = activeItems.find((m) => m.id === id);
  if (active) return Number(active.amount);
  // 取消勾選後再勾回來的已下架品項:沒有現價可用,沿用開啟時的快照。
  const original = loaded[id];
  return original ? original.price : null;
}

/** 整頁要列的品項(13.3:功能開 ⇒ 上架中 + 單上原有;功能關 ⇒ 只有單上原有)。 */
export function buildMaterialPickerItems(input: {
  enabled: boolean;
  activeItems: MaterialCostOption[];
  loaded: LoadedMaterialCosts;
}): PickerItem[] {
  const activeIds = new Set(input.activeItems.map((m) => m.id));
  const items: PickerItem[] = [];
  if (input.enabled) {
    for (const m of input.activeItems) {
      items.push({
        id: m.id,
        name: m.name,
        price: Number(m.amount),
        duration_minutes: 0,
        category_id: null,
      });
    }
  }
  for (const [id, original] of Object.entries(input.loaded)) {
    if (input.enabled && activeIds.has(id)) continue;
    const active = input.activeItems.find((m) => m.id === id);
    items.push({
      id,
      name: active?.name ?? original.name,
      price: active ? Number(active.amount) : original.price,
      duration_minutes: 0,
      category_id: null,
      inactive: !active,
    });
  }
  return items;
}

/** 表單上的一個字串單價 → 數字;沒有或填錯 ⇒ 用原價。 */
function resolveUnitPrice(text: string | undefined, baseline: number | null): number | null {
  if (text !== undefined) {
    const parsed = parseAmountInput(text);
    if (parsed.ok) return parsed.value;
  }
  return baseline;
}

export interface MaterialSummaryRow {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  /** 單價 ≠ 原價 ⇒ 名稱後加「(自訂單價 $X)」。 */
  customUnitPrice: boolean;
  /** 已下架(不在上架清單裡)⇒ 加「(已下架)」灰字。 */
  inactive: boolean;
}

/** 表單摘要(F-4、F-6):每項 名稱 × 數量、小計 = 單價 × 數量;合計 = Σ 小計(含已下架)。 */
export function buildMaterialSummary(input: {
  ids: string[];
  quantities: Record<string, string>;
  unitPrices: Record<string, string>;
  activeItems: MaterialCostOption[];
  loaded: LoadedMaterialCosts;
  baselinePrice: (id: string) => number | null;
}): { rows: MaterialSummaryRow[]; total: number } {
  const rows: MaterialSummaryRow[] = [];
  for (const id of input.ids) {
    const active = input.activeItems.find((m) => m.id === id);
    const name = active?.name ?? input.loaded[id]?.name;
    if (!name) continue;
    const baseline = input.baselinePrice(id);
    const unitPrice = resolveUnitPrice(input.unitPrices[id], baseline) ?? 0;
    const quantity = parseItemQuantity(input.quantities[id]);
    rows.push({
      id,
      name,
      quantity,
      unitPrice,
      subtotal: roundCents(unitPrice * quantity),
      customUnitPrice: baseline !== null && unitPrice !== baseline,
      inactive: !active,
    });
  }
  const total = roundCents(rows.reduce((sum, row) => sum + row.subtotal, 0));
  return { rows, total };
}

/** 送出 payload(商家 / 服務人員共用)。單價一律送畫面上算的那個數字(跟摘要一致)。 */
export function buildMaterialCostPayload(input: {
  ids: string[];
  quantities: Record<string, string>;
  unitPrices: Record<string, string>;
  baselinePrice: (id: string) => number | null;
}): BookingMaterialCostSelectionInput[] {
  return input.ids.map((id) => ({
    materialCostItemId: id,
    quantity: parseItemQuantity(input.quantities[id]),
    unitPrice: resolveUnitPrice(input.unitPrices[id], input.baselinePrice(id)),
  }));
}

/** 金額顯示:「$1,512.5」(整數不帶小數;有小數最多兩位)。料錢允許小數單價,不能像 formatAmount 四捨五入到整數。 */
export function formatMaterialAmount(amount: number): string {
  return `$${amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

/** 摘要最下面那一行(13.3,括號半形)。 */
export function materialSummaryFooter(count: number, total: number): string {
  return `已選 ${count} 項，料錢合計 ${formatMaterialAmount(total)}(僅供操作者參考，不代表訂單金額)`;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
