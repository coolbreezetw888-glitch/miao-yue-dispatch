// 模組 8(薪資與帳務)§4.3/§4.4/判斷 9:報表篩選單位固定為「單一年月」,不做任意起訖日期區間
// (第〇節判斷 9)。這個小元件 + hook 給店家帳務報表頁(4.3)、師傅報表頁(4.4)共用,純粹是這兩個
// 頁面內部共用的 UI 積木,不對外暴露、不算對外介面。
//
// ui-v1-full 第二階段第 2 批(2026-09-29):欄位改用共用的 FormField / FieldInput(44px / 10px 圓角 /
// tabular-nums),只動外觀,年 / 月的解析與範圍檢查照舊。

import { useState } from "react";

import { FieldInput, FormField } from "@/components/patterns";

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
  return (
    <div className="flex gap-2">
      <FormField label="年" htmlFor="year-picker" className="w-28">
        <FieldInput
          id="year-picker"
          type="number"
          inputMode="numeric"
          className="tabular-nums"
          value={year}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v > 0) onYearChange(v);
          }}
        />
      </FormField>
      <FormField label="月" htmlFor="month-picker" className="w-24">
        <FieldInput
          id="month-picker"
          type="number"
          inputMode="numeric"
          min={1}
          max={12}
          className="tabular-nums"
          value={month}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= 1 && v <= 12) onMonthChange(v);
          }}
        />
      </FormField>
    </div>
  );
}
