// 模組 8(薪資與帳務)§4.3/§4.4/判斷 9:報表篩選單位固定為「單一年月」,不做任意起訖日期區間
// (第〇節判斷 9)。這個小元件 + hook 給師傅報表頁(4.4)用,純粹是頁面內部共用的 UI 積木,
// 不對外暴露、不算對外介面。(店家帳務報表 4.3 已改用 ReportPeriodPicker/DateRangePicker。)
//
// ui-v1-full 第二階段第 2 批(2026-09-29):欄位改用共用的 FormField / FieldInput(44px / 10px 圓角 /
// tabular-nums),只動外觀,年 / 月的解析與範圍檢查照舊。
//
// 🔴 SPECS-INDEX #861(2026-09-30 使用者實機巡檢):「薪資報表的日期選擇器改成原生選擇器樣式」。
// 這裡原本是**兩個 `<input type="number">`**(年、月各一格)—— 那不是日期選擇器,是兩個數字框:
//   ・要自己打「2026」跟「9」,手機上跳的是數字鍵盤,不是使用者附圖那種「年 + 12 個月格子」
//   ・兩格清空時 Number("") = NaN,會把 NaN 送進報表查詢
// 改成**一個** `FieldMonth`(`<input type="month">`),就是使用者附圖裡那個原生月份選擇器。
// 對外介面(useYearMonthState 回傳的 year/month 兩個數字、onYearChange/onMonthChange 兩個回呼)
// **完全不變** —— 送進 API 的值一模一樣,呼叫端(StaffReportPage.tsx)不用跟著改。
// 做法逐字比照同一批已經做過這件事的既有先例:
// src/modules/data-tools/ReportExportCenterPage.tsx 的 toMonthValue / handleCommissionMonthChange
// (那裡是抽成報表的「指定月份」,同樣是「年+月兩個數字框 → 一個 FieldMonth」)。

import { useState } from "react";

import { FieldMonth, FormField } from "@/components/patterns";

export function useYearMonthState(initial?: {
  year?: number | undefined;
  month?: number | undefined;
}): {
  year: number;
  month: number;
  setYear: (year: number) => void;
  setMonth: (month: number) => void;
} {
  const now = new Date();
  const [year, setYear] = useState(initial?.year ?? now.getFullYear());
  const [month, setMonth] = useState(initial?.month ?? now.getMonth() + 1);
  return { year, month, setYear, setMonth };
}

/** 年 + 月兩個數字 → `<input type="month">` 吃的 `YYYY-MM`。 */
function toMonthValue(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function YearMonthPicker({
  year,
  month,
  onYearChange,
  onMonthChange,
}: {
  year: number;
  month: number;
  onYearChange: (year: number) => void;
  onMonthChange: (month: number) => void;
}) {
  /** FieldMonth 的 `YYYY-MM` 拆回年 / 月兩個數字(送進 API 的值完全沒變)。
   *  清空欄位或打到一半解析不出來時**不動 state** —— 寧可留著上一個有效月份,也不要讓報表查詢
   *  拿到 NaN(改版前兩個 type=number 欄位清空時就會送出 NaN,這裡順手不再發生)。
   *  年份沒有另外設上下限:報表查得到的範圍由資料決定,擋在這裡只會讓人選不到舊資料。 */
  function handleChange(value: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) return;
    const nextYear = Number(match[1]);
    const nextMonth = Number(match[2]);
    if (!Number.isFinite(nextYear) || nextMonth < 1 || nextMonth > 12) return;
    if (nextYear !== year) onYearChange(nextYear);
    if (nextMonth !== month) onMonthChange(nextMonth);
  }

  return (
    <FormField label="月份" htmlFor="year-month-picker" className="sm:w-44">
      <FieldMonth
        id="year-month-picker"
        value={toMonthValue(year, month)}
        onChange={(e) => handleChange(e.target.value)}
      />
    </FormField>
  );
}
