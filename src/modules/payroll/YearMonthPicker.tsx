// 模組 8(薪資與帳務)§4.3/§4.4/判斷 9:報表篩選單位固定為「單一年月」,不做任意起訖日期區間
// (第〇節判斷 9)。這個小元件 + hook 給店家帳務報表頁(4.3)、師傅報表頁(4.4)共用,純粹是這兩個
// 頁面內部共用的 UI 積木,不對外暴露、不算對外介面。

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <div className="flex items-end gap-2">
      <div>
        <Label htmlFor="year-picker" className="text-xs">
          年
        </Label>
        <Input
          id="year-picker"
          className="mt-1 w-24"
          type="number"
          value={year}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v > 0) onYearChange(v);
          }}
        />
      </div>
      <div>
        <Label htmlFor="month-picker" className="text-xs">
          月
        </Label>
        <Input
          id="month-picker"
          className="mt-1 w-20"
          type="number"
          min={1}
          max={12}
          value={month}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= 1 && v <= 12) onMonthChange(v);
          }}
        />
      </div>
    </div>
  );
}
