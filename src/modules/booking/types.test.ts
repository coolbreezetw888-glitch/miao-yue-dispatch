// 建單與訂單管理介面優化 §2:稅金說明文字依商家稅金模式(比例/固定金額)切換的邏輯測試。
// 模組 9(支付方式)§1.1/§1.3/§4:付款方式選項清單、fallback 預設值、代碼轉顯示文字邏輯測試。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS,
  getPaymentMethodLabel,
  getTaxModeHelperText,
  PAYMENT_METHOD_CODES,
  PAYMENT_METHOD_OPTIONS,
} from "./types";

describe("getTaxModeHelperText", () => {
  it("比例模式顯示稅率百分比說明文字", () => {
    expect(getTaxModeHelperText("percentage")).toBe("依商家設定稅率百分比,數字可個別調整。");
  });

  it("固定金額模式顯示稅額說明文字,不提百分比", () => {
    const text = getTaxModeHelperText("fixed");
    expect(text).toBe("依商家設定稅額,金額可個別調整。");
    expect(text).not.toContain("%");
    expect(text).not.toContain("百分比");
  });
});

describe("PAYMENT_METHOD_OPTIONS(模組 9 §1.1)", () => {
  it("擴充成 7 個固定選項,代碼跟顯示文字符合規格書表格", () => {
    expect(PAYMENT_METHOD_CODES).toHaveLength(7);
    expect(PAYMENT_METHOD_OPTIONS).toEqual({
      on_site: "現場付款",
      bank_transfer: "匯款",
      atm: "ATM 轉帳",
      linepay: "LINE Pay",
      jkopay: "街口支付",
      credit_card: "信用卡",
      no_payment: "無支付",
    });
  });
});

describe("DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS(模組 9 §1.3 Q3 暫定裁決)", () => {
  it("只有現場付款預設開啟,其餘 6 項預設關閉", () => {
    expect(DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS).toEqual({
      on_site: true,
      bank_transfer: false,
      atm: false,
      linepay: false,
      jkopay: false,
      credit_card: false,
      no_payment: false,
    });
  });

  it("涵蓋完整 7 個代碼,跟 PAYMENT_METHOD_CODES 一致,不遺漏任何一個", () => {
    const keys = Object.keys(DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS).sort();
    expect(keys).toEqual([...PAYMENT_METHOD_CODES].sort());
  });
});

describe("getPaymentMethodLabel(模組 9 §1.1/§3.3 Q2 暫定裁決)", () => {
  it("null 顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel(null)).toBe("尚未設定");
  });

  it("undefined 顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel(undefined)).toBe("尚未設定");
  });

  it("空字串顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel("")).toBe("尚未設定");
  });

  it("no_payment(無支付)顯示「無支付」,跟「尚未設定」明確區隔,不是同一組文字", () => {
    const label = getPaymentMethodLabel("no_payment");
    expect(label).toBe("無支付");
    expect(label).not.toBe("尚未設定");
  });

  it("新增的 6 個代碼都能正確翻譯成中文顯示文字", () => {
    expect(getPaymentMethodLabel("bank_transfer")).toBe("匯款");
    expect(getPaymentMethodLabel("atm")).toBe("ATM 轉帳");
    expect(getPaymentMethodLabel("linepay")).toBe("LINE Pay");
    expect(getPaymentMethodLabel("jkopay")).toBe("街口支付");
    expect(getPaymentMethodLabel("credit_card")).toBe("信用卡");
  });

  it("既有的 on_site 顯示文字不變", () => {
    expect(getPaymentMethodLabel("on_site")).toBe("現場付款");
  });

  it("對照表沒有的值(例如以後選項改名但沒轉舊資料),直接顯示原始值,不空白不報錯(§5 邊界情況 4)", () => {
    expect(getPaymentMethodLabel("some_unknown_legacy_value")).toBe("some_unknown_legacy_value");
  });
});
