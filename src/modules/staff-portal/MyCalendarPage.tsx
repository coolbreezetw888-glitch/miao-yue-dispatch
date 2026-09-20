// 對應規格書 4.3:服務人員自助行事曆(疊加在既有 src/modules/booking/CalendarPage.tsx 的
// role==='staff' 分支底下渲染)。月曆檢視 + 點開某一天看當天的預約明細清單(規則 2.5:含以
// 助手身份參與的預約;規則 2.6:依 show_member_info 決定要不要顯示會員專屬資訊)。
// 比起既有管理員/客服版本的行事曆(可以跨服務人員切換、建單、編輯),這裡刻意做成簡化版
// 唯讀檢視——服務人員這次的範圍只到「看得到自己的排程」,不包含建單/編輯(見規格書判斷 2)。

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  addDays,
  buildMonthGrid,
  getTaipeiNow,
  startOfMonth,
  addMonths,
  toDateKey,
} from "@/modules/booking/dateUtils";

import { useMyBookingSchedule, useMyStaffPermission } from "./context";
import type { MyBookingScheduleItem } from "./api";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function BookingListItem({ booking }: { booking: MyBookingScheduleItem }) {
  const startTime = new Date(booking.start_at).toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const endTime = new Date(booking.end_at).toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {startTime} - {endTime}
        </p>
        <div className="flex gap-1.5">
          <Badge variant={booking.role_in_booking === "primary" ? "default" : "secondary"}>
            {booking.role_in_booking === "primary" ? "主要服務人員" : "協助"}
          </Badge>
          {booking.is_member ? <Badge variant="outline">會員</Badge> : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-foreground">
        {booking.customer_name}
        {booking.customer_phone ? `・${booking.customer_phone}` : ""}
      </p>
      {booking.customer_address ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{booking.customer_address}</p>
      ) : null}
      {booking.service_item_names.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          服務項目:{booking.service_item_names.join("、")}
        </p>
      ) : null}
      {booking.notes ? (
        <p className="mt-1 text-xs text-muted-foreground">內部備註:{booking.notes}</p>
      ) : null}
      {booking.customer_notes ? (
        <p className="mt-1 text-xs text-muted-foreground">客戶備註:{booking.customer_notes}</p>
      ) : null}
      {booking.is_member ? (
        <p className="mt-1 text-xs text-muted-foreground">
          會員{booking.member_name ? `:${booking.member_name}` : ""}
          {booking.member_points_balance != null
            ? `(目前點數 ${booking.member_points_balance})`
            : ""}
        </p>
      ) : null}
      {booking.final_amount_snapshot != null ? (
        <p className="mt-1 text-xs text-muted-foreground">金額:{booking.final_amount_snapshot} 元</p>
      ) : null}
    </li>
  );
}

export default function MyCalendarPage() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: hasCalendarAccess, isLoading: permissionLoading } =
    useMyStaffPermission("staff_calendar_view");

  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(getTaipeiNow()));
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() => toDateKey(getTaipeiNow()));

  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const rangeStartKey = toDateKey(monthGrid[0]!.date);
  const rangeEndKey = toDateKey(monthGrid[monthGrid.length - 1]!.date);

  const {
    data: schedule,
    isLoading: scheduleLoading,
    error,
  } = useMyBookingSchedule(merchantId, rangeStartKey, rangeEndKey);

  const bookingsByDate = useMemo(() => {
    const map = new Map<string, MyBookingScheduleItem[]>();
    for (const b of schedule ?? []) {
      const key = toDateKey(new Date(b.start_at));
      const list = map.get(key) ?? [];
      list.push(b);
      map.set(key, list);
    }
    return map;
  }, [schedule]);

  if (permissionLoading) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }

  if (hasCalendarAccess !== true) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「行事曆檢視」權限。
        </CardContent>
      </Card>
    );
  }

  const selectedDayBookings = bookingsByDate.get(selectedDateKey) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonthAnchor((prev) => addMonths(prev, -1))}
        >
          ← 上個月
        </Button>
        <p className="text-sm font-semibold text-foreground">
          {monthAnchor.getFullYear()} 年 {monthAnchor.getMonth() + 1} 月
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonthAnchor((prev) => addMonths(prev, 1))}
        >
          下個月 →
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>
      ) : (
        <div className="grid grid-cols-7 gap-1 text-center text-xs">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="py-1 text-muted-foreground">
              {label}
            </div>
          ))}
          {monthGrid.map(({ date, inCurrentMonth }) => {
            const dateKey = toDateKey(date);
            const count = bookingsByDate.get(dateKey)?.length ?? 0;
            const isSelected = dateKey === selectedDateKey;
            return (
              <button
                key={dateKey}
                type="button"
                onClick={() => setSelectedDateKey(dateKey)}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-md border text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:bg-muted"
                } ${inCurrentMonth ? "" : "opacity-40"}`}
              >
                <span>{date.getDate()}</span>
                {count > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{selectedDateKey} 的預約</CardTitle>
        </CardHeader>
        <CardContent>
          {scheduleLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : selectedDayBookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">這一天沒有預約。</p>
          ) : (
            <ul className="space-y-2">
              {selectedDayBookings
                .slice()
                .sort((a, b) => a.start_at.localeCompare(b.start_at))
                .map((booking) => (
                  <BookingListItem key={`${booking.id}-${booking.role_in_booking}`} booking={booking} />
                ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
