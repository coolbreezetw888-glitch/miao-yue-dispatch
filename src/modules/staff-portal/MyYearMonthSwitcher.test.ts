// 對應規格書 v2 §10.4.5:月份箭頭切換的年/月進位運算,依 ARCHITECTURE.md 第八節第 5 條/
// automated-testing SKILL 的要求,這類邊界運算要寫 Vitest。

import { describe, expect, it } from "vitest";

import { shiftYearMonth } from "./MyYearMonthSwitcher";

describe("shiftYearMonth", () => {
  it("一般情況下正確加減月份", () => {
    expect(shiftYearMonth(2026, 5, 1)).toEqual({ year: 2026, month: 6 });
    expect(shiftYearMonth(2026, 5, -1)).toEqual({ year: 2026, month: 4 });
  });

  it("12 月按下一月正確變成明年 1 月", () => {
    expect(shiftYearMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("1 月按上一月正確變成去年 12 月", () => {
    expect(shiftYearMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("連續多次位移(跨多個年份)也正確", () => {
    expect(shiftYearMonth(2026, 1, -13)).toEqual({ year: 2024, month: 12 });
    expect(shiftYearMonth(2026, 12, 13)).toEqual({ year: 2028, month: 1 });
  });
});
