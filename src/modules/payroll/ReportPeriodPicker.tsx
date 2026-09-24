// 2026-09-24 使用者裁決(月薪只在「選了完整月份」時才顯示):店家帳務報表的時間篩選,預設改成
// 「月份」顆粒度(本月 / 上個月 / 指定月份),只有切到「自訂區間」才出現任意起訖日期的選擇器。
//
// 為什麼要這樣分:
//   月薪本質上是「一整個月」這個單位,任何按天切的算法都是編出來的。資料庫端因此新增
//   salary_applicable 欄位(起始日是某月 1 號 且 結束日是某月最後一天才為 true),false 時月薪
//   相關數字一律回傳 null。既然「完整月份」才是最常用、也是唯一算得出月薪的情境,預設就直接讓
//   使用者選月份,不用自己去湊「1 號」跟「月底」這兩個日期。
//
// 沿用既有元件與慣例,不另造一套:
//   1. 「自訂區間」模式直接原封不動渲染既有的 <DateRangePicker>(含它自己的「按日期 / 按月份」
//      切換)——那個元件同時被 staff-portal 的 MyPayrollPage.tsx 共用,這次刻意**完全不改它的
//      props 與行為**,避免動到另一個頁面。順帶說明:DateRangePicker 內建的「按月份」顆粒度
//      跟這裡的「指定月份」不重複——前者可以選出**跨多個月**的完整區間(例如 2/1 ~ 4/30,
//      salary_applicable 也是 true),後者只選單一個月,兩者是不同用途。
//   2. 月份 → 起訖日期的換算一律走 dateRangeUtils.ts 的 monthRange/currentMonthRange/
//      previousMonthRange,不在這個元件裡自己算月底(月底邏輯只能有一份)。
//   3. 按鈕外觀比照 DateRangePicker 既有的 variant={選中 ? "default" : "outline"} 慣例。

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { DateRangePicker } from "./DateRangePicker";
import { currentMonthRange, monthRange, previousMonthRange, toMonthString } from "./dateRangeUtils";

/** 四種期間選擇方式。前三種一定產生「完整月份」的區間(月薪算得出來),最後一種是任意區間。 */
export type ReportPeriodMode = "this_month" | "last_month" | "pick_month" | "custom_range";

const MODE_LABELS: Record<ReportPeriodMode, string> = {
  this_month: "本月",
  last_month: "上個月",
  pick_month: "指定月份",
  custom_range: "自訂區間",
};

const MODE_ORDER: ReportPeriodMode[] = ["this_month", "last_month", "pick_month", "custom_range"];

export interface ReportPeriodState {
  mode: ReportPeriodMode;
  /** 切換模式。切到前三種會立刻把起訖日期換成對應的完整月份;切到「自訂區間」刻意**保留**目前
   * 的起訖日期當起點,讓使用者從看得懂的值開始微調,而不是被重設成別的區間。 */
  setMode: (mode: ReportPeriodMode) => void;
  /** 「指定月份」模式選的月份,格式 "YYYY-MM"。 */
  month: string;
  setMonth: (month: string) => void;
  startDate: string;
  endDate: string;
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
}

/** 期間選擇的狀態管理。預設是「本月」(完整月份),跟改版前 defaultDateRange() 的「本月 1 號 ~
 * 今天」差別只在結束日期取到月底,見 dateRangeUtils.ts 的說明。 */
export function useReportPeriodState(): ReportPeriodState {
  const initialRange = currentMonthRange();
  const [mode, setModeState] = useState<ReportPeriodMode>("this_month");
  const [month, setMonthState] = useState<string>(() => toMonthString(new Date()));
  const [startDate, setStartDate] = useState(initialRange.startDate);
  const [endDate, setEndDate] = useState(initialRange.endDate);

  function applyRange(range: { startDate: string; endDate: string }) {
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }

  function setMode(next: ReportPeriodMode) {
    setModeState(next);
    if (next === "this_month") {
      const range = currentMonthRange();
      setMonthState(range.startDate.slice(0, 7));
      applyRange(range);
      return;
    }
    if (next === "last_month") {
      const range = previousMonthRange();
      // 「上個月」也同步更新月份輸入框的值,這樣使用者接著切到「指定月份」時,看到的是他剛剛
      // 在看的那個月,不是一個突然跳掉的月份。
      setMonthState(range.startDate.slice(0, 7));
      applyRange(range);
      return;
    }
    if (next === "pick_month") {
      applyRange(monthRange(month));
      return;
    }
    // custom_range:保留目前區間,不動。
  }

  function setMonth(next: string) {
    setMonthState(next);
    applyRange(monthRange(next));
  }

  return { mode, setMode, month, setMonth, startDate, endDate, setStartDate, setEndDate };
}

export function ReportPeriodPicker({
  mode,
  onModeChange,
  month,
  onMonthChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: {
  mode: ReportPeriodMode;
  onModeChange: (mode: ReportPeriodMode) => void;
  month: string;
  onMonthChange: (month: string) => void;
  startDate: string;
  endDate: string;
  onStartDateChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {MODE_ORDER.map((m) => (
          <Button
            key={m}
            type="button"
            size="sm"
            variant={mode === m ? "default" : "outline"}
            onClick={() => onModeChange(m)}
          >
            {MODE_LABELS[m]}
          </Button>
        ))}
      </div>

      {mode === "pick_month" ? (
        <div>
          <Label htmlFor="report-period-month" className="text-xs">
            月份
          </Label>
          <Input
            id="report-period-month"
            className="mt-1"
            type="month"
            value={month}
            onChange={(e) => {
              const raw = e.target.value;
              // 使用者把輸入框清空時什麼都不做(不要把區間改成 "undefined-01" 這種壞值),
              // 沿用 DateRangePicker 對空值的既有處理方式。
              if (!raw) return;
              onMonthChange(raw);
            }}
          />
        </div>
      ) : null}

      {mode === "custom_range" ? (
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={onStartDateChange}
          onEndDateChange={onEndDateChange}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          查詢範圍:{startDate} ~ {endDate}
        </p>
      )}
    </div>
  );
}
