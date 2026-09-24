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

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  defaultDateRange,
  firstDayOfMonth,
  lastDayOfMonth,
  validateDateRange,
} from "./dateRangeUtils";

export type DateRangeGranularity = "day" | "month";

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
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={granularity === "day" ? "default" : "outline"}
          onClick={() => setGranularity("day")}
        >
          按日期
        </Button>
        <Button
          type="button"
          size="sm"
          variant={granularity === "month" ? "default" : "outline"}
          onClick={() => setGranularity("month")}
        >
          按月份
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="date-range-start" className="text-xs">
            起
          </Label>
          <Input
            id="date-range-start"
            className="mt-1"
            type={granularity === "day" ? "date" : "month"}
            value={granularity === "day" ? startDate : startDate.slice(0, 7)}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw) return;
              onStartDateChange(granularity === "day" ? raw : firstDayOfMonth(raw));
            }}
          />
        </div>
        <div>
          <Label htmlFor="date-range-end" className="text-xs">
            訖
          </Label>
          <Input
            id="date-range-end"
            className="mt-1"
            type={granularity === "day" ? "date" : "month"}
            value={granularity === "day" ? endDate : endDate.slice(0, 7)}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw) return;
              onEndDateChange(granularity === "day" ? raw : lastDayOfMonth(raw));
            }}
          />
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
