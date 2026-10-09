// #1035 彈性計薪 A 批:規則摘要句、草稿驗證、報表明細文字、CSV(含公式注入防護)。
import { describe, expect, it } from "vitest";

import {
  BONUS_RULE_KIND_OPTIONS,
  bonusRuleFromDraft,
  bonusRulesFromDrafts,
  buildStaffBonusCsvRows,
  createBonusRuleDraft,
  describeBonusRule,
  describeBonusRuleDraft,
  describeBonusRuleResult,
  draftFromBonusRule,
  formatBonusMonthLabel,
  partialMonthsNotice,
  shouldShowMonthlyBonusCard,
  shouldShowStaffBonusSection,
  summarizeBonusPlanRules,
  type DescribableBonusRule,
} from "./bonusRuleLogic";
import { buildCsvContentFromRows } from "./csvExport";
import type { BonusRule, BonusRuleResult } from "./types";

function rule(partial: Partial<DescribableBonusRule>): DescribableBonusRule {
  return {
    kind: "per_unit",
    metric: "units",
    threshold: 0,
    cap: null,
    amount: 300,
    percent: null,
    retroactive: false,
    service_item_ids: [],
    ...partial,
  };
}

describe("describeBonusRule(每張規則卡下方的白話摘要句)", () => {
  it("規格書三個範例", () => {
    expect(describeBonusRule(rule({ threshold: 10, amount: 300 }))).toBe(
      "超過 10 份之後，第 11 份起每份加 300 元",
    );
    expect(
      describeBonusRule(
        rule({ kind: "percent", metric: "revenue", threshold: 100000, amount: null, percent: 5 }),
      ),
    ).toBe("業績超過 100,000 元的部分，加 5%");
    expect(
      describeBonusRule(rule({ kind: "lump_sum", metric: "orders", threshold: 30, amount: 3000 })),
    ).toBe("這個月完成滿 30 單，加 3,000 元");
  });

  it("每單 / 每份:T=0、有上限、整月都算", () => {
    expect(describeBonusRule(rule({ kind: "per_order", metric: "orders", amount: 100 }))).toBe(
      "每單加 100 元",
    );
    expect(describeBonusRule(rule({ threshold: 10, cap: 20 }))).toBe("第 11～20 份，每份加 300 元");
    expect(describeBonusRule(rule({ threshold: 10, retroactive: true }))).toBe(
      "這個月完成超過 10 份，整月每份都加 300 元",
    );
    expect(describeBonusRule(rule({ threshold: 10, cap: 20, retroactive: true }))).toBe(
      "這個月完成超過 10 份，第 1～20 份每份都加 300 元",
    );
  });

  it("業績百分比:T=0、有上限、整月都算、小數百分比", () => {
    const pct = (p: Partial<DescribableBonusRule>) =>
      describeBonusRule(
        rule({ kind: "percent", metric: "revenue", amount: null, percent: 5, ...p }),
      );
    expect(pct({})).toBe("業績的 5%");
    expect(pct({ threshold: 100000, cap: 200000 })).toBe(
      "業績 100,000～200,000 元之間的部分，加 5%",
    );
    expect(pct({ threshold: 100000, retroactive: true })).toBe(
      "這個月業績超過 100,000 元，整月業績都加 5%",
    );
    expect(pct({ percent: 3.33 })).toBe("業績的 3.33%");
  });

  it("達標給一筆:三種量、T=0、有上限", () => {
    const lump = (p: Partial<DescribableBonusRule>) =>
      describeBonusRule(rule({ kind: "lump_sum", amount: 1000, ...p }));
    expect(lump({ metric: "units", threshold: 50 })).toBe("這個月完成滿 50 份，加 1,000 元");
    expect(lump({ metric: "revenue", threshold: 100000 })).toBe(
      "這個月業績滿 100,000 元，加 1,000 元",
    );
    expect(lump({ metric: "orders", threshold: 0 })).toBe("這個月只要有完成的單，加 1,000 元");
    expect(lump({ metric: "orders", threshold: 10, cap: 20 })).toBe(
      "這個月完成滿 10 單、而且不超過 20 單，加 1,000 元",
    );
  });

  it("指定服務:前面加「只算「…」：」;找不到名稱時說幾項", () => {
    const names: Record<string, string> = { a: "冷氣清洗", b: "室內機" };
    expect(
      describeBonusRule(rule({ threshold: 10, service_item_ids: ["a", "b"] }), (id) => names[id]),
    ).toBe("只算「冷氣清洗、室內機」：超過 10 份之後，第 11 份起每份加 300 元");
    expect(describeBonusRule(rule({ service_item_ids: ["x", "y"] }))).toBe(
      "只算指定的 2 項服務：每份加 300 元",
    );
  });

  it("摘要句一律全形標點(不出現中文旁邊的半形 , :)", () => {
    const samples = [
      describeBonusRule(rule({ threshold: 10 })),
      describeBonusRule(
        rule({ kind: "percent", metric: "revenue", amount: null, percent: 5, threshold: 1000 }),
      ),
      describeBonusRule(rule({ service_item_ids: ["a"] }), () => "冷氣"),
    ];
    for (const text of samples) {
      expect(text).not.toMatch(/[一-鿿][,:]|[,:][一-鿿]/);
    }
  });
});

describe("規則種類選項", () => {
  it("A 批只有四種,沒有自訂公式", () => {
    expect(BONUS_RULE_KIND_OPTIONS.map((o) => o.label)).toEqual([
      "每單加錢",
      "每份加錢",
      "業績百分比",
      "達標給一筆",
    ]);
    expect(JSON.stringify(BONUS_RULE_KIND_OPTIONS)).not.toContain("公式");
  });
});

describe("bonusRuleFromDraft(送出前的體驗驗證)", () => {
  it("合法草稿 → 規則;名稱空白時用摘要句當名稱(截到 30 字)", () => {
    const draft = { ...createBonusRuleDraft([]), threshold: "10", amount: "300" };
    const r = bonusRuleFromDraft(draft);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule).toMatchObject({
        kind: "per_unit",
        metric: "units",
        threshold: 10,
        amount: 300,
        percent: null,
        cap: null,
      });
      expect(r.rule.label).toBe("超過 10 份之後，第 11 份起每份加 300 元");
      expect(r.rule.key).toMatch(/^[a-z0-9-]+$/);
    }
    const long = bonusRuleFromDraft(
      { ...draft, serviceItemIds: ["a"] },
      () => "一個名字很長很長很長很長的服務項目",
    );
    // 整句超過 30 字 ⇒ 拿掉「只算「…」：」前綴(不在半個字詞上截斷)。
    expect(long.ok && long.rule.label).toBe("超過 10 份之後，第 11 份起每份加 300 元");
    const veryLong = bonusRuleFromDraft({
      ...createBonusRuleDraft([]),
      kind: "lump_sum",
      lumpSumMetric: "revenue",
      threshold: "12345678.9",
      cap: "98765432.1",
      amount: "999999.99",
    });
    expect(veryLong.ok && veryLong.rule.label.length).toBe(30);
    expect(veryLong.ok && veryLong.rule.label.endsWith("…")).toBe(true);
  });

  it("數字錯誤時回欄位錯誤(全形標點)", () => {
    const base = createBonusRuleDraft([]);
    const r = bonusRuleFromDraft({ ...base, threshold: "abc", amount: "1.234", cap: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.threshold).toContain("0～100,000,000");
      expect(r.errors.amount).toContain("最多 2 位小數");
    }
    const capErr = bonusRuleFromDraft({ ...base, threshold: "10", cap: "10", amount: "1" });
    expect(!capErr.ok && capErr.errors.cap).toBe("要大於「超過多少後才開始算」。");
    const pctErr = bonusRuleFromDraft({ ...base, kind: "percent", threshold: "0", percent: "101" });
    expect(!pctErr.ok && pctErr.errors.percent).toContain("0～100");
  });

  it("達標給一筆:metric 由店家選、retroactive 一律 false;百分比規則 amount = null", () => {
    const lump = bonusRuleFromDraft({
      ...createBonusRuleDraft([]),
      kind: "lump_sum",
      lumpSumMetric: "revenue",
      threshold: "100000",
      amount: "3000",
      retroactive: true,
    });
    expect(lump.ok && lump.rule).toMatchObject({ metric: "revenue", retroactive: false });
    const pct = bonusRuleFromDraft({
      ...createBonusRuleDraft([]),
      kind: "percent",
      threshold: "0",
      percent: "5",
      amount: "99",
    });
    expect(pct.ok && pct.rule).toMatchObject({ metric: "revenue", amount: null, percent: 5 });
  });

  it("草稿 ↔ 規則來回一致", () => {
    const original: BonusRule = {
      key: "r1",
      label: "冷氣",
      kind: "per_unit",
      metric: "units",
      service_item_ids: ["a"],
      threshold: 10,
      cap: 20,
      amount: 300,
      percent: null,
      retroactive: true,
    };
    const back = bonusRuleFromDraft(draftFromBonusRule(original));
    expect(back.ok && back.rule).toEqual(original);
  });

  it("整組:任一條錯 ⇒ 回每條的錯誤;還沒填好時摘要句是 null", () => {
    const ok = { ...createBonusRuleDraft([]), amount: "100" };
    const bad = { ...createBonusRuleDraft([ok.key]), amount: "" };
    const res = bonusRulesFromDrafts([ok, bad]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorsByIndex[0]).toEqual({});
      expect(res.errorsByIndex[1]?.amount).toBeTruthy();
    }
    expect(describeBonusRuleDraft(bad)).toBeNull();
    expect(describeBonusRuleDraft(ok)).toBe("每份加 100 元");
  });
});

function result(partial: Partial<BonusRuleResult>): BonusRuleResult {
  return {
    key: "k",
    label: "x",
    kind: "per_unit",
    metric: "units",
    quantity: 13,
    counted_quantity: 3,
    range_start: 11,
    range_end: 13,
    achieved: null,
    amount: 900,
    ...partial,
  };
}

describe("describeBonusRuleResult(報表明細「算了多少」)", () => {
  it("每份 / 每單 / 業績 / 達標", () => {
    expect(describeBonusRuleResult(result({}))).toBe("第 11～13 份，共 3 份");
    expect(
      describeBonusRuleResult(
        result({ counted_quantity: 0, range_start: null, range_end: null, quantity: 8 }),
      ),
    ).toBe("完成 8 份，還沒超過門檻");
    expect(
      describeBonusRuleResult(
        result({
          kind: "per_order",
          metric: "orders",
          range_start: 11,
          range_end: 12,
          counted_quantity: 2,
        }),
      ),
    ).toBe("第 11～12 單，共 2 單");
    expect(
      describeBonusRuleResult(
        result({ kind: "percent", metric: "revenue", quantity: 15000, counted_quantity: 3000 }),
      ),
    ).toBe("業績 15,000 元，計入 3,000 元");
    expect(
      describeBonusRuleResult(
        result({ kind: "lump_sum", metric: "orders", quantity: 13, achieved: true }),
      ),
    ).toBe("已達標（完成 13 單）");
    expect(
      describeBonusRuleResult(
        result({ kind: "lump_sum", metric: "revenue", quantity: 5000, achieved: false }),
      ),
    ).toBe("未達標（業績 5,000 元）");
  });
});

describe("報表顯示條件", () => {
  it("店家報表「月薪獎金」卡只看 bonus_feature_used(缺鍵 / 載入中 ⇒ 不顯示)", () => {
    expect(shouldShowMonthlyBonusCard({ bonus_feature_used: true })).toBe(true);
    expect(shouldShowMonthlyBonusCard({ bonus_feature_used: false })).toBe(false);
    expect(shouldShowMonthlyBonusCard({})).toBe(false);
    expect(shouldShowMonthlyBonusCard(undefined)).toBe(false);
  });

  it("服務人員報表獎金區塊:沒有方案且每月 0 ⇒ 不顯示", () => {
    expect(shouldShowStaffBonusSection(undefined)).toBe(false);
    expect(
      shouldShowStaffBonusSection({
        has_any_plan: false,
        total_amount: 0,
        months: [{ amount: 0 }],
      }),
    ).toBe(false);
    expect(shouldShowStaffBonusSection({ has_any_plan: true, total_amount: 0, months: [] })).toBe(
      true,
    );
    expect(
      shouldShowStaffBonusSection({
        has_any_plan: false,
        total_amount: 500,
        months: [{ amount: 500 }],
      }),
    ).toBe(true);
  });

  it("不完整月份那一句 / 月份標籤 / 方案摘要", () => {
    expect(partialMonthsNotice([])).toBeNull();
    expect(partialMonthsNotice(["2026-09-01"])).toBe("這幾個月不是完整月份，不計算獎金：9 月");
    expect(partialMonthsNotice(["2025-12-01", "2026-01-01"])).toBe(
      "這幾個月不是完整月份，不計算獎金：2025 年 12 月、2026 年 1 月",
    );
    expect(formatBonusMonthLabel("2026-10-01", 2026)).toBe("10 月");
    expect(summarizeBonusPlanRules([{ label: "每單 100" }, { label: "超過 10 台" }])).toBe(
      "每單 100，另有 1 條規則",
    );
    expect(summarizeBonusPlanRules([])).toBe("還沒有規則");
  });
});

describe("服務人員報表 CSV 的獎金區塊(PX-04)", () => {
  const bonus = {
    has_any_plan: true,
    total_amount: 900,
    months: [{ month: "2026-10-01", amount: 900, rules: [result({ label: "=1+1" })] }],
  };

  it("沒有獎金 ⇒ 不加任何列", () => {
    expect(buildStaffBonusCsvRows({ has_any_plan: false, total_amount: 0, months: [] })).toEqual(
      [],
    );
    expect(buildStaffBonusCsvRows(undefined)).toEqual([]);
  });

  it("有獎金 ⇒ 空白列 + 標題 + 每條規則 + 合計", () => {
    expect(buildStaffBonusCsvRows(bonus)).toEqual([
      [],
      ["獎金月份", "規則名稱", "算了多少", "獎金金額"],
      ["2026-10", "=1+1", "第 11～13 份，共 3 份", 900],
      ["獎金合計", "", "", 900],
    ]);
  });

  it("規則名稱 =1+1 進 CSV 時被跳脫成文字(不會被 Excel 當公式)", () => {
    const csv = buildCsvContentFromRows(buildStaffBonusCsvRows(bonus));
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
    expect(csv).toContain("'=1+1");
  });
});
