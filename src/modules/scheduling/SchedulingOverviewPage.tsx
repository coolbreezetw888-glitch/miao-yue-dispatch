// 對應模組 7(排班與休假管理)規格書 §4.4:排班一覽頁(新路由 /app/scheduling)。
// 本模組唯一的「跨服務人員總覽」畫面,語意上補齊模組 5 行事曆頁「一次只能看一位服務人員在一天的
// 細節」的空缺。週日期列(比照 CalendarPage.tsx 既有的週切換 UX)+ 表格式呈現(橫向日期、縱向
// 服務人員),點擊儲存格連結跳轉到行事曆頁面對應日期。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { addDays, getTaipeiNow, startOfWeek, toDateKey } from "@/modules/booking/dateUtils";

import { useStaffScheduleOverview } from "./context";
import { RequireSchedulingAccess } from "./RequireSchedulingAccess";
import { describeScheduleCell, type ScheduleCellTone } from "./types";

const CELL_TONE_CLASSES: Record<ScheduleCellTone, string> = {
  leave: "bg-muted text-muted-foreground",
  closed: "bg-destructive/10 text-destructive",
  unset: "bg-muted/40 text-muted-foreground",
  normal: "bg-brand-soft/40 text-foreground hover:bg-brand-soft/70",
};

function SchedulingOverviewPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(getTaipeiNow()));
  const weekDays = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)), [weekStart]);
  const startDateKey = toDateKey(weekStart);
  const endDateKey = toDateKey(addDays(weekStart, 6));

  const { data: overview, isLoading } = useStaffScheduleOverview(
    merchantId,
    startDateKey,
    endDateKey,
  );

  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">排班一覽</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            「{merchant!.name}」跨服務人員的每週時段/單日例外/請假彙整總覽
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekStart((d) => addDays(d, -7))}>
            上一週
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWeekStart(startOfWeek(getTaipeiNow()))}
          >
            本週
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekStart((d) => addDays(d, 7))}>
            下一週
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {startDateKey} ~ {endDateKey}
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : !overview || overview.staff.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有在職的服務人員,請先到服務人員管理新增。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="w-32 border-r border-border p-2 text-left font-medium text-foreground">
                  服務人員
                </th>
                {weekDays.map((d, i) => (
                  <th
                    key={toDateKey(d)}
                    className="min-w-[120px] border-r border-border p-2 text-center font-medium text-foreground last:border-r-0"
                  >
                    {d.getMonth() + 1}/{d.getDate()}({weekdayLabels[i]})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.staff.map((staffBlock) => (
                <tr key={staffBlock.staff_id} className="border-b border-border last:border-b-0">
                  <td className="border-r border-border p-2 align-top font-medium text-foreground">
                    {staffBlock.staff_name}
                  </td>
                  {staffBlock.days.map((day) => {
                    const { tone, label } = describeScheduleCell(
                      day,
                      staffBlock.no_time_slot_limit,
                    );
                    return (
                      <td
                        key={day.date}
                        className="border-r border-border p-0 align-top last:border-r-0"
                      >
                        <Link
                          to={`/app/calendar?date=${day.date}`}
                          className={cn(
                            "block h-full min-h-[56px] px-2 py-2 text-xs leading-snug transition-colors",
                            CELL_TONE_CLASSES[tone],
                          )}
                        >
                          {label}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export default function SchedulingOverviewPage() {
  return (
    <RequireSchedulingAccess>
      <SchedulingOverviewPageInner />
    </RequireSchedulingAccess>
  );
}
