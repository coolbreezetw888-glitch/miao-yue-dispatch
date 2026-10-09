// #1035 彈性計薪 C 批(自由公式)— 前端純函式。
// 規格書:母版 .project/specs/彈性計薪.md PC-U01、PX-03、PX-04、第七節 PT(vitest)。
//   - 「給什麼」選項多「自訂公式（進階）」;A 批四種的常數不變
//   - 插入欄位:游標位置、取代選取範圍、超過 300 字不插
//   - 存檔按鈕擋不擋(哪一條有錯、5 條上限、檢查中不擋)
//   - 草稿 ↔ 規則(公式規則只送 key / label / kind / text;名稱空白 ⇒「自訂公式」,不拿公式原文當名稱)
//   - 報表明細:公式規則不顯示公式原文;旗標白話
//   - 範例數字解析
//   - CSV 注入:公式規則名稱 =1+1 被跳脫
//   - 前端沒有任何公式求值(原始碼不含 eval / new Function)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BONUS_EDITOR_KIND_OPTIONS,
  BONUS_FLAG_NOTES,
  BONUS_FORMULA_DEFAULT_LABEL,
  BONUS_FORMULA_SNIPPETS,
  BONUS_RULE_KIND_LABELS,
  BONUS_RULE_KIND_OPTIONS,
  bonusFlagNotes,
  bonusFormulaItemSnippet,
  bonusFormulaServiceNameProblem,
  bonusRuleFromDraft,
  bonusRulesFromDrafts,
  buildStaffBonusCsvRows,
  createBonusRuleDraft,
  describeBonusRuleDraft,
  describeBonusRuleResult,
  draftFromBonusRule,
  formulaSaveBlocker,
  insertFormulaSnippet,
  parseFormulaSample,
  type BonusRuleDraft,
} from "./bonusRuleLogic";
import { buildCsvContentFromRows } from "./csvExport";
import type { BonusFormulaRule, BonusRuleResult } from "./types";

function formulaDraft(partial: Partial<BonusRuleDraft> = {}): BonusRuleDraft {
  return {
    ...createBonusRuleDraft([]),
    kind: "formula",
    formulaText: "完成單數 * 100",
    ...partial,
  };
}

function formulaResult(partial: Partial<BonusRuleResult> = {}): BonusRuleResult {
  return {
    key: "f1",
    label: "冷氣加碼",
    kind: "formula",
    metric: null,
    quantity: null,
    counted_quantity: null,
    range_start: null,
    range_end: null,
    achieved: null,
    amount: 600,
    flags: [],
    ...partial,
  };
}

describe("「給什麼」選項", () => {
  it("編輯器多一個「自訂公式（進階）」,放在最後;A 批四種常數不變", () => {
    expect(BONUS_EDITOR_KIND_OPTIONS.map((o) => o.label)).toEqual([
      "每單加錢",
      "每份加錢",
      "業績百分比",
      "達標給一筆",
      "自訂公式（進階）",
    ]);
    expect(BONUS_RULE_KIND_OPTIONS).toHaveLength(4);
    expect(BONUS_RULE_KIND_LABELS.formula).toBe("自訂公式");
  });
});

describe("insertFormulaSnippet(插入欄位的游標位置)", () => {
  const ifSnippet = BONUS_FORMULA_SNIPPETS.find((s) => s.label === "IF( , , )")!;
  const unitsSnippet = BONUS_FORMULA_SNIPPETS.find((s) => s.label === "完成數量")!;

  it("插在游標處,游標停在插入文字後面", () => {
    expect(insertFormulaSnippet("MAX( - 10, 0)", 4, 4, unitsSnippet)).toEqual({
      text: "MAX(完成數量 - 10, 0)",
      caret: 8,
    });
  });

  it("IF( , , ) 插入後游標停在第一個參數的位置", () => {
    expect(insertFormulaSnippet("", 0, 0, ifSnippet)).toEqual({ text: "IF(, , )", caret: 3 });
    expect(insertFormulaSnippet("1 + ", 4, 4, ifSnippet)).toEqual({
      text: "1 + IF(, , )",
      caret: 7,
    });
  });

  it("有選取範圍 ⇒ 取代選取的字", () => {
    expect(insertFormulaSnippet("業績 * 0.03", 0, 2, unitsSnippet)).toEqual({
      text: "完成數量 * 0.03",
      caret: 4,
    });
  });

  it("沒有游標資訊 ⇒ 接在最後;超出範圍的游標會被夾回來", () => {
    expect(insertFormulaSnippet("1 + ", null, null, unitsSnippet)?.text).toBe("1 + 完成數量");
    expect(insertFormulaSnippet("1 + ", 99, 99, unitsSnippet)?.text).toBe("1 + 完成數量");
  });

  it("插入後超過 300 字 ⇒ 不插(回 null)", () => {
    expect(insertFormulaSnippet("1".repeat(297), 297, 297, unitsSnippet)).toBeNull();
    expect(insertFormulaSnippet("1".repeat(296), 296, 296, unitsSnippet)?.text).toHaveLength(300);
  });

  it('指定服務:數量("冷氣清洗"),游標停在右括號後面', () => {
    const s = bonusFormulaItemSnippet("數量", "冷氣清洗");
    expect(s.insert).toBe('數量("冷氣清洗")');
    expect(insertFormulaSnippet("", 0, 0, s)).toEqual({ text: '數量("冷氣清洗")', caret: 10 });
    expect(bonusFormulaItemSnippet("業績", "水管").insert).toBe('業績("水管")');
  });
});

describe("bonusFormulaServiceNameProblem(服務名稱有引號不讓插入)", () => {
  it("名稱沒有引號 ⇒ 可以插入", () => {
    expect(bonusFormulaServiceNameProblem("冷氣清洗（分離式）")).toBeNull();
  });

  it("名稱有半形 / 全形 / 彎引號 ⇒ 不讓插入,提示先改名", () => {
    for (const name of ['冷氣"大"台', "冷氣＂大＂台", "冷氣“大”台"]) {
      expect(bonusFormulaServiceNameProblem(name)).toBe(
        `「${name}」的名稱裡有引號，公式沒辦法指定這個服務；請先到「服務項目」把名稱裡的引號拿掉。`,
      );
    }
  });
});

describe("formulaSaveBlocker(存檔按鈕要不要擋)", () => {
  const per = { ...createBonusRuleDraft([]), amount: "100" };

  it("沒有公式規則 ⇒ 不擋", () => {
    expect(formulaSaveBlocker([per], {})).toBeNull();
  });

  it("第 2 條公式檢查有錯 ⇒ 擋,訊息說第幾條", () => {
    const f = formulaDraft({ key: "f-2" });
    expect(
      formulaSaveBlocker([per, f], { "f-2": { status: "error", message: "不認識「完成台數」" } }),
    ).toBe("第 2 條規則的公式有錯誤，修正後才能存檔。");
  });

  it("公式空白 ⇒ 擋", () => {
    expect(formulaSaveBlocker([formulaDraft({ formulaText: "  " })], {})).toBe(
      "第 1 條規則的公式有錯誤，修正後才能存檔。",
    );
  });

  it("檢查中 / 可以使用 ⇒ 不擋(資料庫存檔時會再編譯一次)", () => {
    const f = formulaDraft({ key: "f-1" });
    expect(formulaSaveBlocker([f], { "f-1": { status: "checking" } })).toBeNull();
    expect(formulaSaveBlocker([f], { "f-1": { status: "ok" } })).toBeNull();
  });

  it("公式規則超過 5 條 ⇒ 擋", () => {
    const drafts = Array.from({ length: 6 }, (_, i) => formulaDraft({ key: `f-${i}` }));
    expect(formulaSaveBlocker(drafts, {})).toBe("一個方案最多 5 條自訂公式規則。");
    expect(formulaSaveBlocker(drafts.slice(0, 5), {})).toBeNull();
  });
});

describe("公式草稿 ↔ 規則", () => {
  it("只送 key / label / kind / text(去頭尾空白),不送 ast 也不送門檻等欄位", () => {
    const res = bonusRuleFromDraft(
      formulaDraft({
        key: "f1",
        label: " 冷氣加碼 ",
        formulaText: "  MAX(完成數量 - 10, 0) * 300 ",
      }),
    );
    expect(res.ok && res.rule).toEqual({
      key: "f1",
      label: "冷氣加碼",
      kind: "formula",
      text: "MAX(完成數量 - 10, 0) * 300",
    });
  });

  it("名稱空白 ⇒「自訂公式」(不拿公式原文當名稱,服務人員看得到名稱)", () => {
    const res = bonusRuleFromDraft(formulaDraft({ label: "" }));
    expect(res.ok && res.rule.label).toBe(BONUS_FORMULA_DEFAULT_LABEL);
    expect(res.ok && res.rule.label).not.toContain("完成單數");
  });

  it("公式空白 / 超過 300 字 ⇒ 欄位錯誤", () => {
    const empty = bonusRuleFromDraft(formulaDraft({ formulaText: " " }));
    expect(!empty.ok && empty.errors.formula).toBe("請輸入公式。");
    const long = bonusRuleFromDraft(formulaDraft({ formulaText: "1".repeat(301) }));
    expect(!long.ok && long.errors.formula).toBe("公式最多 300 個字。");
  });

  it("從資料庫讀回(帶 ast)⇒ 草稿 ⇒ 規則,來回一致(ast 不送回去)", () => {
    const stored: BonusFormulaRule = {
      key: "f1",
      label: "冷氣加碼",
      kind: "formula",
      text: "完成單數 * 100",
      ast: { t: "bin" },
    };
    const back = bonusRuleFromDraft(draftFromBonusRule(stored));
    expect(back.ok && back.rule).toEqual({
      key: "f1",
      label: "冷氣加碼",
      kind: "formula",
      text: "完成單數 * 100",
    });
  });

  it("編輯器摘要句:「自訂公式：…」;跟一般規則混在一起時整組照樣轉換", () => {
    expect(describeBonusRuleDraft(formulaDraft())).toBe("自訂公式：完成單數 * 100");
    const per = { ...createBonusRuleDraft([]), amount: "100" };
    const res = bonusRulesFromDrafts([per, formulaDraft({ key: "f-x" })]);
    expect(res.ok && res.rules.map((r) => r.kind)).toEqual(["per_unit", "formula"]);
  });
});

describe("報表明細:公式規則", () => {
  it("只說「依自訂公式計算」,不顯示公式原文", () => {
    expect(describeBonusRuleResult(formulaResult())).toBe("依自訂公式計算");
  });

  it("有旗標時接上白話說明", () => {
    expect(describeBonusRuleResult(formulaResult({ flags: ["division_by_zero"] }))).toBe(
      "依自訂公式計算（公式中有除以 0 的情況，該處以 0 計算。）",
    );
  });

  it("bonusFlagNotes:不認得的旗標略過、重複只出現一次", () => {
    expect(bonusFlagNotes(["capped", "unknown", "capped", "overflow"])).toEqual([
      BONUS_FLAG_NOTES["capped"],
      BONUS_FLAG_NOTES["overflow"],
    ]);
    expect(bonusFlagNotes(undefined)).toEqual([]);
    expect(BONUS_FLAG_NOTES["division_by_zero"]).toBe("公式中有除以 0 的情況，該處以 0 計算。");
  });

  it("CSV:公式規則名稱 =1+1 被跳脫,也不會出現公式原文", () => {
    const rows = buildStaffBonusCsvRows({
      has_any_plan: true,
      total_amount: 600,
      months: [{ month: "2026-10-01", amount: 600, rules: [formulaResult({ label: "=1+1" })] }],
    });
    expect(rows[2]).toEqual(["2026-10", "=1+1", "依自訂公式計算", 600]);
    const csv = buildCsvContentFromRows(rows);
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
    expect(csv).toContain("'=1+1");
  });
});

describe("parseFormulaSample(試算的範例數字)", () => {
  it("空白當 0,只回五個欄位", () => {
    expect(parseFormulaSample({ orders: "12", revenue: "120000.5" })).toEqual({
      orders: 12,
      units: 0,
      revenue: 120000.5,
      salary: 0,
      leave_days: 0,
    });
  });

  it("格式不對 / 千分位 / 負數 / 超過 10 億 ⇒ null", () => {
    expect(parseFormulaSample({ revenue: "100,000" })).toBeNull();
    expect(parseFormulaSample({ orders: "-1" })).toBeNull();
    expect(parseFormulaSample({ orders: "1e3" })).toBeNull();
    expect(parseFormulaSample({ revenue: "1000000001" })).toBeNull();
    expect(parseFormulaSample({ revenue: "1.12345" })).toBeNull();
  });
});

describe("PX-03:前端不做任何公式求值", () => {
  it("公式相關前端原始碼不含 eval / new Function", () => {
    for (const file of ["BonusFormulaFields.tsx", "bonusRuleLogic.ts", "BonusPlanSection.tsx"]) {
      const src = readFileSync(resolve(__dirname, file), "utf8");
      expect(src, file).not.toMatch(/\beval\s*\(/);
      expect(src, file).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});
