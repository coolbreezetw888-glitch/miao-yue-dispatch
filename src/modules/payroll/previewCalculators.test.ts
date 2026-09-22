// 模組 8(薪資與帳務)§4.1/§7:即時預覽計算機純函式的單元測試,四種扣款模式 + 抽成計算各自
// 測試,涵蓋邊界值。比照資料庫 compute_booking_commission(規則 2.2)/private.compute_staff_payroll
// (規則 2.7)的公式,確保前端預覽數字跟後端實際計算結果一致。

import { describe, expect, it } from "vitest";

import {
  calculateDayRate,
  previewLeaveDeductionPerDay,
  previewServiceCommission,
  roundToCents,
} from "./previewCalculators";

describe("roundToCents", () => {
  it("四捨五入到小數點第二位", () => {
    expect(roundToCents(100.005)).toBe(100.01);
    expect(roundToCents(100.004)).toBe(100.0);
    expect(roundToCents(0)).toBe(0);
  });
});

describe("previewServiceCommission(商家端三項調整規格書 §二 2.8.2)", () => {
  it("percentage 模式:原價 1000、比例 10%、1 件 → 100.00", () => {
    expect(previewServiceCommission(1000, "percentage", 10, 1)).toBe(100);
  });

  it("percentage 模式,比例 0% → 0(尚未設定前,預覽也應該顯示 0,不是隨便給一個非零數字)", () => {
    expect(previewServiceCommission(1000, "percentage", 0, 1)).toBe(0);
  });

  it("percentage 模式,原價 0 → 0", () => {
    expect(previewServiceCommission(0, "percentage", 50, 1)).toBe(0);
  });

  it("percentage 模式,四捨五入到分:900 × 33.33% = 299.97", () => {
    expect(previewServiceCommission(900, "percentage", 33.33, 1)).toBe(299.97);
  });

  it("percentage 模式會乘上件數(基準本身就含件數,呼應 calculate_booking_staff_commission 的 raw_i)", () => {
    expect(previewServiceCommission(500, "percentage", 20, 2)).toBe(200);
  });

  it("fixed_amount 模式:固定 50 元/件、2 件 → 100(不受原價影響)", () => {
    expect(previewServiceCommission(1000, "fixed_amount", 50, 2)).toBe(100);
  });

  it("fixed_amount 模式,預設件數 1 → 直接等於固定金額", () => {
    expect(previewServiceCommission(1000, "fixed_amount", 75)).toBe(75);
  });

  it("非數字輸入時安全返回 0,不拋錯", () => {
    expect(previewServiceCommission(Number.NaN, "percentage", 10)).toBe(0);
    expect(previewServiceCommission(1000, "percentage", Number.NaN)).toBe(0);
    expect(previewServiceCommission(1000, "fixed_amount", Number.NaN)).toBe(0);
  });
});

describe("calculateDayRate(規則 2.7 day_rate)", () => {
  it("月薪 3000、折算 30 天 → 100", () => {
    expect(calculateDayRate(3000, 30)).toBe(100);
  });

  it("pay_days_per_month <= 0 時視為 0,避免除以 0", () => {
    expect(calculateDayRate(3000, 0)).toBe(0);
    expect(calculateDayRate(3000, -1)).toBe(0);
  });

  it("非數字輸入時安全返回 0", () => {
    expect(calculateDayRate(Number.NaN, 30)).toBe(0);
  });
});

describe("previewLeaveDeductionPerDay(規則 2.7 四種模式)", () => {
  const dayRate = 100;

  it("no_deduction → 0", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "no_deduction", null, null)).toBe(0);
  });

  it("full_day_rate → 等於 day_rate", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "full_day_rate", null, null)).toBe(100);
  });

  it("percentage_of_day_rate 50% → day_rate 的一半", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "percentage_of_day_rate", 50, null)).toBe(50);
  });

  it("percentage_of_day_rate 沒填百分比時視為 0(不預設非零數字)", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "percentage_of_day_rate", null, null)).toBe(0);
  });

  it("fixed_amount_per_day → 直接採用固定金額,不經過 day_rate 換算", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "fixed_amount_per_day", null, 80)).toBe(80);
  });

  it("fixed_amount_per_day 沒填金額時視為 0", () => {
    expect(previewLeaveDeductionPerDay(dayRate, "fixed_amount_per_day", null, null)).toBe(0);
  });
});
