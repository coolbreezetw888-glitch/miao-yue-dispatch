// 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:時間篩選改成可選區間的純函式單元測試,
// 核心是驗證前端擋下的臨界值(366/367 天)跟後端 raise exception 的臨界值完全對齊。

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RANGE_RAW_DAYS,
  currentMonthRange,
  firstDayOfMonth,
  lastDayOfMonth,
  monthRange,
  previousMonthRange,
  rawDateDiffDays,
  toMonthString,
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

// 2026-09-24 使用者裁決(月薪只在「選了完整月份」時才計算):報表期間選擇器新增「本月/上個月/
// 指定月份」三個一定產生「完整月份」區間的選項。這裡的必測重點是「結束日期一定是月底」——
// 只要不是月底,資料庫的 salary_applicable 就是 false,月薪數字就整個顯示不出來,所以這條是
// 這次改動的核心不變式,不是可有可無的邊角測試。
describe("完整月份區間(monthRange / currentMonthRange / previousMonthRange)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("toMonthString 用本地時間,不會因為時區在月初/月底跨月", () => {
    // 台北時間 2026-03-01 00:30(UTC 還是 2026-02-28 16:30)——用 UTC 會算成 2026-02,錯一個月。
    expect(toMonthString(new Date(2026, 2, 1, 0, 30))).toBe("2026-03");
    expect(toMonthString(new Date(2026, 11, 31, 23, 30))).toBe("2026-12");
  });

  it("monthRange: 起日是 1 號、訖日是月底(閏年 2 月也對)", () => {
    expect(monthRange("2026-02")).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ startDate: "2024-02-01", endDate: "2024-02-29" });
    expect(monthRange("2026-01")).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
  });

  it("currentMonthRange:月中查詢時結束日期取到**月底**,不是今天(這樣才算完整月份)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 24, 10, 0)); // 2026-09-24
    expect(currentMonthRange()).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30" });
  });

  it("previousMonthRange:上個月的完整區間", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 24, 10, 0)); // 2026-09-24
    expect(previousMonthRange()).toEqual({ startDate: "2026-08-01", endDate: "2026-08-31" });
  });

  it("previousMonthRange:1 月時要跨年退回前一年 12 月,不是同年的 0 月", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 10, 0)); // 2026-01-05
    expect(previousMonthRange()).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });

  it("previousMonthRange:3 月時退回 2 月,天數要跟著那一年的閏年狀況", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 31, 10, 0)); // 2024-03-31(閏年)
    expect(previousMonthRange()).toEqual({ startDate: "2024-02-01", endDate: "2024-02-29" });
  });

  it("這三支產出的區間都在一年上限之內(validateDateRange 必須放行)", () => {
    const ranges = [monthRange("2026-01"), monthRange("2024-02"), monthRange("2026-12")];
    for (const r of ranges) {
      expect(validateDateRange(r.startDate, r.endDate)).toBeNull();
    }
  });
});
