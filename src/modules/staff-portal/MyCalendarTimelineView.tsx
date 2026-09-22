// 對應規格書 v2 §10.2.3:服務人員自助行事曆的「時間軸格線」檢視,針對目前選定的單一一天,
// 畫出跟商家端 CalendarPageInner 同樣風格的單欄時間軸格線(從開店到打烊依半小時切格)。
//
// 跟商家端時間軸的差異(規格書明講的三點):
//   1. 只有一欄(自己),不是多位服務人員並排。
//   2. 背景格線不做可預約/不可預約的顏色判斷、不掛 DropdownMenu——那一整套是給商家管理員/客服
//      「開關時段」「新增預約」用的操作邏輯,服務人員這裡純粹是唯讀顯示排程用的,不需要也不應該
//      有這些互動,背景格子一律用單一素色。
//   3. 資料來源不另外呼叫新的查詢:營業時間呼叫 10.2.1 的 useMyDayBusinessHours,預約清單由
//      呼叫端(MyCalendarPage.tsx)從已經用 useMyBookingSchedule 抓回來的整月資料裡,用
//      selectedDateKey 篩選出當天那幾筆再傳進來(前端記憶體篩選,不重新打 API)。
//
// 跟規格書 10.2.4「傳入 merchantId」的描述有一個小幅偏離:這個元件實際只需要 staffId(拿去查
// 10.2.1 的營業時間),不需要 merchantId 本身,所以介面設計上直接改成接受 staffId,由呼叫端
// (已經透過 useActiveMyStaffRecord 拿到 staffId)傳入,減少一層不必要的間接轉換。已在回報中
// 向主腦說明這個偏離。

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { isoToTaipeiTime, minutesToTime, timeToMinutes } from "@/modules/booking/dateUtils";
import { bookingBlockClasses, type BookingStatus } from "@/modules/booking/types";

import { useMyDayBusinessHours } from "./context";
import type { MyBookingScheduleItem } from "./api";

const SLOT_MINUTES = 30;
const SLOT_PX = 30;

export function MyCalendarTimelineView({
  staffId,
  selectedDateKey,
  bookings,
  onSelectBooking,
}: {
  staffId: string | null | undefined;
  selectedDateKey: string;
  bookings: MyBookingScheduleItem[];
  onSelectBooking: (bookingId: string) => void;
}) {
  const { data: businessHours, isLoading } = useMyDayBusinessHours(staffId, selectedDateKey);

  const slots = useMemo(() => {
    if (!businessHours || !businessHours.has_setting || businessHours.is_closed) return [];
    if (!businessHours.open_time || !businessHours.close_time) return [];
    const startMin = timeToMinutes(businessHours.open_time);
    const endMin = timeToMinutes(businessHours.close_time);
    const result: { start: string }[] = [];
    for (let m = startMin; m < endMin; m += SLOT_MINUTES) {
      result.push({ start: minutesToTime(m) });
    }
    return result;
  }, [businessHours]);

  const gridStartMin = slots.length > 0 ? timeToMinutes(slots[0]!.start) : 0;
  const gridTotalPx = slots.length * SLOT_PX;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }

  if (!businessHours?.has_setting || businessHours.is_closed) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
        {!businessHours?.has_setting ? "這天沒有設定營業時間" : "商家這天公休"}
      </p>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-border" style={{ height: gridTotalPx }}>
      {slots.map((slot, i) => (
        <div
          key={slot.start}
          className="absolute inset-x-0 border-t border-border bg-background first:border-t-0"
          style={{ top: i * SLOT_PX, height: SLOT_PX }}
        >
          <span className="pl-1.5 text-[10px] text-muted-foreground">{slot.start}</span>
        </div>
      ))}

      {bookings.map((b) => {
        const bStartMin = timeToMinutes(isoToTaipeiTime(b.start_at));
        const bEndMin = timeToMinutes(isoToTaipeiTime(b.end_at));
        const top = Math.max(0, ((bStartMin - gridStartMin) / SLOT_MINUTES) * SLOT_PX);
        const height = Math.max(SLOT_PX / 2, ((bEndMin - bStartMin) / SLOT_MINUTES) * SLOT_PX);
        return (
          <button
            key={`${b.id}-${b.role_in_booking}`}
            type="button"
            onClick={() => onSelectBooking(b.id)}
            className={cn(
              "absolute left-16 right-1 z-10 overflow-hidden rounded-sm p-1 text-left text-[11px] leading-tight shadow-sm",
              bookingBlockClasses(b.status as BookingStatus),
            )}
            style={{ top, height }}
          >
            <p className="truncate font-medium">
              {b.customer_name}
              {b.role_in_booking === "assistant" ? "(協助)" : ""}
            </p>
          </button>
        );
      })}
    </div>
  );
}
