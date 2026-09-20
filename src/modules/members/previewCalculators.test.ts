// 模組 10(會員與紅利)§4.3/§7:即時預覽計算機純函式的單元測試,涵蓋邊界值(比例為 0、金額為 0)。

import { describe, expect, it } from "vitest";

import { previewLoyaltyPoints } from "./previewCalculators";

describe("previewLoyaltyPoints(規則 2.1/3.7)", () => {
  it("金額 1000、比例 100 → 10 點", () => {
    expect(previewLoyaltyPoints(1000, 100)).toBe(10);
  });

  it("無法整除時無條件捨去:1050 / 100 → 10 點", () => {
    expect(previewLoyaltyPoints(1050, 100)).toBe(10);
  });

  it("比例為 0(尚未設定)→ 0,不會自己假設一個比例", () => {
    expect(previewLoyaltyPoints(1000, 0)).toBe(0);
  });

  it("比例為負數 → 0", () => {
    expect(previewLoyaltyPoints(1000, -10)).toBe(0);
  });

  it("金額為 0 → 0", () => {
    expect(previewLoyaltyPoints(0, 100)).toBe(0);
  });

  it("金額小於比例(算不到 1 點)→ 0", () => {
    expect(previewLoyaltyPoints(50, 100)).toBe(0);
  });

  it("非數字輸入時安全返回 0,不拋錯", () => {
    expect(previewLoyaltyPoints(Number.NaN, 100)).toBe(0);
    expect(previewLoyaltyPoints(1000, Number.NaN)).toBe(0);
  });
});
