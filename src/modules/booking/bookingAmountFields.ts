// 建單 / 編輯預約表單的四個金額欄位:解析一次,預覽與送出共用同一份結果。
//
// ## 為什麼要有這支獨立的模組(2026-09-30 品管第二次抓到 + 主腦親自複查)
//
// ui-v1-full 第 2 批把建單表單的金額欄位從原生 `<input type="number" min={0} step="1">`
// 換成 `FieldAmountInput`(`type="text" inputMode="decimal"`)。**原生的 min / step 約束因此消失**,
// 但建單表單有 4 個這種欄位(自訂總金額 / 折扣金額 / 稅額 / 每個服務項目的單價),
// 當時 4 個全部沒有接上 `parseAmountInput`,送出路徑也仍然是裸 `Number()`。實測後果:
//
//   | 輸入 | 修好之前的行為 |
//   |---|---|
//   | 折扣(固定)填 `abc` | 最終金額變 NaN,**完全沒有錯誤提示,可以直接送出** |
//   | 自訂總金額填 `Infinity` | finalAmount = Infinity,無錯誤,送出 |
//   | 自訂總金額填 `1e3` | 靜默變成 1000 元 |
//   | 自訂總金額填 `0x10` | 靜默變成 16 元 |
//   | 服務項目單價填 `abc` | 靜默算成 0 元(**這項服務變免費**) |
//
// `orderAmount.ts` 擋不住這些:它只在 `customTotalAmount` 是 `NaN` 時、以及最終金額 `< 0` 時回傳錯誤,
// 而 **`NaN < 0` 與 `Infinity < 0` 都是 `false`**,兩者都會穿過去。單價那一路更是連 NaN 都不會產生
// ——舊寫法 `Number(x) || 0` 直接把 NaN 變成 0。
//
// 🔴 **這支模組存在的理由是「同一份解析結果」**:CalendarPage 裡金額欄位被讀了兩次
// (① 畫面即時預覽 `amountPreview`、② `handleSubmit` 真正送出的 payload),外加第三處
// (#829「已手動調整單價」的判定)。三處各自寫一份 `Number()` 就是這次回歸的根因
// ——畫面算得出來、按儲存卻被擋(或反過來)這種 bug 只要解析規則有一點不同就會出現。
// 所以這裡回傳的是**一個物件**,呼叫端三處都從它取值,不允許任何一處自己再 `Number()`。
//
// 另外兩件事刻意寫在這裡而不是頁面裡:
//   1. **折扣 / 稅金的「百分比」模式也走同一套解析。** 那兩個欄位是原生 `type="number"`,
//      看起來有 `min={0} max={100}`,但**建單表單的送出鈕是 `type="button"` + onClick、外面也沒有
//      `<form>`**(CalendarPage 裡 Email 驗證那段註解已經寫明這件事),所以瀏覽器的原生約束
//      **從來不會觸發**。而 `type="number"` 依 HTML 規格是接受 `1e3` 這種寫法的。
//      ⇒ 百分比模式一樣要靠這支函式擋,只是多帶一個 `max: 100`。
//   2. **「空白」不是錯誤,是「沒填」。** 三個開關型欄位留空的既有語意是傳 `null`
//      (自訂總金額留空由 `orderAmount` 回「已開啟自訂總金額,請輸入金額」,折扣/稅金留空 = 0),
//      這裡維持原樣,不要把空白變成欄位錯誤去改動既有流程。
//      🔴 **單價是唯一的例外**:它舊的 fallback 是 `|| 0`,正是「打錯字 → 這項服務免費」的來源,
//      所以單價欄位只要動過就一定要解析得出數字,空白也算錯誤(擋下,不當成 0)。

import { parseAmountInput, type ParseAmountInputResult } from "@/components/patterns";

import type { AmountAdjustmentMode } from "./types";

export interface BookingAmountFieldsInput {
  /** 目前已勾選的服務項目 id(只有這些項目的單價欄位會被解析 / 擋送出)。 */
  serviceItemIds: string[];
  /** 單價欄位的原始字串。**key 不存在 = 這個項目的單價欄位還沒被動過**,不是空字串。 */
  itemUnitPrices: Record<string, string>;
  customTotalAmountEnabled: boolean;
  customTotalAmount: string;
  discountEnabled: boolean;
  discountMode: AmountAdjustmentMode;
  discountValue: string;
  taxEnabled: boolean;
  taxMode: AmountAdjustmentMode;
  taxValue: string;
}

/** 「可以留空」的金額欄位解析結果:留空 / 開關關閉 ⇒ `value: null` 且 `error: null`。 */
export interface OptionalAmountField {
  value: number | null;
  error: string | null;
}

export interface BookingAmountFields {
  /**
   * 每個已勾選項目的單價解析結果。
   *   - key 不存在 ⇒ 欄位還沒被動過,呼叫端沿用自己原本的預設值(見 `resolveUnitPrice` /
   *     `resolveEnteredUnitPrice`)
   *   - `{ ok: true }` ⇒ 解析成功
   *   - `{ ok: false }` ⇒ 要標紅 + 擋送出
   */
  unitPrices: Record<string, ParseAmountInputResult>;
  /** 只放解析失敗的項目,直接丟進那一格的 `FormField error=`。 */
  unitPriceErrors: Record<string, string>;
  customTotalAmount: OptionalAmountField;
  discountValue: OptionalAmountField;
  taxValue: OptionalAmountField;
  /** 🔴 任何一格有錯 ⇒ 送出按鈕要 disabled,不能只顯示紅字。 */
  hasError: boolean;
}

/** 開關關閉或留空 ⇒ 沒填(`null`),不是錯誤;填了就一定要解析得出純十進位數字。 */
function parseOptionalAmountField(
  raw: string,
  enabled: boolean,
  options: { max?: number | undefined } = {},
): OptionalAmountField {
  if (!enabled) return { value: null, error: null };
  if (raw.trim() === "") return { value: null, error: null };
  const parsed = parseAmountInput(raw, options);
  if (!parsed.ok) return { value: null, error: parsed.error };
  return { value: parsed.value, error: null };
}

export function resolveBookingAmountFields(input: BookingAmountFieldsInput): BookingAmountFields {
  const unitPrices: Record<string, ParseAmountInputResult> = {};
  const unitPriceErrors: Record<string, string> = {};
  for (const id of input.serviceItemIds) {
    const raw = input.itemUnitPrices[id];
    // 還沒動過這一格 ⇒ 不解析、不報錯(畫面上顯示的是服務項目定價,不是使用者輸入的值)。
    if (raw === undefined) continue;
    // 單價允許小數(服務可能是 12.5 元),所以不傳 integerOnly;空白會被 parseAmountInput
    // 擋成「請輸入金額」——這是刻意的,舊的 `|| 0` 就是靜默免費的來源。
    const parsed = parseAmountInput(raw);
    unitPrices[id] = parsed;
    if (!parsed.ok) unitPriceErrors[id] = parsed.error;
  }

  // 百分比模式的上限 100 對應欄位上原本寫的 `max={100}`;固定金額模式不設上限。
  const customTotalAmount = parseOptionalAmountField(
    input.customTotalAmount,
    input.customTotalAmountEnabled,
  );
  const discountValue = parseOptionalAmountField(input.discountValue, input.discountEnabled, {
    max: input.discountMode === "percentage" ? 100 : undefined,
  });
  const taxValue = parseOptionalAmountField(input.taxValue, input.taxEnabled, {
    max: input.taxMode === "percentage" ? 100 : undefined,
  });

  const hasError =
    Object.keys(unitPriceErrors).length > 0 ||
    customTotalAmount.error !== null ||
    discountValue.error !== null ||
    taxValue.error !== null;

  return {
    unitPrices,
    unitPriceErrors,
    customTotalAmount,
    discountValue,
    taxValue,
    hasError,
  };
}

/**
 * 「金額要用的單價」——小計預覽與送出 payload **都走這一支**,所以兩邊永遠是同一個數字。
 * 欄位還沒動過或解析失敗時回 0:沿用舊的 `Number(x ?? "0") || 0` 行為,
 * 但解析失敗的情況已經被 `hasError` 擋在送出之前,不會真的送 0 出去。
 */
export function resolveUnitPrice(fields: BookingAmountFields, itemId: string): number {
  const parsed = fields.unitPrices[itemId];
  if (parsed === undefined || !parsed.ok) return 0;
  return parsed.value;
}

/**
 * #829「已手動調整單價」判定要用的值。跟 `resolveUnitPrice` 的差別只有兩個邊界:
 *   - 欄位還沒動過 ⇒ 回 `fallback`(該模式的基準值:新增看現價、編輯看載入時的快照),
 *     這樣「一打開還沒動任何東西」不會被誤判成已調整。
 *   - 解析失敗 ⇒ 回 `null`,呼叫端視為「已調整」(值是壞的,不能當成等於基準值放行)。
 */
export function resolveEnteredUnitPrice(
  fields: BookingAmountFields,
  itemId: string,
  fallback: number,
): number | null {
  const parsed = fields.unitPrices[itemId];
  if (parsed === undefined) return fallback;
  if (!parsed.ok) return null;
  return parsed.value;
}
