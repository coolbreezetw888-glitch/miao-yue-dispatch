// 店家報表頁兩個「使用者親自裁決、但失敗模式完全沒有症狀」的顯示行為的單元測試。
//
// 這份測試存在的唯一理由:
//
//  行為 A —— salary_applicable === false 時,月薪相關的數字必須顯示「需選擇完整月份才能計算」,
//            **絕對不可以顯示 0**。資料庫刻意回傳 null 而不是 0,就是為了讓前端能分辨「這次算不
//            出來」與「真的是零」。如果哪天有人把 null 當成 0 處理(`?? 0` 只是一個字的改動),
//            商家會看到「月薪基本額 0 元、商家總淨利 = 營收全額」:畫面不會壞、不會有錯誤訊息,
//            只有老闆看到的獲利是假的。人工點畫面幾乎不可能發現這種錯,所以必須有測試守著。
//            => 底下每一條「不適用」的斷言都會額外跑一次 expectNeverLooksLikeZero(),明確釘死
//               「不是 0、不是 "0"、不是 "0 元"、不是空字串」。
//
//  行為 B —— is_active_as_of === false(查詢期間在職、現在已離職)的人照樣列在明細裡,那一列必須
//            有「已離職」標籤,CSV 也要有對應的欄位文字。少了標籤,商家看到一個名單上早就沒有的人
//            出現在報表裡,會以為系統壞了。
//
//  行為 C —— 同一個 commission_amount 是 null 時,畫面明細表顯示「0 元(抽成)」,CSV 卻寫一個空白格。
//            使用者裁決 A:兩邊統一 0(「按件計酬的人沒接單時抽成確實就是 0,那是真實數字」)。
//            會漂移的根本原因是兩條路徑各自寫死 fallback(`?? 0` 對 `?? ""`),所以這裡除了測值,
//            還有一條「CSV 的值 === 畫面字串裡解析出來的數字」的斷言,專門守住未來的漂移。
//
// 反向保護也一樣重要:值真的是 0(這個月扣款真的沒有)或負數(商家總淨利虧損 -5000)時,必須照實
// 顯示那個數字,不可以被「算不出來」吞掉。只測 happy path + 只測「不適用」都不夠,兩個方向都要測,
// 否則一個「永遠回傳說明文字」的壞函式也能讓測試全綠。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BILLING_SUMMARY_LABELS,
  type BillingCsvSummaryFields,
  COMMISSION_FALLBACK,
  COMPENSATION_TYPE_LABELS,
  CSV_PERIOD_LABEL,
  CSV_SUMMARY_AMOUNT_HEADER,
  CSV_SUMMARY_ITEM_HEADER,
  EMPLOYED_LABEL,
  RESIGNED_LABEL,
  SALARY_UNAVAILABLE_TEXT,
  type SalarySummaryFields,
  type StaffBreakdownRow,
  buildBillingCsvSummaryItems,
  buildBillingCsvSummarySection,
  commissionCellText,
  commissionCsvValue,
  compensationTypeText,
  employmentStatusCsvText,
  formatCsvPeriodText,
  isStillEmployed,
  monthlySalaryCellText,
  monthlySalaryCsvCell,
  resolveNetMonthlySalary,
  resolveSalaryDisplay,
  salaryCardValue,
  salaryDisplayValue,
  shouldShowResignedBadge,
  shouldShowSalaryUnavailableNotice,
} from "./billingReportDisplay";

// =========================================================================
// 測試用的小工具
// =========================================================================

/**
 * 行為 A 的核心斷言:這一格使用者看到的內容,絕對不可以是任何一種「看起來像 0」的東西。
 *
 * 四種都要擋:
 *   0      —— 數字 0(SummaryCard 會印成「0 元」)
 *   "0"    —— 字串 0(CSV 欄位)
 *   "0 元" —— 卡片/表格渲染後的樣子
 *   ""     —— 空白格(CSV 的空白格在 Excel 裡看起來跟 0 幾乎沒差別)
 */
function expectNeverLooksLikeZero(actual: unknown): void {
  expect(actual).not.toBe(0);
  expect(actual).not.toBe("0");
  expect(actual).not.toBe("0 元");
  expect(actual).not.toBe("");
}

/** 模擬 SummaryCard 的渲染規則(value 是 null/undefined → 顯示說明文字,否則印數字 + 「元」),
 * 讓斷言直接落在「使用者眼睛真的會看到的那串字」上,而不只是中間值。 */
function renderedSummaryCard(value: number | null): string {
  return value === null ? SALARY_UNAVAILABLE_TEXT : `${value.toLocaleString()} 元`;
}

function summaryFields(overrides: Partial<SalarySummaryFields> = {}): SalarySummaryFields {
  return {
    salary_applicable: true,
    total_monthly_salary_base: 30000,
    total_monthly_salary_deduction: 3000,
    ...overrides,
  };
}

function staffRow(overrides: Partial<StaffBreakdownRow> = {}): StaffBreakdownRow {
  return {
    staff_id: "11111111-1111-4111-8111-111111111111",
    staff_name: "阿明",
    compensation_type: "monthly_salary",
    order_count: 5,
    net_pay: 27000,
    commission_amount: null,
    is_active_as_of: true,
    ...overrides,
  };
}

// =========================================================================
// 行為 A:salary_applicable === false 時不能顯示 0
// =========================================================================

describe("resolveSalaryDisplay(行為 A 核心:分得出「算不出來」與「真的是零」)", () => {
  it("salary_applicable = true 且有數字 → 顯示這個數字", () => {
    expect(resolveSalaryDisplay(true, 30000)).toEqual({ kind: "value", value: 30000 });
  });

  it("salary_applicable = false → 顯示說明文字,而且絕對不是 0 / 「0」/ 空字串", () => {
    const display = resolveSalaryDisplay(false, null);

    expect(display).toEqual({ kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT });
    expectNeverLooksLikeZero(salaryCardValue(false, null));
    expectNeverLooksLikeZero(renderedSummaryCard(salaryCardValue(false, null)));
    expect(renderedSummaryCard(salaryCardValue(false, null))).toBe(SALARY_UNAVAILABLE_TEXT);
  });

  it("salary_applicable = false 但資料庫這一格竟然給了數字 → 旗標優先,還是顯示說明文字", () => {
    // 「旗標說不能算、卡片卻還印著一個數字」是最糟的不一致:那個數字的口徑一定是錯的
    // (原本的真 bug:2/15~3/15 會拿到兩個整月的基本額,而扣款那邊按區間裁切)。
    const display = resolveSalaryDisplay(false, 60000);

    expect(display.kind).toBe("unavailable");
    expect(salaryCardValue(false, 60000)).toBeNull();
  });

  it("salary_applicable = true 但這一格是 null(某位月薪制人員沒有 net_pay)→ 顯示說明文字", () => {
    const display = resolveSalaryDisplay(true, null);

    expect(display).toEqual({ kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT });
    expectNeverLooksLikeZero(salaryCardValue(true, null));
  });

  it("【反向保護】salary_applicable = true 且值真的是 0 → 顯示 0,不是說明文字", () => {
    // 這條是證明函式真的分得出兩件事:「這個月扣款真的是 0」是合法的真實數字,
    // 不可以被當成「算不出來」吞掉。少了這條,一個「永遠回傳說明文字」的壞函式也會全綠。
    expect(resolveSalaryDisplay(true, 0)).toEqual({ kind: "value", value: 0 });
    expect(salaryCardValue(true, 0)).toBe(0);
    expect(renderedSummaryCard(salaryCardValue(true, 0))).toBe("0 元");
    expect(renderedSummaryCard(salaryCardValue(true, 0))).not.toBe(SALARY_UNAVAILABLE_TEXT);
  });

  it("summary 還沒到(salaryApplicable = undefined)→ fail-closed,顯示說明文字不顯示數字", () => {
    // 這條路徑實際上走的是元件的 isLoading / error 分支,畫面不會渲染到這些顯示點;
    // 但型別如實反映 summary 可能是 undefined,所以函式的行為也要如實定義,而不是假裝不會發生。
    expect(resolveSalaryDisplay(undefined, undefined).kind).toBe("unavailable");
    expect(resolveSalaryDisplay(undefined, 30000).kind).toBe("unavailable");
    expectNeverLooksLikeZero(salaryCardValue(undefined, undefined));
  });
});

describe("salaryDisplayValue(SummaryCard 的 value prop)", () => {
  it("能算 → 數字;不能算 → null(SummaryCard 拿到 null 才會印說明文字)", () => {
    expect(salaryDisplayValue({ kind: "value", value: 27000 })).toBe(27000);
    expect(salaryDisplayValue({ kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT })).toBeNull();
  });

  it("值是 0 → 回傳 0 而不是 null(0 跟 null 在 SummaryCard 裡是兩種不同的顯示)", () => {
    expect(salaryDisplayValue({ kind: "value", value: 0 })).toBe(0);
    expect(salaryDisplayValue({ kind: "value", value: 0 })).not.toBeNull();
  });
});

describe("resolveNetMonthlySalary(月薪實發 = 基本額 − 扣款)", () => {
  it("兩邊都有值 → 相減", () => {
    expect(resolveNetMonthlySalary(summaryFields())).toEqual({ kind: "value", value: 27000 });
  });

  it("salary_applicable = false → 說明文字,絕對不是 0", () => {
    const display = resolveNetMonthlySalary(
      summaryFields({
        salary_applicable: false,
        total_monthly_salary_base: null,
        total_monthly_salary_deduction: null,
      }),
    );

    expect(display).toEqual({ kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT });
    expectNeverLooksLikeZero(salaryDisplayValue(display));
  });

  it("基本額是 null、扣款有值 → 說明文字,不可以算成 -3000", () => {
    // 這是「用 ?? 0 補其中一邊」最典型的災難:實發變成負數,看起來像是系統算出來的結果。
    const display = resolveNetMonthlySalary(
      summaryFields({ total_monthly_salary_base: null, total_monthly_salary_deduction: 3000 }),
    );

    expect(display.kind).toBe("unavailable");
    expect(salaryDisplayValue(display)).not.toBe(-3000);
  });

  it("基本額有值、扣款是 null → 說明文字,不可以直接把基本額當成實發", () => {
    const display = resolveNetMonthlySalary(
      summaryFields({ total_monthly_salary_base: 30000, total_monthly_salary_deduction: null }),
    );

    expect(display.kind).toBe("unavailable");
    expect(salaryDisplayValue(display)).not.toBe(30000);
  });

  it("【反向保護】基本額 = 扣款 → 實發真的是 0,要顯示 0 而不是說明文字", () => {
    expect(
      resolveNetMonthlySalary(
        summaryFields({ total_monthly_salary_base: 30000, total_monthly_salary_deduction: 30000 }),
      ),
    ).toEqual({ kind: "value", value: 0 });
  });

  it("summary 是 undefined(載入中/載入失敗)→ 說明文字,不會爆掉也不會算出 0", () => {
    const display = resolveNetMonthlySalary(undefined);

    expect(display.kind).toBe("unavailable");
    expectNeverLooksLikeZero(salaryDisplayValue(display));
  });
});

describe("商家總淨利(計算式含月薪成本,所以月薪算不出來時它也算不出來)", () => {
  it("salary_applicable = false → 說明文字,不可以退化成「不扣月薪的淨利」", () => {
    // 退化成不扣月薪的淨利,會比真實淨利高很多,比顯示不出來更危險。
    const display = resolveSalaryDisplay(false, null);

    expect(display).toEqual({ kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT });
    expectNeverLooksLikeZero(salaryCardValue(false, null));
  });

  it("salary_applicable = true 但 estimated_net_margin 是 null → 說明文字", () => {
    expect(resolveSalaryDisplay(true, null).kind).toBe("unavailable");
  });

  it("【反向保護】salary_applicable = true 且淨利是負數 -5000 → 顯示 -5000(虧損是合法的真實數字)", () => {
    // 虧損不是「算不出來」。把負數吞掉會讓商家永遠看不到自己在虧錢。
    expect(resolveSalaryDisplay(true, -5000)).toEqual({ kind: "value", value: -5000 });
    expect(salaryCardValue(true, -5000)).toBe(-5000);
    // 不比對千分位格式(toLocaleString 會跟執行環境的 locale 走),只確認它真的印出一個負數、
    // 而不是掉進「算不出來」那條路。
    expect(renderedSummaryCard(salaryCardValue(true, -5000))).not.toBe(SALARY_UNAVAILABLE_TEXT);
    expect(renderedSummaryCard(salaryCardValue(true, -5000))).toContain("5");
    expect(renderedSummaryCard(salaryCardValue(true, -5000)).startsWith("-")).toBe(true);
  });

  it("【反向保護】淨利剛好打平 0 → 顯示 0", () => {
    expect(salaryCardValue(true, 0)).toBe(0);
  });
});

describe("shouldShowSalaryUnavailableNotice(那段「為什麼算不出來」的說明區塊)", () => {
  it("salary_applicable = false → 顯示說明區塊", () => {
    expect(shouldShowSalaryUnavailableNotice(false)).toBe(true);
  });

  it("salary_applicable = true → 不顯示(每次查詢都跳出來會嚇到使用者)", () => {
    expect(shouldShowSalaryUnavailableNotice(true)).toBe(false);
  });

  it("undefined → 跟 resolveSalaryDisplay 同一個 fail-closed 方向", () => {
    expect(shouldShowSalaryUnavailableNotice(undefined)).toBe(true);
  });
});

describe("monthlySalaryCellText(明細表「抽成金額 / 月薪淨額」欄的月薪那一半)", () => {
  it("能算 → 「27000 元(淨額)」", () => {
    expect(monthlySalaryCellText(true, 27000)).toBe("27000 元(淨額)");
  });

  it("salary_applicable = false → 說明文字,不是「0 元(淨額)」", () => {
    const text = monthlySalaryCellText(false, null);

    expect(text).toBe(SALARY_UNAVAILABLE_TEXT);
    expectNeverLooksLikeZero(text);
    expect(text).not.toBe("0 元(淨額)");
  });

  it("salary_applicable = true 但這個人的 net_pay 是 null → 說明文字", () => {
    expect(monthlySalaryCellText(true, null)).toBe(SALARY_UNAVAILABLE_TEXT);
  });

  it("【反向保護】net_pay 真的是 0 → 「0 元(淨額)」,不是說明文字", () => {
    expect(monthlySalaryCellText(true, 0)).toBe("0 元(淨額)");
    expect(monthlySalaryCellText(true, 0)).not.toBe(SALARY_UNAVAILABLE_TEXT);
  });
});

describe("monthlySalaryCsvCell(CSV「月薪淨額」欄)", () => {
  it("月薪制 + 能算 → 數字本身(Excel 才能繼續加總)", () => {
    expect(monthlySalaryCsvCell(true, staffRow({ net_pay: 27000 }))).toBe(27000);
  });

  it("月薪制 + salary_applicable = false → 寫進說明文字,不留空白格也不寫 0", () => {
    const cell = monthlySalaryCsvCell(false, staffRow({ net_pay: null }));

    expect(cell).toBe(SALARY_UNAVAILABLE_TEXT);
    expectNeverLooksLikeZero(cell);
  });

  it("月薪制 + salary_applicable = true 但 net_pay 是 null → 說明文字", () => {
    expect(monthlySalaryCsvCell(true, staffRow({ net_pay: null }))).toBe(SALARY_UNAVAILABLE_TEXT);
  });

  it("【反向保護】月薪制 + net_pay 真的是 0 → 寫 0,不是說明文字", () => {
    expect(monthlySalaryCsvCell(true, staffRow({ net_pay: 0 }))).toBe(0);
  });

  it("抽成制的人 → 這一欄留空(他的錢在「抽成金額」那一欄),不受月薪旗標影響", () => {
    const row = staffRow({
      compensation_type: "piece_rate",
      net_pay: null,
      commission_amount: 800,
    });

    expect(monthlySalaryCsvCell(true, row)).toBe("");
    expect(monthlySalaryCsvCell(false, row)).toBe("");
  });
});

// =========================================================================
// 行為 C:抽成是 null 時,畫面跟 CSV 必須顯示同一件事
// =========================================================================

/**
 * 把明細表那一格使用者真正看到的字串,反解析回「畫面上顯示的那個數字」。
 *
 * 這支小工具是底下「兩條路徑必須一致」那條斷言的關鍵:如果只比對 commissionCsvValue(row) 跟
 * commissionCsvValue(row),那是拿同一個函式跟自己比,永遠會過、什麼都守不住。要比對的是
 * 「CSV 寫進去的值」對上「使用者在畫面上看到的那個數字」——這兩個才是當初漂移的那兩條路徑。
 *
 * 格式對不上時直接 throw,而不是回傳 NaN:`X 元(抽成)` 這個格式本身也是使用者裁決的一部分
 * (「畫面那一格的現有格式一個字都不要改」),被動到的話這條測試就該紅。
 */
/**
 * 明細表那一格數字後面固定跟著的字尾。
 *
 * ⚠️ 這裡的括號是 **ASCII 的 `(` `)`**(U+0028/U+0029),不是全形的（ ）—— 專案既有的
 *    「X 元(抽成)」「X 元(淨額)」用的都是 ASCII 括號。兩種括號在編輯器裡長得幾乎一樣,寫錯會
 *    得到一條「看起來有在測、其實永遠對不上」的斷言(寫這支工具時就真的先踩了一次)。
 *
 * ⚠️ 也因為這個原因,這裡用 endsWith + 一個單獨的 `^-?\d+$` 檢查,而不是把整段塞進一條正規表示式:
 *    在正規表示式裡 `(抽成)` 會被當成 capture group、變成比對「元抽成」而不是「元(抽成)」,
 *    是另一個同樣不會噴錯、只會靜靜比錯的陷阱。
 */
const COMMISSION_CELL_SUFFIX = " 元(抽成)";

function commissionNumberShownOnScreen(row: Pick<StaffBreakdownRow, "commission_amount">): number {
  const text = commissionCellText(row);
  if (!text.endsWith(COMMISSION_CELL_SUFFIX)) {
    throw new Error(`明細表的抽成格式不再是「X${COMMISSION_CELL_SUFFIX}」,實際拿到:${text}`);
  }
  const numberPart = text.slice(0, -COMMISSION_CELL_SUFFIX.length);
  if (!/^-?\d+$/.test(numberPart)) {
    throw new Error(`明細表的抽成那一格前半不是一個數字,實際拿到:${text}`);
  }
  return Number(numberPart);
}

function pieceRateRow(
  commissionAmount: number | null,
): Pick<StaffBreakdownRow, "commission_amount"> {
  return staffRow({
    compensation_type: "piece_rate",
    net_pay: null,
    commission_amount: commissionAmount,
  });
}

describe("抽成金額(行為 C:畫面跟 CSV 的 null fallback 必須是同一個)", () => {
  it("有抽成 1500 → 畫面「1500 元(抽成)」、CSV 寫數字 1500", () => {
    const row = pieceRateRow(1500);

    expect(commissionCellText(row)).toBe("1500 元(抽成)");
    expect(commissionCsvValue(row)).toBe(1500);
  });

  it("commission_amount = null → 畫面「0 元(抽成)」、CSV 寫 0(**不是空字串**)", () => {
    // 這條就是 2026-09-24 使用者裁決的核心。裁決前:畫面「0 元(抽成)」、CSV 一個空白格。
    // 裁決 A:兩邊統一 0,理由是「按件計酬的人沒接單時抽成確實就是 0,那是真實數字,不是不適用」。
    const row = pieceRateRow(null);

    expect(commissionCellText(row)).toBe("0 元(抽成)");
    expect(commissionCsvValue(row)).toBe(0);
    // 明確釘死「不可以退回空白格」——這是改動前 CSV 的實際行為,也是這次要修掉的東西。
    // 先收成 unknown 再斷言,是因為 commissionCsvValue 的回傳型別是 number,直接寫
    // `.not.toBe("")` 會被 TypeScript 當成型別錯誤而不是一條測試(既有的
    // expectNeverLooksLikeZero(actual: unknown) 也是同一個理由)。
    const csvCell: unknown = commissionCsvValue(row);

    expect(csvCell).not.toBe("");
    expect(csvCell).not.toBeNull();
    expect(csvCell).not.toBeUndefined();
  });

  it("commission_amount = 0 → 兩邊都是 0,跟 null 的結果完全相同(這是刻意的)", () => {
    // 抽成這個欄位刻意**不**區分「null」跟「真的是 0」——跟上面行為 A 的月薪剛好相反。
    // 月薪的 null 是資料庫用來說「這次算不出來」;抽成的 null 只是「沒有任何一筆單可以抽」。
    const zero = pieceRateRow(0);
    const nul = pieceRateRow(null);

    expect(commissionCellText(zero)).toBe("0 元(抽成)");
    expect(commissionCsvValue(zero)).toBe(0);
    expect(commissionCellText(zero)).toBe(commissionCellText(nul));
    expect(commissionCsvValue(zero)).toBe(commissionCsvValue(nul));
  });

  it("fallback 常數就是 0,而且是這個欄位唯一一處 fallback", () => {
    expect(COMMISSION_FALLBACK).toBe(0);
    expect(commissionCsvValue(pieceRateRow(null))).toBe(COMMISSION_FALLBACK);
  });

  // ⚠️ 這是真正防止未來漂移的那一條:不管輸入是什麼,「CSV 那一格寫進去的數字」跟「使用者在畫面
  //    上看到的那個數字」必須相等。當初的 bug 正是這兩者不相等(畫面 0 / CSV 空白),所以只要有人
  //    以後又只改其中一邊的 fallback,這裡就會紅。
  it.each([
    { label: "null(沒接單)", commissionAmount: null },
    { label: "0", commissionAmount: 0 },
    { label: "1500", commissionAmount: 1500 },
  ])(
    "【防漂移】commission_amount = $label → CSV 的值 === 畫面字串裡的數字",
    ({ commissionAmount }) => {
      const row = pieceRateRow(commissionAmount);

      expect(commissionCsvValue(row)).toBe(commissionNumberShownOnScreen(row));
    },
  );
});

// =========================================================================
// 行為 B:is_active_as_of === false → 顯示「已離職」
// =========================================================================

// =========================================================================
// 計酬類型名稱(2026-09-24 使用者要求:「按件計酬」全面改稱「抽成制」)
// =========================================================================

describe("compensationTypeText(「計酬類型」欄:畫面與 CSV 共用同一個文字來源)", () => {
  it("月薪制 → 「月薪制」", () => {
    expect(compensationTypeText(staffRow({ compensation_type: "monthly_salary" }))).toBe("月薪制");
  });

  it("抽成制(piece_rate)→ 「抽成制」,舊稱「按件計酬」不可以再出現", () => {
    const text = compensationTypeText(staffRow({ compensation_type: "piece_rate" }));

    expect(text).toBe("抽成制");
    expect(text).not.toContain("按件計酬");
  });

  it("兩種計酬類型的名稱都不可以是空字串,而且彼此不同", () => {
    const labels = Object.values(COMPENSATION_TYPE_LABELS);

    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label.trim()).not.toBe("");
  });

  // ⚠️ 真正防漂移的那一條。這個欄位改名前的 bug 結構跟行為 C 一模一樣:畫面明細表與 CSV 匯出各寫
  //    一次 `=== "monthly_salary" ? "月薪制" : "按件計酬"`,只改其中一邊就會漂移。純函式本身沒辦法
  //    證明「頁面兩條路徑真的都在呼叫我」,所以這裡直接讀 BillingReportPage.tsx 的原始碼(同
  //    appLayoutLogic.test.ts 讀 App.tsx 的做法),釘死兩件事:
  //    (1) 頁面的程式碼裡不可以再有寫死的計酬類型中文字串(不管是舊稱還是新稱);
  //    (2) compensationTypeText() 至少被呼叫兩次(畫面一次、CSV 一次)。
  //    只要有人把其中一邊改回寫死字串,這裡就會紅。
  //    (刻意**不**禁止頁面裡出現 `compensation_type ===`:明細表還要靠它決定那一列該顯示
  //    「抽成金額」還是「月薪淨額」,那是另一個正當的分支,不在這條測試的守備範圍。)
  it("【防漂移】畫面明細表與 CSV 對同一列必須得到相同字串,且兩邊都只能從 compensationTypeText 拿", () => {
    for (const type of ["monthly_salary", "piece_rate"] as const) {
      const row = staffRow({ compensation_type: type });
      const screenCell = compensationTypeText(row);
      const csvCell = compensationTypeText(row);

      expect(screenCell).toBe(csvCell);
      expect(screenCell).toBe(COMPENSATION_TYPE_LABELS[type]);
    }

    const source = readFileSync(
      resolve(process.cwd(), "src/modules/payroll/BillingReportPage.tsx"),
      "utf8",
    );
    // 把區塊註解與整行的 // 註解拿掉,只檢查真正會執行的程式碼(註解裡引用舊稱是允許的)。
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(codeOnly).not.toContain('"按件計酬"');
    expect(codeOnly).not.toContain('"抽成制"');
    expect(codeOnly).not.toContain('"月薪制"');
    expect(codeOnly.match(/compensationTypeText\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("isStillEmployed / shouldShowResignedBadge(行為 B:明細列的「已離職」標籤)", () => {
  it("is_active_as_of = true → 在職,不顯示「已離職」標籤", () => {
    const row = staffRow({ is_active_as_of: true });

    expect(isStillEmployed(row)).toBe(true);
    expect(shouldShowResignedBadge(row)).toBe(false);
  });

  it("is_active_as_of = false → 顯示「已離職」標籤(人照樣列在明細裡,只是要標出來)", () => {
    const row = staffRow({ is_active_as_of: false });

    expect(isStillEmployed(row)).toBe(false);
    expect(shouldShowResignedBadge(row)).toBe(true);
    expect(RESIGNED_LABEL).toBe("已離職");
  });
});

describe("employmentStatusCsvText(CSV「在職狀態」欄)", () => {
  it("is_active_as_of = true → 「在職」", () => {
    expect(employmentStatusCsvText(staffRow({ is_active_as_of: true }))).toBe(EMPLOYED_LABEL);
    expect(employmentStatusCsvText(staffRow({ is_active_as_of: true }))).toBe("在職");
  });

  it("is_active_as_of = false → 「已離職」(帶離系統後在 Excel 裡一樣分得出來)", () => {
    expect(employmentStatusCsvText(staffRow({ is_active_as_of: false }))).toBe(RESIGNED_LABEL);
    expect(employmentStatusCsvText(staffRow({ is_active_as_of: false }))).toBe("已離職");
  });
});

// =========================================================================
// CSV 總計區塊(2026-09-24 使用者裁決 A:總計放在同一個 CSV 的最上面)
//
// 這一段測試守的是同一個「畫面正常、數字是假的」失敗模式,只是搬到匯出檔上:匯出的 CSV 沒有人會
// 每次打開來檢查,商家拿去對帳、發現數字對不起來時,幾乎不可能回頭懷疑是匯出功能寫錯。尤其是
// 月薪四項 —— 只要有人在這裡補一個 `?? 0`,Excel 上就會出現「月薪基本額 0、商家總淨利 = 營收
// 全額」,而且完全沒有任何症狀。
// =========================================================================

function csvSummaryFields(
  overrides: Partial<BillingCsvSummaryFields> = {},
): BillingCsvSummaryFields {
  return {
    total_revenue_excl_tax: 2000,
    total_tax_amount: 100,
    total_material_cost: 0,
    total_commission_payout: 0,
    salary_applicable: true,
    total_monthly_salary_base: 30000,
    total_monthly_salary_deduction: 0,
    estimated_net_margin: -28000,
    ...overrides,
  };
}

/** 從總計區塊裡撈出某一個項目的值。找不到就直接丟錯,而不是回傳 undefined —— 「那一列整個不見了」
 * 跟「那一列的值不對」都是失敗,不該有一種能靜悄悄地通過。 */
function csvSummaryValue(summary: BillingCsvSummaryFields, label: string): string | number {
  const item = buildBillingCsvSummaryItems(summary).find((entry) => entry.label === label);
  if (item === undefined) {
    throw new Error(`CSV 總計區塊少了「${label}」這一列`);
  }
  return item.value;
}

describe("CSV 總計區塊:項目與順序", () => {
  it("八個項目、順序固定,而且標籤逐字沿用畫面上統計卡的文案", () => {
    const labels = buildBillingCsvSummaryItems(csvSummaryFields()).map((item) => item.label);

    expect(labels).toEqual([
      "總營收(未稅)",
      "稅金小計",
      "總料錢成本",
      "總抽成支出",
      "月薪基本額合計",
      "月薪扣款合計",
      "月薪實發合計",
      "商家總淨利",
    ]);
    // 畫面 JSX 用的也是這同一組常數(BillingReportPage.tsx 的 SummaryCard/CardTitle),所以這條
    // 斷言等於同時釘住「畫面改了文案、CSV 卻留著舊名稱」這種漂移。
    expect(labels).toEqual(Object.values(BILLING_SUMMARY_LABELS));
  });
});

describe("CSV 總計區塊:salary_applicable = true(月薪算得出來)", () => {
  it("八個項目全部是數字,而且逐項對得上 summary", () => {
    const summary = csvSummaryFields();

    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.revenueExclTax)).toBe(2000);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.taxAmount)).toBe(100);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.materialCost)).toBe(0);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.commissionPayout)).toBe(0);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryBase)).toBe(30000);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryDeduction)).toBe(0);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryNet)).toBe(30000);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.netMargin)).toBe(-28000);

    for (const item of buildBillingCsvSummaryItems(summary)) {
      expect(typeof item.value).toBe("number");
    }
  });

  it("月薪實發 = 基本額 − 扣款(不是直接抄某一個欄位)", () => {
    const summary = csvSummaryFields({
      total_monthly_salary_base: 30000,
      total_monthly_salary_deduction: 2500,
    });

    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryNet)).toBe(27500);
  });

  it("扣款真的是 0 時寫 0,不可以被當成「算不出來」吞掉", () => {
    // 反向保護:一個「永遠回傳說明文字」的壞函式也能讓上面那些「不是 0」的斷言全綠,所以一定要
    // 有這條相反方向的測試。
    const summary = csvSummaryFields({ total_monthly_salary_deduction: 0 });

    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryDeduction)).toBe(0);
  });
});

describe("CSV 總計區塊:salary_applicable = false(月薪四項絕對不可以寫 0)", () => {
  const summary = csvSummaryFields({
    salary_applicable: false,
    total_monthly_salary_base: null,
    total_monthly_salary_deduction: null,
    estimated_net_margin: null,
  });

  it("月薪基本額 / 月薪扣款 / 月薪實發 / 商家總淨利 四格都寫說明文字", () => {
    for (const label of [
      BILLING_SUMMARY_LABELS.monthlySalaryBase,
      BILLING_SUMMARY_LABELS.monthlySalaryDeduction,
      BILLING_SUMMARY_LABELS.monthlySalaryNet,
      BILLING_SUMMARY_LABELS.netMargin,
    ]) {
      const value = csvSummaryValue(summary, label);
      expect(value).toBe(SALARY_UNAVAILABLE_TEXT);
      // 「不是 0、不是 "0"、不是 "0 元"、不是空字串」—— CSV 的空白格在 Excel 裡看起來跟 0 幾乎
      // 沒差別,所以空字串跟 0 一樣要擋。
      expectNeverLooksLikeZero(value);
    }
  });

  it("CSV 這四格的內容,跟畫面上那四張卡顯示的是同一段文字(共用同一個 fallback 來源)", () => {
    // 畫面:salaryCardValue() → null → SummaryCard 印 unavailableText(renderedSummaryCard 模擬)。
    // CSV :同一支 resolveSalaryDisplay() → 直接把那段文字寫進格子。
    // 兩邊都只能從 resolveSalaryDisplay 拿答案,所以這條斷言在「有人只改其中一邊」時會紅。
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryBase)).toBe(
      renderedSummaryCard(salaryCardValue(false, null)),
    );
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.netMargin)).toBe(
      renderedSummaryCard(salaryCardValue(false, null)),
    );
  });

  it("營收 / 稅金 / 料錢 / 抽成 不受影響,照常是數字", () => {
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.revenueExclTax)).toBe(2000);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.taxAmount)).toBe(100);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.materialCost)).toBe(0);
    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.commissionPayout)).toBe(0);
  });
});

describe("CSV 總計區塊:商家總淨利是負數(虧損)時要如實輸出", () => {
  it("estimated_net_margin = -28000 → 就是 -28000,不是「算不出來」也不是 0", () => {
    // 虧損是合法的真實數字。把負數吞掉(當成 null / 空白 / 0)比顯示不出來更危險:老闆會以為
    // 這段期間打平或小賺。
    const value = csvSummaryValue(csvSummaryFields(), BILLING_SUMMARY_LABELS.netMargin);

    expect(value).toBe(-28000);
    expect(typeof value).toBe("number");
    expect(value).not.toBe(SALARY_UNAVAILABLE_TEXT);
    expectNeverLooksLikeZero(value);
  });

  it("月薪實發算出來是負數(扣款大於基本額)也照樣輸出負數", () => {
    const summary = csvSummaryFields({
      total_monthly_salary_base: 10000,
      total_monthly_salary_deduction: 12000,
    });

    expect(csvSummaryValue(summary, BILLING_SUMMARY_LABELS.monthlySalaryNet)).toBe(-2000);
  });
});

describe("formatCsvPeriodText(報表區間文字)", () => {
  it("格式是「起始日 ~ 結束日」", () => {
    expect(formatCsvPeriodText("2026-09-01", "2026-09-30")).toBe("2026-09-01 ~ 2026-09-30");
  });

  it("自訂區間(跨月)一樣照實寫,不做任何美化", () => {
    expect(formatCsvPeriodText("2026-02-15", "2026-03-15")).toBe("2026-02-15 ~ 2026-03-15");
  });
});

describe("buildBillingCsvSummarySection(總計區塊完整的 CSV 列)", () => {
  it("區間 → 空白列 → 項目/金額標題 → 八個項目 → 空白列", () => {
    const section = buildBillingCsvSummarySection(csvSummaryFields(), "2026-09-01", "2026-09-30");

    expect(section[0]).toEqual([CSV_PERIOD_LABEL, "2026-09-01 ~ 2026-09-30"]);
    // 空陣列 = CSV 裡的一整列空白,兩段不同形狀的表格靠它隔開(沒有它,Excel 打開後總計跟明細
    // 會糊成一片)。
    expect(section[1]).toEqual([]);
    expect(section[2]).toEqual([CSV_SUMMARY_ITEM_HEADER, CSV_SUMMARY_AMOUNT_HEADER]);
    expect(section.slice(3, 11)).toEqual(
      buildBillingCsvSummaryItems(csvSummaryFields()).map((item) => [item.label, item.value]),
    );
    expect(section[section.length - 1]).toEqual([]);
    expect(section).toHaveLength(12);
  });

  it("salary_applicable = false 時,整個區塊裡不存在任何一格是 0 或空字串的月薪數字", () => {
    const section = buildBillingCsvSummarySection(
      csvSummaryFields({
        salary_applicable: false,
        total_monthly_salary_base: null,
        total_monthly_salary_deduction: null,
        estimated_net_margin: null,
      }),
      "2026-09-05",
      "2026-09-20",
    );
    const salaryLabels: string[] = [
      BILLING_SUMMARY_LABELS.monthlySalaryBase,
      BILLING_SUMMARY_LABELS.monthlySalaryDeduction,
      BILLING_SUMMARY_LABELS.monthlySalaryNet,
      BILLING_SUMMARY_LABELS.netMargin,
    ];

    const salaryLines = section.filter(
      (line) => line.length === 2 && salaryLabels.includes(String(line[0])),
    );
    expect(salaryLines).toHaveLength(4);
    for (const line of salaryLines) {
      expect(line[1]).toBe(SALARY_UNAVAILABLE_TEXT);
      expectNeverLooksLikeZero(line[1]);
    }
  });
});
