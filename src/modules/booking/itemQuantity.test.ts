import { describe, expect, it } from "vitest";

import { parseItemQuantity } from "./itemQuantity";

describe("parseItemQuantity", () => {
  it("空字串(使用者把數量格子清空)回 1,不是 0", () => {
    // 這是整支函式存在的理由:過去金額預覽把 "" 當成 0(畫面顯示 $0),
    // 送出卻把 "" 當成 1(實際存 1 件的錢),兩邊對不上。
    expect(parseItemQuantity("")).toBe(1);
  });

  it('"0" 回 1(後端規則:quantity 最小為 1)', () => {
    expect(parseItemQuantity("0")).toBe(1);
  });

  it('"-3" 回 1', () => {
    expect(parseItemQuantity("-3")).toBe(1);
  });

  it('"2" 回 2', () => {
    expect(parseItemQuantity("2")).toBe(2);
  });

  it('"abc"(NaN)回 1', () => {
    expect(parseItemQuantity("abc")).toBe(1);
  });

  it("undefined(項目剛勾選、狀態還沒初始化)回 1", () => {
    expect(parseItemQuantity(undefined)).toBe(1);
  });

  it("null 回 1", () => {
    expect(parseItemQuantity(null)).toBe(1);
  });

  it("只有空白字元回 1", () => {
    expect(parseItemQuantity("   ")).toBe(1);
  });

  it("大於 1 的小數原封不動回傳(不取整,維持既有行為)", () => {
    expect(parseItemQuantity("2.5")).toBe(2.5);
  });

  it("小於 1 的小數回 1", () => {
    expect(parseItemQuantity("0.5")).toBe(1);
  });
});
