// 模組 6(訂單管理)§2.3/§4.8:金額計算的前端即時預覽邏輯,跟資料庫
// private.calculate_booking_amount(20260918110200_order_management_functions.sql)採用完全
// 相同的公式跟四捨五入規則(四捨五入到小數點後 2 位)。
//
// **這是體驗層,不是安全邊界**(規格書規則 2.2/§2.4 第 4 點):真正落地金額一律由後端
// create_booking/update_booking 依相同公式重新計算一次,不信任前端算好的結果。這支函式的用途
// 是讓客服在送出表單前就能看到金額明細,盡早發現輸入錯誤,不是取代後端驗證。

import type { AmountAdjustmentMode } from "./types";

export interface AmountCalculationInput {
  itemsSubtotal: number;
  customTotalAmountEnabled: boolean;
  customTotalAmount: number | null;
  discountEnabled: boolean;
  discountMode: AmountAdjustmentMode | null;
  discountValue: number | null;
  taxEnabled: boolean;
  taxMode: AmountAdjustmentMode | null;
  taxValue: number | null;
}

export interface AmountCalculationResult {
  subtotalAmount: number;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  /** 白話錯誤訊息(例如「折扣金額不能超過訂單小計」),體驗層先擋一次,真正的邊界仍在後端。
   * 沒有問題時是 null。 */
  error: string | null;
}

function roundTo2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 對應規格書 §2.3 計算順序:①小計(自訂總金額或逐項小計)②折扣(固定/百分比,不可超過小計)
 * ③稅金(以折扣後金額為課稅基礎)④最終金額(不可為負數)。任何一步不合法時,回傳目前算得出來的
 * 部分結果 + error 訊息,呼叫端據此顯示提示,不會拋出例外(這裡是 UI 預覽,不應該讓整個表單崩潰)。 */
export function calculateBookingAmountPreview(
  input: AmountCalculationInput,
): AmountCalculationResult {
  const {
    itemsSubtotal,
    customTotalAmountEnabled,
    customTotalAmount,
    discountEnabled,
    discountMode,
    discountValue,
    taxEnabled,
    taxMode,
    taxValue,
  } = input;

  // ①小計
  let subtotalAmount: number;
  if (customTotalAmountEnabled) {
    if (customTotalAmount === null || Number.isNaN(customTotalAmount)) {
      return {
        subtotalAmount: 0,
        discountAmount: 0,
        taxAmount: 0,
        finalAmount: 0,
        error: "已開啟自訂總金額,請輸入金額",
      };
    }
    subtotalAmount = customTotalAmount;
  } else {
    subtotalAmount = itemsSubtotal || 0;
  }

  // ②折扣
  let discountAmount = 0;
  if (discountEnabled) {
    if (discountMode === "fixed") {
      discountAmount = discountValue ?? 0;
    } else if (discountMode === "percentage") {
      discountAmount = roundTo2(subtotalAmount * ((discountValue ?? 0) / 100));
    } else {
      return {
        subtotalAmount,
        discountAmount: 0,
        taxAmount: 0,
        finalAmount: subtotalAmount,
        error: "請選擇折扣模式(固定金額或百分比)",
      };
    }
  }

  if (discountAmount > subtotalAmount) {
    return {
      subtotalAmount,
      discountAmount,
      taxAmount: 0,
      finalAmount: subtotalAmount,
      error: "折扣金額不能超過訂單小計",
    };
  }

  // ③稅金(以折扣後金額為課稅基礎)
  const taxableBase = subtotalAmount - discountAmount;
  let taxAmount = 0;
  if (taxEnabled) {
    if (taxMode === "fixed") {
      taxAmount = taxValue ?? 0;
    } else if (taxMode === "percentage") {
      taxAmount = roundTo2(taxableBase * ((taxValue ?? 0) / 100));
    } else {
      return {
        subtotalAmount,
        discountAmount,
        taxAmount: 0,
        finalAmount: taxableBase,
        error: "請選擇稅金模式(比例或固定金額)",
      };
    }
  }

  // ④最終金額
  const finalAmount = subtotalAmount - discountAmount + taxAmount;
  if (finalAmount < 0) {
    return {
      subtotalAmount,
      discountAmount,
      taxAmount,
      finalAmount,
      error: "計算出來的最終金額不能是負數,請確認折扣/稅金設定",
    };
  }

  return { subtotalAmount, discountAmount, taxAmount, finalAmount, error: null };
}

/** 金額格式化:整數金額加千分位符號,例如 1234.5 -> "$1,235"(四捨五入到整數顯示,實際存檔金額
 * 保留小數點後 2 位不受這裡影響——這支只負責畫面顯示文字)。 */
export function formatAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const rounded = Math.round(amount);
  return `$${rounded.toLocaleString("zh-TW")}`;
}
