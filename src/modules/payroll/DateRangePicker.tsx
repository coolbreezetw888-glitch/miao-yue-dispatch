// 商家端三項調整規格書 §3.6(店家帳務報表)/服務人員端規格書 §15.2(服務人員個人薪資報表比照
// 辦理):時間篩選從單一年/月改成可選區間——可選「起訖日期」或「起訖月份」兩種顆粒度,最長一年。
// 沿用既有 ReportExportCenterPage.tsx 已經在用的 <Input type="date"> 慣例(§3.6:「engineer 依
// 既有 UI 元件庫選用最合適的日期區間選擇器實作,不強制規定用哪個套件」),不新增日期選擇器套件。
//
// 這個元件放在 payroll 模組,由 BillingReportPage.tsx(商家端)跟 staff-portal 模組的
// MyPayrollPage.tsx(服務人員自助端)共用同一套元件跟同一套一年上限規則(服務人員端規格書
// §15.2:「不是另外設計一套不同的篩選邏輯」),比照既有 YearMonthPicker 被 MyPayrollPage.tsx
// 跨模組 import 的先例。
//
// 商家管理員視角的師傅報表頁(StaffReportPage.tsx)這次不在範圍內,繼續用既有的 YearMonthPicker,
// 不受影響。
//
// ui-v1-full 第二階段第 2 批(2026-09-29):「按日期 / 按月份」二選一改 ChoiceChipGroup(skill 二之七 單選),
// 起訖欄位改 FormField + FieldDate / FieldMonth,錯誤訊息改 FieldError(`!` 一行說明)。
// **只動外觀**:顆粒度切換、月份 → 起訖日期換算、一年上限檢查都照舊。這個元件同時被服務人員端
// MyPayrollPage.tsx 共用,兩邊會一起換新外觀。

import { useState } from "react";

import {
  ChoiceChipGroup,
  FieldDate,
  FieldError,
  FieldMonth,
  FormField,
} from "@/components/patterns";

import {
  defaultDateRange,
  firstDayOfMonth,
  lastDayOfMonth,
  validateDateRange,
} from "./dateRangeUtils";

export type DateRangeGranularity = "day" | "month";

const GRANULARITY_OPTIONS: ReadonlyArray<{ value: DateRangeGranularity; label: string }> = [
  { value: "day", label: "按日期" },
  { value: "month", label: "按月份" },
];

export function useDateRangeState(initial?: { startDate?: string; endDate?: string }): {
  startDate: string;
  endDate: string;
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
} {
  const fallback = defaultDateRange();
  const [startDate, setStartDate] = useState(initial?.startDate ?? fallback.startDate);
  const [endDate, setEndDate] = useState(initial?.endDate ?? fallback.endDate);
  return { startDate, endDate, setStartDate, setEndDate };
}

export function DateRangePicker({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: {
  startDate: string;
  endDate: string;
  onStartDateChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
}) {
  const [granularity, setGranularity] = useState<DateRangeGranularity>("day");
  const error = validateDateRange(startDate, endDate);

  return (
    <div className="flex flex-col gap-3">
      {/* 🔴 2026-09-30 QA:這條 chip 列原本只有 aria-label,畫面上沒有任何可見標籤 —— 在店家帳務
          報表切到「自訂區間」時,它會緊貼在上面那條「查詢期間」chip 列底下,變成兩條長得一樣、
          都沒有標題的列疊在一起,使用者看不出哪條是哪條。包進 FormField 給它可見標籤。
          aria-label 保留:FormField 的 <Label> 沒有 htmlFor(radiogroup 不是單一控制項),
          語意名稱還是靠 aria-label 提供。 */}
      <FormField label="區間單位" help="「按日期」可以挑任意兩天;「按月份」會自動抓整個月。">
        <ChoiceChipGroup
          aria-label="區間單位"
          value={granularity}
          onValueChange={setGranularity}
          options={GRANULARITY_OPTIONS}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2">
        <FormField label="起" htmlFor="date-range-start">
          {granularity === "day" ? (
            <FieldDate
              id="date-range-start"
              value={startDate}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) return;
                onStartDateChange(raw);
              }}
            />
          ) : (
            <FieldMonth
              id="date-range-start"
              value={startDate.slice(0, 7)}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) return;
                onStartDateChange(firstDayOfMonth(raw));
              }}
            />
          )}
        </FormField>
        <FormField label="訖" htmlFor="date-range-end">
          {granularity === "day" ? (
            <FieldDate
              id="date-range-end"
              value={endDate}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) return;
                onEndDateChange(raw);
              }}
            />
          ) : (
            <FieldMonth
              id="date-range-end"
              value={endDate.slice(0, 7)}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) return;
                onEndDateChange(lastDayOfMonth(raw));
              }}
            />
          )}
        </FormField>
      </div>

      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
