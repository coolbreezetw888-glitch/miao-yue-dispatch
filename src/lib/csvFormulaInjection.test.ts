// SPECS-INDEX #925:匯出 CSV 的公式注入防護 —— 共用跳脫函式的單元測試 + 全專案匯出點的守門測試。
// 規格書:.project/specs/通知權限與CSV公式注入修正.md 第二章。
//
// 【故障注入】把 src/lib/csv.ts 的 neutralizeCsvFormula 改成直接 `return value;`(拿掉判斷)
//   → 本檔「六種開頭字元」「組合情境」「兩支 payroll builder」與三個頁面整合測試全部轉紅。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CSV_FORMULA_TRIGGER_CHARS,
  buildCsvContent,
  escapeCsvCell,
  neutralizeCsvFormula,
  parseCsvText,
  unescapeCsvFormulaGuard,
} from "./csv";
import {
  buildCsvContent as buildPayrollCsvContent,
  buildCsvContentFromRows,
} from "@/modules/payroll/csvExport";

describe("escapeCsvCell — 公式注入防護(#925)", () => {
  it.each([
    ["=", '=HYPERLINK("http://evil","點我")'],
    ["+", "+886912345678"],
    ["-", "-2+3"],
    ["@", "@SUM(A1:A9)"],
  ])("字串以「%s」開頭 → 前面補一個單引號", (_char, value) => {
    const out = escapeCsvCell(value);
    // 有雙引號的會被 RFC 4180 包起來,所以只檢查「去掉外層雙引號後」的開頭
    const unwrapped = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    expect(unwrapped).toBe(`'${value}`);
  });

  it("字串以 Tab 開頭 → 補單引號(Tab 不需要雙引號包)", () => {
    expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
  });

  it("字串以歸位字元 \\r 開頭 → 補單引號,而且因為含 \\r 整格用雙引號包起來", () => {
    expect(escapeCsvCell("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("觸發字元清單 = 規格書指定的六個 + #1052 H2-11 補的全形四個", () => {
    expect([...CSV_FORMULA_TRIGGER_CHARS].sort()).toEqual(
      ["\t", "\r", "+", "-", "=", "@", "＝", "＋", "－", "＠"].sort(),
    );
  });

  it("#1052 H2-11:開頭有空白再接觸發字元、全形觸發字元 → 也補單引號", () => {
    expect(escapeCsvCell("  =1+1")).toBe("'  =1+1");
    expect(escapeCsvCell("　=1+1")).toBe("'　=1+1");
    expect(escapeCsvCell("＝SUM(A1)")).toBe("'＝SUM(A1)");
    expect(escapeCsvCell("＋886")).toBe("'＋886");
    expect(escapeCsvCell("－5")).toBe("'－5");
    expect(escapeCsvCell("＠x")).toBe("'＠x");
    // 開頭空白但後面不是觸發字元、或整格只有空白 → 不動
    expect(escapeCsvCell("  王小明")).toBe("  王小明");
    expect(escapeCsvCell("   ")).toBe("   ");
  });

  it("#1052 H2-11:匯入端對稱還原(空白 / 全形開頭)", () => {
    for (const original of ["  =x", "'  =x", "＝x", "'＝x", " ＠x", "  abc", "'  abc"]) {
      const exported = escapeCsvCell(original);
      const csv = buildCsvContent(["欄"], [[original]]);
      expect(parseCsvText(csv).rows[0]![0]).toBe(original);
      expect(unescapeCsvFormulaGuard(String(neutralizeCsvFormula(original)))).toBe(original);
      expect(exported.length).toBeGreaterThanOrEqual(original.length);
    }
  });

  it("一般文字原樣不動(中間出現 = + - @ 不算,只看第一個字元)", () => {
    expect(escapeCsvCell("王小明")).toBe("王小明");
    expect(escapeCsvCell("剪髮+護髮")).toBe("剪髮+護髮");
    expect(escapeCsvCell("a=b")).toBe("a=b");
    expect(escapeCsvCell("2026-10-01")).toBe("2026-10-01");
    expect(escapeCsvCell("'已經有單引號")).toBe("'已經有單引號");
  });

  it("🔴 number 型別的負數不加單引號(否則 Excel 變文字無法加總)", () => {
    expect(escapeCsvCell(-100)).toBe("-100");
    expect(escapeCsvCell(-0.5)).toBe("-0.5");
    expect(escapeCsvCell(0)).toBe("0");
    expect(neutralizeCsvFormula(-100)).toBe(-100);
  });

  it("null / undefined / 空字串 → 空格子", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell("")).toBe("");
  });

  it("組合:危險開頭 + 逗號 → 先補單引號再整格包雙引號", () => {
    expect(escapeCsvCell("=1,2")).toBe('"\'=1,2"');
  });

  it("組合:危險開頭 + 雙引號 → 補單引號,內部雙引號變兩個", () => {
    expect(escapeCsvCell('=A1&"x"')).toBe('"\'=A1&""x"""');
  });

  it("組合:危險開頭 + 換行", () => {
    expect(escapeCsvCell("-第一行\n第二行")).toBe('"\'-第一行\n第二行"');
  });

  it("沒有危險開頭但含逗號 / 雙引號 / 換行 → 照既有 RFC 4180 規則", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('他說"好"')).toBe('"他說""好"""');
    expect(escapeCsvCell("一\n二")).toBe('"一\n二"');
  });
});

describe("匯入端反向處理(規則 4:匯出 → 修正 → 再匯入 不多也不少一個單引號)", () => {
  it("unescapeCsvFormulaGuard 只拿掉「單引號 + 觸發字元」的那個單引號", () => {
    expect(unescapeCsvFormulaGuard("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(unescapeCsvFormulaGuard("'+886912345678")).toBe("+886912345678");
    expect(unescapeCsvFormulaGuard("'-100")).toBe("-100");
    expect(unescapeCsvFormulaGuard("'@me")).toBe("@me");
    expect(unescapeCsvFormulaGuard("'\tx")).toBe("\tx");
    // 一般以單引號開頭的資料不動
    expect(unescapeCsvFormulaGuard("'小名'")).toBe("'小名'");
    expect(unescapeCsvFormulaGuard("'")).toBe("'");
    expect(unescapeCsvFormulaGuard("王小明")).toBe("王小明");
  });

  it("buildCsvContent 匯出 → parseCsvText 讀回,每一格與原值完全相同", () => {
    const original = [
      ['=HYPERLINK("http://evil")', "+886912345678", "-備註,有逗號", "@x", "\t開頭", "一般"],
      ["王小明", "0912345678", "VIP\n換行", "'本來就有單引號", "a=b", ""],
    ];
    const headers = ["a", "b", "c", "d", "e", "f"];
    const parsed = parseCsvText(buildCsvContent(headers, original));
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual(original);
  });
});

// 主腦 2026-10-01 QA 後追加:匯出 / 匯入完全對稱。
// 【故障注入】把 neutralizeCsvFormula 改回「只看第一個字元」→ 下面「'=x 匯出成 ''=x」與
//   往返測試的 '=x / ''=x / '+886 三格轉紅(匯入端拿掉一個單引號後少一個字)。
describe("匯出 / 匯入完全對稱(單引號 + 觸發字元開頭的原始資料)", () => {
  it("'=x 匯出時再補一個單引號 → ''=x;匯入拿掉一個 → 還原成 '=x", () => {
    expect(escapeCsvCell("'=x")).toBe("''=x");
    expect(unescapeCsvFormulaGuard("''=x")).toBe("'=x");
    expect(escapeCsvCell("''=x")).toBe("'''=x");
    expect(unescapeCsvFormulaGuard("'''=x")).toBe("''=x");
  });

  it("單引號開頭但後面不是觸發字元 → 匯出、匯入都不動", () => {
    expect(escapeCsvCell("'abc")).toBe("'abc");
    expect(unescapeCsvFormulaGuard("'abc")).toBe("'abc");
    expect(escapeCsvCell("'")).toBe("'");
    expect(unescapeCsvFormulaGuard("'")).toBe("'");
  });

  it("往返:'=x、=x、''=x、'+886、一般文字、數字(含負數)讀回來完全相同", () => {
    const strings = ["'=x", "=x", "''=x", "'+886912345678", "王小明", "'abc", "a=b", "@x"];
    const parsedStrings = parseCsvText(
      buildCsvContent(
        ["v"],
        strings.map((s) => [s]),
      ),
    );
    expect(parsedStrings.rows.map((r) => r[0])).toEqual(strings);

    const numbers = [-100, 0, 3.5];
    const csv = buildCsvContent(
      ["n"],
      numbers.map((n) => [n]),
    );
    expect(csv).toBe("﻿n\r\n-100\r\n0\r\n3.5");
    const parsedNumbers = parseCsvText(csv);
    expect(parsedNumbers.rows.map((r) => Number(r[0]))).toEqual(numbers);
  });
});

describe("模組 8 的 payroll/csvExport 也走同一支共用函式", () => {
  it("buildCsvContent(payroll 版)擋得住危險開頭,負數 number 不動", () => {
    expect(buildPayrollCsvContent(["客戶", "金額"], [["=1+1", -100]])).toBe(
      "﻿客戶,金額\r\n'=1+1,-100",
    );
  });

  it("buildCsvContentFromRows(帳務報表總計 + 明細疊在一起那一支)擋得住危險開頭", () => {
    expect(buildCsvContentFromRows([["@姓名", -5], [], ["+886", 3]])).toBe(
      "﻿'@姓名,-5\r\n\r\n'+886,3",
    );
  });
});

// =========================================================================
// 守門:全專案只有一份跳脫邏輯;所有觸發 CSV 下載的地方都用這兩個 builder 模組
// =========================================================================
const SRC = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({
  rel: relative(SRC, f).replace(/\\/g, "/"),
  text: readFileSync(f, "utf8"),
}));

describe("CSV 匯出點盤點守門(#925)", () => {
  it("只有 src/lib/csv.ts 定義 escapeCsvCell(不准再出現第二份不含防護的跳脫函式)", () => {
    const definers = files
      .filter((f) => /function\s+escapeCsvCell\b|escapeCsvCell\s*=\s*\(/.test(f.text))
      .map((f) => f.rel);
    expect(definers).toEqual(["lib/csv.ts"]);
  });

  it("payroll/csvExport.ts 的跳脫函式是從 @/lib/csv import 來的", () => {
    const payroll = files.find((f) => f.rel === "modules/payroll/csvExport.ts")!;
    expect(payroll.text).toMatch(/import\s*\{\s*escapeCsvCell\s*\}\s*from\s*"@\/lib\/csv"/);
  });

  it("只有兩個 builder 模組自己組 text/csv 的 Blob(其他地方不准繞過 builder 直接產生 CSV)", () => {
    const blobMakers = files.filter((f) => /text\/csv/.test(f.text) && /new Blob/.test(f.text));
    expect(blobMakers.map((f) => f.rel).sort()).toEqual(
      ["lib/csv.ts", "modules/payroll/csvExport.ts"].sort(),
    );
  });

  it("所有呼叫 downloadCsv 的檔案就是盤點清單上的那幾個,而且 builder 都來自這兩個模組", () => {
    const callers = files
      .filter((f) => /\bdownloadCsv\s*\(/.test(f.text))
      .filter((f) => !["lib/csv.ts", "modules/payroll/csvExport.ts"].includes(f.rel));
    expect(callers.map((f) => f.rel).sort()).toEqual(
      [
        "modules/data-tools/ImportWizardPage.tsx",
        "modules/data-tools/ReportExportCenterPage.tsx",
        "modules/payroll/BillingReportPage.tsx",
        "modules/payroll/StaffReportPage.tsx",
        // #1035 B 批 PB-B02:日薪／時薪服務人員報表(走 ./csvExport 的 buildCsvContent,有公式注入防護)。
        "modules/payroll/WageStaffReport.tsx",
      ].sort(),
    );
    for (const f of callers) {
      expect(
        /from\s*"@\/lib\/csv"/.test(f.text) || /from\s*"\.\/csvExport"/.test(f.text),
        `${f.rel} 必須從 @/lib/csv 或 ./csvExport 取得 builder`,
      ).toBe(true);
    }
  });
});
