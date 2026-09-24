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
// 反向保護也一樣重要:值真的是 0(這個月扣款真的沒有)或負數(商家總淨利虧損 -5000)時,必須照實
// 顯示那個數字,不可以被「算不出來」吞掉。只測 happy path + 只測「不適用」都不夠,兩個方向都要測,
// 否則一個「永遠回傳說明文字」的壞函式也能讓測試全綠。

import { describe, expect, it } from "vitest";

import {
  EMPLOYED_LABEL,
  RESIGNED_LABEL,
  SALARY_UNAVAILABLE_TEXT,
  type SalarySummaryFields,
  type StaffBreakdownRow,
  employmentStatusCsvText,
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

  it("按件計酬的人 → 這一欄留空(他的錢在「抽成金額」那一欄),不受月薪旗標影響", () => {
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
// 行為 B:is_active_as_of === false → 顯示「已離職」
// =========================================================================

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
