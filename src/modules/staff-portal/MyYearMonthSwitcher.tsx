// 對應規格書 v2 §10.4.5:薪資報表頁的月份切換,取代既有 YearMonthPicker(兩個數字輸入框)
// 樣式,改成「← 上個月 / 下個月 →」箭頭切換樣式(比照 MyCalendarPage.tsx 月曆已經在用的樣式)。
// 只有服務人員自助頁面(MyPayrollPage.tsx)要用這個樣式,商家管理員的 StaffReportPage.tsx
// 繼續用既有的 YearMonthPicker 數字輸入框,不強制統一成同一種樣式,所以這個元件放在
// staff-portal 模組底下,不動 payroll 模組既有的 YearMonthPicker.tsx。
//
// 介面上跟既有 useYearMonthState() 回傳的 { year, month, setYear, setMonth } 對接,不需要改動
// useYearMonthState 本身——這個元件內部自己算出新的 year/month 再呼叫 setYear/setMonth。

import { Button } from "@/components/ui/button";

/** 年/月的進位運算:1 月按上一月要跳到去年 12 月,12 月按下一月要跳到明年 1 月。 */
export function shiftYearMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  // 把 (year, month) 換算成從某個基準點起算的總月數,加減後再換算回來,可以正確處理任意方向、
  // 任意大小的位移(不只是 ±1),避免逐月加減時漏掉多重跨年的情況。
  const totalMonths = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = (totalMonths % 12) + 1;
  return { year: nextYear, month: nextMonth };
}

export function MyYearMonthSwitcher({
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
  function shift(delta: number) {
    const next = shiftYearMonth(year, month, delta);
    onYearChange(next.year);
    onMonthChange(next.month);
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => shift(-1)}>
        ← 上個月
      </Button>
      <p className="text-sm font-semibold text-foreground">
        {year} 年 {month} 月
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => shift(1)}>
        下個月 →
      </Button>
    </div>
  );
}
