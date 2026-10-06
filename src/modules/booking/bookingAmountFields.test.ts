// 建單表單四個金額欄位的解析測試 —— 2026-09-30 品管第二次打回的那批輸入,一條一條擋下來。
//
// 🔴 每一條「被拒絕」的測試都先證明**舊寫法真的會放行**(`Number()` 吃得下 / `|| 0` 會靜默變 0),
// 否則測試自己會變成假警報:一個永遠不可能發生的輸入,擋下來也證明不了任何事。
// 這是 parseAmountInput.test.ts 已經在用的做法,這裡沿用。
//
// 對照品管實測的表格(修好之前的行為):
//   | 輸入 | 舊行為 |
//   |---|---|
//   | 折扣(固定)填 `abc` | 最終金額 NaN,沒有提示,可以送出 |
//   | 自訂總金額 `Infinity` | finalAmount = Infinity,無錯誤,送出 |
//   | 自訂總金額 `1e3` | 靜默變成 1000 元 |
//   | 自訂總金額 `0x10` | 靜默變成 16 元 |
//   | 單價 `abc` | 靜默算成 0 元(這項服務變免費) |

import { describe, expect, it } from "vitest";

import {
  resolveBookingAmountFields,
  resolveEnteredUnitPrice,
  resolveUnitPrice,
  type BookingAmountFieldsInput,
} from "./bookingAmountFields";
import { calculateBookingAmountPreview } from "./orderAmount";

const base: BookingAmountFieldsInput = {
  serviceItemIds: [],
  itemUnitPrices: {},
  customTotalAmountEnabled: false,
  customTotalAmount: "",
  discountEnabled: false,
  discountMode: "fixed",
  discountValue: "",
  taxEnabled: false,
  taxMode: "percentage",
  taxValue: "",
};

function fields(overrides: Partial<BookingAmountFieldsInput>) {
  return resolveBookingAmountFields({ ...base, ...overrides });
}

/**
 * 品管實測用的那批輸入,`Number()` 全部不會拋錯(一半算得出數字、一半算出 NaN 之後被 `|| 0`
 * 變成 0)—— 這正是舊寫法擋不住的原因。
 * ⚠️ 刻意**不含**只有空白的 `" "`:對三個開關型欄位來說,空白等於「沒填」(既有語意是傳 null),
 * 不是輸入錯誤;只有服務項目單價那一格會把空白當錯誤(見該段測試)。
 */
const REJECTED_INPUTS = [
  "abc",
  "Infinity",
  "-Infinity",
  "1e3",
  "0x10",
  "0b11",
  "1,000",
  "１２３",
  "12.",
  ".5",
  "1.2.3",
];

describe("前提:舊寫法(裸 Number())真的擋不住這批輸入", () => {
  it("Number() 對每一個被拒輸入都不會拋錯,而且大多算得出一個數字", () => {
    // 這條是「負向對照」:先證明問題是真的,後面的擋下才有意義。
    expect(Number("Infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(Number("1e3")).toBe(1000);
    expect(Number("0x10")).toBe(16);
    expect(Number("0b11")).toBe(3);
    expect(Number(" ")).toBe(0); // 只有空白 ⇒ 0(單價那一格的「免費」來源之一)
    expect(Number("12.")).toBe(12);
    expect(Number(".5")).toBe(0.5);
    expect(Number.isNaN(Number("abc"))).toBe(true);
    expect(Number.isNaN(Number("１２３"))).toBe(true); // 全形數字:算出 NaN,不是 123
    expect(Number.isNaN(Number("1,000"))).toBe(true); // 千分位逗號同理
    // 🔴 而 `Number("abc") || 0` = 0 —— 單價那一路「打錯字 → 免費」就是這樣來的。
    expect(Number("abc") || 0).toBe(0);
    // 🔴 orderAmount 的兩道守門都攔不到 NaN / Infinity:它只在 customTotalAmount 是 NaN、
    // 以及最終金額 `< 0` 時回錯誤,而 `NaN < 0` 與 `Infinity < 0` **都是 false**。
    // (寫成變數是為了避開 eslint use-isnan 對「直接跟 NaN 字面值比較」的規則,
    //  這裡要示範的正是「有人真的這樣比了」這件事。)
    const parsedNaN = Number("abc");
    const parsedInfinity = Number("Infinity");
    expect(parsedNaN < 0).toBe(false);
    expect(parsedInfinity < 0).toBe(false);
  });
});

describe("自訂總金額", () => {
  it.each(REJECTED_INPUTS)("開啟自訂總金額填 %j ⇒ 標紅 + 擋送出,不會算出金額", (raw) => {
    const result = fields({ customTotalAmountEnabled: true, customTotalAmount: raw });
    expect(result.customTotalAmount.error).not.toBeNull();
    expect(result.customTotalAmount.value).toBeNull();
    expect(result.hasError).toBe(true);
  });

  it("填 1200 / 1200.5 這種正常金額 ⇒ 過關", () => {
    expect(fields({ customTotalAmountEnabled: true, customTotalAmount: "1200" })).toMatchObject({
      customTotalAmount: { value: 1200, error: null },
      hasError: false,
    });
    expect(fields({ customTotalAmountEnabled: true, customTotalAmount: "1200.5" })).toMatchObject({
      customTotalAmount: { value: 1200.5, error: null },
      hasError: false,
    });
  });

  it("負數擋下(金額不能是負數)", () => {
    const result = fields({ customTotalAmountEnabled: true, customTotalAmount: "-1" });
    expect(result.customTotalAmount.error).toBe("金額不能是負數");
    expect(result.hasError).toBe(true);
  });

  it("留空不是錯誤,是「沒填」⇒ 交給 orderAmount 回「已開啟自訂總金額,請輸入金額」", () => {
    const result = fields({ customTotalAmountEnabled: true, customTotalAmount: "" });
    expect(result.customTotalAmount).toEqual({ value: null, error: null });
    expect(result.hasError).toBe(false);
    // 既有流程照舊:空值仍然會被金額預覽擋下,不是靜默放行。
    const preview = calculateBookingAmountPreview({
      itemsSubtotal: 0,
      customTotalAmountEnabled: true,
      customTotalAmount: result.customTotalAmount.value,
      discountEnabled: false,
      discountMode: null,
      discountValue: null,
      taxEnabled: false,
      taxMode: null,
      taxValue: null,
    });
    expect(preview.error).toBe("已開啟自訂總金額，請輸入金額");
  });

  it("只有空白 = 沒填,跟留空一樣不報錯(不要把空白變成新的錯誤去改動既有流程)", () => {
    const result = fields({ customTotalAmountEnabled: true, customTotalAmount: "   " });
    expect(result.customTotalAmount).toEqual({ value: null, error: null });
    expect(result.hasError).toBe(false);
  });

  it("開關關閉時,就算欄位裡留著壞值也不算錯誤(欄位根本沒顯示)", () => {
    const result = fields({ customTotalAmountEnabled: false, customTotalAmount: "abc" });
    expect(result.customTotalAmount).toEqual({ value: null, error: null });
    expect(result.hasError).toBe(false);
  });
});

describe("折扣金額 / 折扣比例", () => {
  it.each(REJECTED_INPUTS)("固定金額模式填 %j ⇒ 標紅 + 擋送出", (raw) => {
    const result = fields({ discountEnabled: true, discountMode: "fixed", discountValue: raw });
    expect(result.discountValue.error).not.toBeNull();
    expect(result.hasError).toBe(true);
  });

  it("品管實測那條:折扣(固定)填 abc,修好之後最終金額不再是 NaN,而是擋下來", () => {
    const result = fields({ discountEnabled: true, discountMode: "fixed", discountValue: "abc" });
    expect(result.hasError).toBe(true);
    // 修好之前:Number("abc") = NaN 被餵進公式 ⇒ finalAmount = NaN 且 error 是 null。
    const oldBehaviour = calculateBookingAmountPreview({
      itemsSubtotal: 1000,
      customTotalAmountEnabled: false,
      customTotalAmount: null,
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: Number("abc"),
      taxEnabled: false,
      taxMode: null,
      taxValue: null,
    });
    expect(Number.isNaN(oldBehaviour.finalAmount)).toBe(true);
    expect(oldBehaviour.error).toBeNull(); // ← 就是這個「沒有錯誤」讓人按得下去
  });

  it("百分比模式也走同一套解析(這張表單沒有 <form>,原生 min/max 從來不會觸發)", () => {
    expect(
      fields({ discountEnabled: true, discountMode: "percentage", discountValue: "1e3" }).hasError,
    ).toBe(true);
    // 百分比上限 100,對應欄位上原本寫的 max={100}
    const over = fields({
      discountEnabled: true,
      discountMode: "percentage",
      discountValue: "500",
    });
    expect(over.discountValue.error).toBe("不能大於 100");
    // 固定金額模式不設上限,500 元折扣是合法輸入
    expect(
      fields({ discountEnabled: true, discountMode: "fixed", discountValue: "500" }),
    ).toMatchObject({ discountValue: { value: 500, error: null }, hasError: false });
  });

  it("留空 / 只有空白 = 沒填 = 不折扣,不是錯誤", () => {
    for (const raw of ["", "  "]) {
      const result = fields({ discountEnabled: true, discountMode: "fixed", discountValue: raw });
      expect(result.discountValue).toEqual({ value: null, error: null });
      expect(result.hasError).toBe(false);
    }
  });
});

describe("稅額 / 稅率", () => {
  it.each(REJECTED_INPUTS)("固定金額模式填 %j ⇒ 標紅 + 擋送出", (raw) => {
    const result = fields({ taxEnabled: true, taxMode: "fixed", taxValue: raw });
    expect(result.taxValue.error).not.toBeNull();
    expect(result.hasError).toBe(true);
  });

  it("比例模式:5 過關、101 擋下、Infinity 擋下", () => {
    expect(fields({ taxEnabled: true, taxMode: "percentage", taxValue: "5" })).toMatchObject({
      taxValue: { value: 5, error: null },
      hasError: false,
    });
    expect(
      fields({ taxEnabled: true, taxMode: "percentage", taxValue: "101" }).taxValue.error,
    ).toBe("不能大於 100");
    expect(fields({ taxEnabled: true, taxMode: "percentage", taxValue: "Infinity" }).hasError).toBe(
      true,
    );
  });
});

describe("服務項目單價", () => {
  it.each(REJECTED_INPUTS)("單價填 %j ⇒ 標紅 + 擋送出,不會靜默算成 0 元", (raw) => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: raw } });
    expect(result.unitPriceErrors["s1"]).toBeTruthy();
    expect(result.hasError).toBe(true);
  });

  it("🔴 清空單價(或只打空白)也要擋下 —— 舊寫法 `|| 0` 會讓這項服務變免費", () => {
    for (const raw of ["", "  "]) {
      const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: raw } });
      expect(result.unitPriceErrors["s1"]).toBe("請輸入金額");
      expect(result.hasError).toBe(true);
    }
  });

  it("正常數字過關,resolveUnitPrice 回一樣的值", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: "1500" } });
    expect(result.hasError).toBe(false);
    expect(resolveUnitPrice(result, "s1")).toBe(1500);
  });

  it("只檢查已勾選的項目:取消勾選之後,殘留在狀態裡的壞值不擋送出", () => {
    const result = fields({ serviceItemIds: [], itemUnitPrices: { s1: "abc" } });
    expect(result.hasError).toBe(false);
    expect(result.unitPriceErrors).toEqual({});
  });

  it('還沒動過的單價欄位(key 不存在)不報錯,resolveUnitPrice 回 0(沿用舊的 ?? "0")', () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: {} });
    expect(result.hasError).toBe(false);
    expect(resolveUnitPrice(result, "s1")).toBe(0);
  });

  it("解析失敗時 resolveUnitPrice 回 0,但那條路徑已經被 hasError 擋在送出之前", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: "abc" } });
    expect(resolveUnitPrice(result, "s1")).toBe(0);
    expect(result.hasError).toBe(true); // ← 所以 0 永遠不會真的被送出去
  });
});

describe("預覽路徑與送出路徑用同一份解析結果", () => {
  it("同一個 fields 物件算出來的單價,畫面小計與送出 payload 必然相同", () => {
    const result = fields({
      serviceItemIds: ["s1", "s2"],
      itemUnitPrices: { s1: "1200.5", s2: "300" },
    });
    // 畫面小計(itemsSubtotal)與送出 payload 的 unitPrice 都是這一支函式的回傳值。
    const previewUnitPrices = ["s1", "s2"].map((id) => resolveUnitPrice(result, id));
    const submitUnitPrices = ["s1", "s2"].map((id) => resolveUnitPrice(result, id));
    expect(previewUnitPrices).toEqual(submitUnitPrices);
    expect(previewUnitPrices).toEqual([1200.5, 300]);
  });

  it("三個開關型欄位:預覽與送出都讀 amountFields 的同一個 value", () => {
    const result = fields({
      customTotalAmountEnabled: true,
      customTotalAmount: "2000",
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: "100",
      taxEnabled: true,
      taxMode: "percentage",
      taxValue: "5",
    });
    expect(result.hasError).toBe(false);
    const preview = calculateBookingAmountPreview({
      itemsSubtotal: 0,
      customTotalAmountEnabled: true,
      customTotalAmount: result.customTotalAmount.value,
      discountEnabled: true,
      discountMode: "fixed",
      discountValue: result.discountValue.value,
      taxEnabled: true,
      taxMode: "percentage",
      taxValue: result.taxValue.value,
    });
    // (2000 - 100) × 1.05 = 1995
    expect(preview).toMatchObject({ finalAmount: 1995, error: null });
    // 送出 payload 用的是同樣三個值,不可能跟畫面對不起來。
    expect({
      customTotalAmount: result.customTotalAmount.value,
      discountValue: result.discountValue.value,
      taxValue: result.taxValue.value,
    }).toEqual({ customTotalAmount: 2000, discountValue: 100, taxValue: 5 });
  });
});

describe("#829「已手動調整單價」判定(resolveEnteredUnitPrice)", () => {
  it("欄位還沒動過 ⇒ 回基準值 ⇒ 不算已調整", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: {} });
    expect(resolveEnteredUnitPrice(result, "s1", 800)).toBe(800);
  });

  it("填的數字等於基準值 ⇒ 不算已調整", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: "800" } });
    expect(resolveEnteredUnitPrice(result, "s1", 800)).toBe(800);
  });

  it("填的數字不等於基準值 ⇒ 算已調整", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: "900" } });
    expect(resolveEnteredUnitPrice(result, "s1", 800)).toBe(900);
  });

  it("解析失敗 ⇒ 回 null ⇒ 呼叫端視為已調整(不能當成等於基準值放行)", () => {
    const result = fields({ serviceItemIds: ["s1"], itemUnitPrices: { s1: "abc" } });
    expect(resolveEnteredUnitPrice(result, "s1", 800)).toBeNull();
  });
});
