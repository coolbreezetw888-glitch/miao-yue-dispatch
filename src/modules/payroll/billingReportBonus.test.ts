// #1035 彈性計薪 A 批 PA-B02:店家報表「月薪獎金」卡 / 明細 / CSV 的顯示判斷。
// 跟月薪三張卡同一套規則:不是完整月份 ⇒ 說明文字,不是 0;整店沒有任何方案 ⇒ 卡片與 CSV 那一列都不出現。
import { describe, expect, it } from "vitest";

import {
  BILLING_SUMMARY_LABELS,
  NET_MARGIN_BONUS_HELP,
  SALARY_UNAVAILABLE_TEXT,
  bonusCellText,
  bonusCsvCell,
  buildBillingCsvSummaryItems,
  shouldShowMonthlyBonus,
  type BillingCsvSummaryFields,
} from "./billingReportDisplay";

function fields(overrides: Partial<BillingCsvSummaryFields> = {}): BillingCsvSummaryFields {
  return {
    total_revenue_excl_tax: 50000,
    total_tax_amount: 0,
    total_material_cost: 1000,
    total_commission_payout: 2000,
    salary_applicable: true,
    total_monthly_salary_base: 30000,
    total_monthly_salary_deduction: 0,
    estimated_net_margin: 14800,
    points_feature_enabled: false,
    total_points_redeem_amount: 0,
    ...overrides,
  };
}

describe("月薪獎金卡 / CSV 那一列:只看 bonus_feature_used", () => {
  it("有方案 ⇒ 顯示;沒有 / 舊回應缺鍵 / 還沒載入 ⇒ 不顯示", () => {
    expect(shouldShowMonthlyBonus({ bonus_feature_used: true })).toBe(true);
    expect(shouldShowMonthlyBonus({ bonus_feature_used: false })).toBe(false);
    expect(shouldShowMonthlyBonus({})).toBe(false);
    expect(shouldShowMonthlyBonus(undefined)).toBe(false);
  });

  it("沒有方案的店:CSV 總計區跟改版前一模一樣(八列)", () => {
    const labels = buildBillingCsvSummaryItems(
      fields({ bonus_feature_used: false, total_monthly_bonus: 0 }),
    ).map((i) => i.label);
    expect(labels).not.toContain(BILLING_SUMMARY_LABELS.monthlyBonus);
    expect(labels).toHaveLength(8);
  });

  it("有方案、完整月份:最後多一列「月薪獎金」= total_monthly_bonus", () => {
    const items = buildBillingCsvSummaryItems(
      fields({ bonus_feature_used: true, total_monthly_bonus: 2200 }),
    );
    expect(items[items.length - 1]).toEqual({ label: "月薪獎金", value: 2200 });
  });

  it("有方案、不是完整月份:寫說明文字,不是 0", () => {
    const items = buildBillingCsvSummaryItems(
      fields({ bonus_feature_used: true, total_monthly_bonus: null, salary_applicable: false }),
    );
    expect(items[items.length - 1]).toEqual({ label: "月薪獎金", value: SALARY_UNAVAILABLE_TEXT });
  });

  it("獎金真的是 0 ⇒ 輸出 0(不是說明文字)", () => {
    const items = buildBillingCsvSummaryItems(
      fields({ bonus_feature_used: true, total_monthly_bonus: 0 }),
    );
    expect(items[items.length - 1]?.value).toBe(0);
  });
});

describe("明細「獎金」欄", () => {
  it("月薪列:完整月份 ⇒ 數字;不完整 ⇒ 說明文字;非月薪列 ⇒ 空白", () => {
    expect(bonusCsvCell(true, { compensation_type: "monthly_salary", bonus_amount: 900 })).toBe(
      900,
    );
    expect(bonusCsvCell(false, { compensation_type: "monthly_salary", bonus_amount: null })).toBe(
      SALARY_UNAVAILABLE_TEXT,
    );
    expect(bonusCsvCell(true, { compensation_type: "piece_rate", bonus_amount: null })).toBe("");
    expect(bonusCellText(true, 900)).toBe("獎金 900 元");
    expect(bonusCellText(false, null)).toBe(`獎金：${SALARY_UNAVAILABLE_TEXT}`);
  });

  it("商家總淨利說明多一句", () => {
    expect(NET_MARGIN_BONUS_HELP).toBe("月薪獎金也會從商家總淨利扣掉。");
  });
});
