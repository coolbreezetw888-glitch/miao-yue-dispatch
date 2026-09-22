// 對應規格書 v2 §10.3:「休假設定」重新設計,取代原本的 DayOverrideSection(舊版單日臨時休假/
// 開放的文字清單+表單樣式)。拆成「整天排休」(月曆)/「時段排休」(半小時列表)兩分頁籤,
// 兩個分頁籤本質上是同一份資料(staff_availability_overrides)的兩種操作入口,複用既有的
// set_staff_day_override/clear_staff_day_override 機制(§10.3.1),不新增資料表、不新增後端函式。
//
// 10.3.3 明講:兩個分頁籤都複用同一個月曆格線元件,但「點擊某一天」的意義不同(整天排休分頁是
// 直接標記整天;時段排休分頁是切換要看哪一天的時段列表),這裡透過 DayOffMonthCalendar 把月曆
// 格線本身抽成共用元件,兩個分頁籤各自傳入不同的 onSelectDate handler,在程式碼上清楚分開,
// 不共用同一個 onClick。

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import {
  addMonths,
  buildMonthGrid,
  getTaipeiNow,
  minutesToTime,
  startOfMonth,
  timeToMinutes,
  toDateKey,
} from "@/modules/booking/dateUtils";

import { clearMyDayOverride, setMyDayOverride, useMyAvailabilityOverrides, useMyDayBusinessHours } from "./context";
import { countWholeDaysOffInMonth, isDateWholeDayOff } from "./dayOffLogic";
import type { StaffAvailabilityOverride } from "./api";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const SLOT_MINUTES = 30;

// ---------------------------------------------------------------------------
// 兩個分頁籤共用的月曆格線元件(10.3.3 要求複用,但點擊語意由呼叫端決定)。
// ---------------------------------------------------------------------------
function DayOffMonthCalendar({
  monthAnchor,
  onMonthChange,
  highlightedDates,
  selectedDateKey,
  onSelectDate,
}: {
  monthAnchor: Date;
  onMonthChange: (next: Date) => void;
  highlightedDates: Set<string>;
  selectedDateKey?: string | null;
  onSelectDate: (dateKey: string) => void;
}) {
  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={() => onMonthChange(addMonths(monthAnchor, -1))}>
          ← 上個月
        </Button>
        <p className="text-sm font-semibold text-foreground">
          {monthAnchor.getFullYear()} 年 {monthAnchor.getMonth() + 1} 月
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => onMonthChange(addMonths(monthAnchor, 1))}>
          下個月 →
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="py-1 text-muted-foreground">
            {label}
          </div>
        ))}
        {monthGrid.map(({ date, inCurrentMonth }) => {
          const dateKey = toDateKey(date);
          const isHighlighted = highlightedDates.has(dateKey);
          const isSelected = selectedDateKey === dateKey;
          return (
            <button
              key={dateKey}
              type="button"
              onClick={() => onSelectDate(dateKey)}
              className={cn(
                "flex h-12 flex-col items-center justify-center rounded-md border text-xs transition-colors",
                isSelected
                  ? "border-primary bg-primary/10 text-foreground"
                  : isHighlighted
                    ? "border-warn bg-warn/20 text-warn"
                    : "border-border text-foreground hover:bg-muted",
                inCurrentMonth ? "" : "opacity-40",
              )}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 10.3.2:「整天排休」分頁籤。
// ---------------------------------------------------------------------------
function WholeDayOffTab({
  merchantId,
  staffId,
}: {
  merchantId: string;
  staffId: string;
}) {
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(getTaipeiNow()));
  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const rangeStart = toDateKey(monthGrid[0]!.date);
  const rangeEnd = toDateKey(monthGrid[monthGrid.length - 1]!.date);

  const { data: overrides, isLoading, refetch } = useMyAvailabilityOverrides(
    merchantId,
    rangeStart,
    rangeEnd,
  );
  const [saving, setSaving] = useState(false);

  const overridesList: StaffAvailabilityOverride[] = overrides ?? [];
  const highlightedDates = useMemo(() => {
    const set = new Set<string>();
    for (const { date } of monthGrid) {
      const dateKey = toDateKey(date);
      if (isDateWholeDayOff(overridesList, dateKey)) set.add(dateKey);
    }
    return set;
  }, [monthGrid, overridesList]);

  const wholeDaysOffCount = countWholeDaysOffInMonth(
    overridesList,
    monthAnchor.getFullYear(),
    monthAnchor.getMonth() + 1,
  );

  async function handleToggleWholeDay(dateKey: string) {
    setSaving(true);
    try {
      if (isDateWholeDayOff(overridesList, dateKey)) {
        await clearMyDayOverride(staffId, dateKey, "00:00", "24:00");
        toast.success("已取消這天的休假");
      } else {
        const conflictCount = await setMyDayOverride(staffId, dateKey, "00:00", "24:00", false);
        if (conflictCount > 0) {
          toast.success("已將這天標記為整天休假", {
            description: `這天已經有 ${conflictCount} 筆預約,系統不會自動取消,請自行確認。`,
          });
        } else {
          toast.success("已將這天標記為整天休假");
        }
      }
      await refetch();
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : (
        <DayOffMonthCalendar
          monthAnchor={monthAnchor}
          onMonthChange={setMonthAnchor}
          highlightedDates={highlightedDates}
          onSelectDate={(dateKey) => {
            if (!saving) void handleToggleWholeDay(dateKey);
          }}
        />
      )}
      <p className="text-sm text-muted-foreground">
        本月已排休 {wholeDaysOffCount} 天,點擊已選日期可取消
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 10.3.3:「時段排休」分頁籤。
// ---------------------------------------------------------------------------
function BySlotOffTab({
  merchantId,
  staffId,
}: {
  merchantId: string;
  staffId: string;
}) {
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(getTaipeiNow()));
  const [selectedDateKey, setSelectedDateKey] = useState(() => toDateKey(getTaipeiNow()));
  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const rangeStart = toDateKey(monthGrid[0]!.date);
  const rangeEnd = toDateKey(monthGrid[monthGrid.length - 1]!.date);

  const { data: overrides, refetch } = useMyAvailabilityOverrides(merchantId, rangeStart, rangeEnd);
  const { data: businessHours, isLoading: businessHoursLoading } = useMyDayBusinessHours(
    staffId,
    selectedDateKey,
  );
  const [saving, setSaving] = useState(false);

  const overridesList: StaffAvailabilityOverride[] = overrides ?? [];
  const overridesForSelectedDate = useMemo(
    () => overridesList.filter((o) => o.override_date === selectedDateKey),
    [overridesList, selectedDateKey],
  );

  const slots = useMemo(() => {
    if (!businessHours || !businessHours.has_setting || businessHours.is_closed) return [];
    if (!businessHours.open_time || !businessHours.close_time) return [];
    const startMin = timeToMinutes(businessHours.open_time);
    const endMin = timeToMinutes(businessHours.close_time);
    const result: { start: string; end: string }[] = [];
    for (let m = startMin; m < endMin; m += SLOT_MINUTES) {
      result.push({ start: minutesToTime(m), end: minutesToTime(m + SLOT_MINUTES) });
    }
    return result;
  }, [businessHours]);

  async function handleToggleSlot(start: string, end: string, currentlyAvailable: boolean) {
    setSaving(true);
    try {
      if (currentlyAvailable) {
        const conflictCount = await setMyDayOverride(staffId, selectedDateKey, start, end, false);
        if (conflictCount > 0) {
          toast.success("已標記為休息", {
            description: `這段時間已經有 ${conflictCount} 筆預約,系統不會自動取消,請自行確認。`,
          });
        } else {
          toast.success("已標記為休息");
        }
      } else {
        await clearMyDayOverride(staffId, selectedDateKey, start, end);
        toast.success("已恢復為可預約");
      }
      await refetch();
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <DayOffMonthCalendar
        monthAnchor={monthAnchor}
        onMonthChange={setMonthAnchor}
        highlightedDates={new Set()}
        selectedDateKey={selectedDateKey}
        onSelectDate={setSelectedDateKey}
      />

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-sm font-medium text-foreground">{selectedDateKey}</p>
        {businessHoursLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : !businessHours?.has_setting || businessHours.is_closed ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
            這天商家沒有營業/沒有設定營業時間,不需要另外設定時段休息
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {slots.map((slot) => {
              const matched = overridesForSelectedDate.find((o) => o.slot_start_time.slice(0, 5) === slot.start);
              const isAvailable = matched ? matched.is_available : true;
              return (
                <li key={slot.start}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleToggleSlot(slot.start, slot.end, isAvailable)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border px-3 py-1.5 text-sm transition-colors",
                      isAvailable
                        ? "border-border text-foreground hover:bg-muted"
                        : "border-warn/50 bg-warn/10 text-warn",
                    )}
                  >
                    <span>
                      {slot.start}-{slot.end}
                    </span>
                    <span>{isAvailable ? "可預約" : "休息"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function DayOffTabsSection({
  merchantId,
  staffId,
}: {
  merchantId: string;
  staffId: string;
}) {
  const queryClient = useQueryClient();

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>排休設定</CardTitle>
          <CardDescription>
            「整天排休」用月曆整天標記休假,「時段排休」可以精細調整單一半小時時段,兩者是同一份
            資料的兩種操作入口,可以交互使用。
          </CardDescription>
        </div>
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          onClick={() =>
            void queryClient.invalidateQueries({
              queryKey: ["staff-portal-module", "my-availability-overrides"],
            })
          }
        >
          重新整理
        </button>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="whole-day">
          <TabsList>
            <TabsTrigger value="whole-day">整天排休</TabsTrigger>
            <TabsTrigger value="by-slot">時段排休</TabsTrigger>
          </TabsList>
          <TabsContent value="whole-day">
            <WholeDayOffTab merchantId={merchantId} staffId={staffId} />
          </TabsContent>
          <TabsContent value="by-slot">
            <BySlotOffTab merchantId={merchantId} staffId={staffId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
