// 模組 8(薪資與帳務)§4.1/§7:即時預覽計算機純函式的單元測試,四種扣款模式 + 抽成計算各自
// 測試,涵蓋邊界值。比照資料庫 compute_booking_commission(規則 2.2)/private.compute_staff_payroll
// (規則 2.7)的公式,確保前端預覽數字跟後端實際計算結果一致。

import { describe, expect, it } from "vitest";

import {
  calculateDayRate,
  previewCommissionAmount,
  previewLeaveDeductionPerDay,
  roundToCents,
} from "./previewCalculators";

describe("roundToCents", () => {
  it("四捨五入到小數點第二位", () => {
    expect(roundToCents(100.005)).toBe(100.01);
    expect(roundToCents(100.004)).toBe(100.0);
    expect(roundToCents(0)).toBe(0);
  });
});

describe("previewCommissionAmount(規則 2.2)", () => {
  it("基準 1000、比例 10% → 100.00", () => {
    expect(previewCommissionAmount(1000, 10)).toBe(100);
  });

  it("比例 0% → 0(第〇節開頭原則:商家還沒設定比例前,預覽也應該顯示 0,不是隨便給一個非零數字)", () => {
    expect(previewCommissionAmount(1000, 0)).toBe(0);
  });

  it("基準 0 → 0", () => {
    expect(previewCommissionAmount(0, 50)).toBe(0);
  });

  it("非數字輸入時安全返回 0,不拋錯", () => {
    expect(previewCommissionAmount(Number.NaN, 10)).toBe(0);
    expect(previewCommissionAmount(1000, Number.NaN)).toBe(0);
  });

  it("四捨五入到分:900 × 33.33% = 299.97", () => {
    expect(previewCommissionAmount(900, 33.33)).toBe(299.97);
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
