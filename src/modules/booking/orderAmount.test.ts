// 模組 6(訂單管理)§2.3/§4.8:前端金額即時預覽邏輯的單元測試,逐一驗證四種開關排列組合下的
// 計算結果都符合公式,並比照資料庫 pgTAP 測試(supabase/tests/database/module6_01_amount_engine.sql)
// 覆蓋相同的情境,確保前後端算出來的數字一致。

import { describe, expect, it } from "vitest";

import { calculateBookingAmountPreview, formatAmount } from "./orderAmount";
import type { AmountCalculationInput } from "./orderAmount";

const base: AmountCalculationInput = {
  itemsSubtotal: 1000,
  customTotalAmountEnabled: false,
  customTotalAmount: null,
  discountEnabled: false,
  discountMode: null,
  discountValue: null,
  taxEnabled: false,
  taxMode: null,
  taxValue: null,
};

describe("calculateBookingAmountPreview", () => {
  it("全部開關關閉時,最終金額就是逐項小計", () => {
    const result = calculateBookingAmountPreview(base);
    expect(result).toEqual({
      subtotalAmount: 1000,
      discountAmount: 0,
      taxAmount: 0,
      finalAmount: 1000,
      error: null,
    });
  });

  it("開啟自訂總金額時,取代逐項小計", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      customTotalAmountEnabled: true,
      customTotalAmount: 800,
    });
    expect(result.subtotalAmount).toBe(800);
    expect(result.finalAmount).toBe(800);
    expect(result.error).toBeNull();
  });

  it("折扣:固定金額模式直接扣除", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: 100,
    });
    expect(result.discountAmount).toBe(100);
    expect(result.finalAmount).toBe(900);
  });

  it("折扣:百分比模式依小計換算", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      discountEnabled: true,
      discountMode: "percentage",
      discountValue: 10,
    });
    expect(result.discountAmount).toBe(100);
    expect(result.finalAmount).toBe(900);
  });

  it("折扣金額超過小計時回傳錯誤訊息,不讓結果變成負的最終金額", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: 1500,
    });
    expect(result.error).toBe("折扣金額不能超過訂單小計");
  });

  it("稅金:以「折扣後金額」當課稅基礎,不是原始小計", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: 200,
      taxEnabled: true,
      taxMode: "percentage",
      taxValue: 5,
    });
    // 課稅基礎 = 1000 - 200 = 800,稅金 = 800 * 5% = 40,最終金額 = 1000 - 200 + 40 = 840
    expect(result.discountAmount).toBe(200);
    expect(result.taxAmount).toBe(40);
    expect(result.finalAmount).toBe(840);
  });

  it("稅金:固定金額模式不受課稅基礎影響", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      taxEnabled: true,
      taxMode: "fixed",
      taxValue: 50,
    });
    expect(result.taxAmount).toBe(50);
    expect(result.finalAmount).toBe(1050);
  });

  it("三個開關(自訂總金額+折扣+稅金)全部開啟的完整組合", () => {
    const result = calculateBookingAmountPreview({
      itemsSubtotal: 2000, // 開了自訂總金額,這個值理論上會被忽略
      customTotalAmountEnabled: true,
      customTotalAmount: 1000,
      discountEnabled: true,
      discountMode: "percentage",
      discountValue: 10, // 折扣 100
      taxEnabled: true,
      taxMode: "percentage",
      taxValue: 5, // (1000-100)*5% = 45
    });
    expect(result.subtotalAmount).toBe(1000);
    expect(result.discountAmount).toBe(100);
    expect(result.taxAmount).toBe(45);
    expect(result.finalAmount).toBe(945);
    expect(result.error).toBeNull();
  });

  it("開啟自訂總金額但沒有輸入金額時回傳錯誤訊息", () => {
    const result = calculateBookingAmountPreview({
      ...base,
      customTotalAmountEnabled: true,
      customTotalAmount: null,
    });
    expect(result.error).toBe("已開啟自訂總金額,請輸入金額");
  });
});

describe("formatAmount", () => {
  it("加上千分位符號跟錢字號前綴", () => {
    expect(formatAmount(1234)).toBe("$1,234");
    expect(formatAmount(1234.6)).toBe("$1,235");
  });

  it("null/undefined 顯示破折號,不是 $0 或 NaN", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(undefined)).toBe("—");
  });
});
