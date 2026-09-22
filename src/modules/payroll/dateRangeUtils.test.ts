// 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:時間篩選改成可選區間的純函式單元測試,
// 核心是驗證前端擋下的臨界值(366/367 天)跟後端 raise exception 的臨界值完全對齊。

import { describe, expect, it } from "vitest";

import {
  MAX_RANGE_RAW_DAYS,
  firstDayOfMonth,
  lastDayOfMonth,
  rawDateDiffDays,
  validateDateRange,
} from "./dateRangeUtils";

describe("rawDateDiffDays", () => {
  it("同一天 → 0", () => {
    expect(rawDateDiffDays("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("相差 366 天(跟資料庫 date - date 語意一致)", () => {
    expect(rawDateDiffDays("2026-01-01", "2027-01-02")).toBe(366);
  });
});

describe("validateDateRange(§3.6 核心必測:前端擋下的臨界值要跟後端一致)", () => {
  it("合法區間 → null", () => {
    expect(validateDateRange("2026-01-01", "2026-01-31")).toBeNull();
  });

  it("結束日期早於起始日期 → 錯誤訊息跟後端 raise exception 文字對齊", () => {
    expect(validateDateRange("2026-02-01", "2026-01-01")).toBe("結束日期不能早於起始日期");
  });

  it(`剛好 ${MAX_RANGE_RAW_DAYS} 天(原始天數差)→ 合法`, () => {
    expect(validateDateRange("2026-01-01", "2027-01-02")).toBeNull();
  });

  it(`${MAX_RANGE_RAW_DAYS + 1} 天 → 錯誤訊息跟後端 raise exception 文字對齊`, () => {
    expect(validateDateRange("2026-01-01", "2027-01-03")).toBe("最長只能查詢一年範圍");
  });

  it("起訖任一為空字串 → 提示先選日期", () => {
    expect(validateDateRange("", "2026-01-01")).toBe("請選擇起訖日期");
    expect(validateDateRange("2026-01-01", "")).toBe("請選擇起訖日期");
  });
});

describe("firstDayOfMonth / lastDayOfMonth(按月份選擇時換算成實際日期區間)", () => {
  it("firstDayOfMonth: 2026-02 → 2026-02-01", () => {
    expect(firstDayOfMonth("2026-02")).toBe("2026-02-01");
  });

  it("lastDayOfMonth: 2026-02(非閏年)→ 2026-02-28", () => {
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
  });

  it("lastDayOfMonth: 2024-02(閏年)→ 2024-02-29", () => {
    expect(lastDayOfMonth("2024-02")).toBe("2024-02-29");
  });

  it("lastDayOfMonth: 大月 2026-01 → 2026-01-31", () => {
    expect(lastDayOfMonth("2026-01")).toBe("2026-01-31");
  });
});
