// 對應規格書 v2 §10.2.3:服務人員自助行事曆的「時間軸格線」檢視,針對目前選定的單一一天,
// 畫出跟商家端 CalendarPageInner 同樣風格的單欄時間軸格線(從開店到打烊依半小時切格)。
//
// 跟商家端時間軸的差異(規格書明講的三點):
//   1. 只有一欄(自己),不是多位服務人員並排。
//   2. 不掛 DropdownMenu、不能點格子開關時段/新增預約——那一整套是給商家管理員/客服用的操作
//      邏輯,服務人員這裡純粹是唯讀顯示排程用的,不需要也不應該有這些互動。
//   3. 資料來源不另外呼叫新的查詢:營業時間呼叫 10.2.1 的 useMyDayBusinessHours,預約清單由
//      呼叫端(MyCalendarPage.tsx)從已經用 useMyBookingSchedule 抓回來的整月資料裡,用
//      selectedDateKey 篩選出當天那幾筆再傳進來(前端記憶體篩選,不重新打 API)。
//
// SPECS-INDEX #644 新增:背景格線這次改成會顯示「全天休假/時段排休/跨店佔用」三種排程狀態
// (在此之前,背景格子一律用單一素色,完全不顯示這三種狀態——這是本次新增的能力,不是既有能力
// 改讀新設定表)。三種狀態的底色/圖樣讀商家設定頁(MerchantSettingsPage.tsx)同一份
// merchant_calendar_state_styles 設定,跟商家/客服端行事曆(CalendarPage.tsx)套用同一套
// calendarStateBlockStyle 純函式,兩邊顯示結果一致。這裡仍然是純唯讀顯示,不掛任何互動
// (跟上面第 2 點的既有原則一致,新增的只是視覺呈現,不是操作能力)。
//
// 跟規格書 10.2.4「傳入 merchantId」的描述有一個小幅偏離:這個元件實際只需要 staffId(拿去查
// 10.2.1 的營業時間、SPECS-INDEX #644 的排程狀態/顏色設定),不需要 merchantId 本身,所以介面
// 設計上直接改成接受 staffId,由呼叫端(已經透過 useActiveMyStaffRecord 拿到 staffId)傳入,
// 減少一層不必要的間接轉換。已在回報中向主腦說明這個偏離。

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { isoToTaipeiTime, minutesToTime, timeToMinutes } from "@/modules/booking/dateUtils";
import {
  bookingBlockClasses,
  calendarStateBlockStyle,
  DEFAULT_CALENDAR_STATE_STYLES,
  type BookingStatus,
} from "@/modules/booking/types";

import { useMyCalendarStateStyles, useMyDayBusinessHours, useMyDayScheduleState } from "./context";
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
  // SPECS-INDEX #644:這一天的全天休假/時段排休/跨店佔用狀態明細 + 商家自訂的對應顏色設定。
  const { data: dayState } = useMyDayScheduleState(staffId, selectedDateKey);
  const { data: calendarStateStyles } = useMyCalendarStateStyles(staffId);
  const effectiveCalendarStateStyles = calendarStateStyles ?? DEFAULT_CALENDAR_STATE_STYLES;

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

  const onLeave = dayState?.on_leave ?? null;

  return (
    <div className="space-y-1.5">
      {/* SPECS-INDEX #644:整天休假時在格線上方額外顯示一行文字,不是只靠底下格線的圖樣分辨
          (比照商家端 CalendarPageInner 欄位標題也會顯示「休假:xxx」的既有做法)。 */}
      {onLeave ? (
        <p
          className="text-xs font-medium"
          style={{
            color: calendarStateBlockStyle(effectiveCalendarStateStyles, "full_day_leave").color,
          }}
        >
          休假:{onLeave.leave_type_name}
        </p>
      ) : null}
      <div
        className="relative overflow-hidden rounded-md border border-border"
        style={{ height: gridTotalPx }}
      >
        {slots.map((slot, i) => {
          const slotStartMin = timeToMinutes(slot.start);
          const slotEndMin = slotStartMin + SLOT_MINUTES;

          // 整天休假時不用再逐格判斷時段排休/跨店佔用——請假一律擋下,底下不會再有其他狀態需要
          // 顯示,跟商家端「on_leave 直接跳過整欄背景格線判斷」的既有邏輯一致。
          const matchedOverride = onLeave
            ? undefined
            : (dayState?.availability_overrides ?? []).find(
                (o) =>
                  timeToMinutes(o.start_time) <= slotStartMin &&
                  timeToMinutes(o.end_time) >= slotEndMin,
              );
          const isPartialLeave = matchedOverride ? !matchedOverride.is_available : false;

          const isForeignBusy = onLeave
            ? false
            : (dayState?.foreign_bookings ?? []).some((b) => {
                const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
                const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
                return bStart < slotEndMin && bEnd > slotStartMin;
              });

          const slotState = onLeave
            ? "full_day_leave"
            : isForeignBusy
              ? "cross_store_occupied"
              : isPartialLeave
                ? "partial_leave"
                : null;
          const slotStyle = slotState
            ? calendarStateBlockStyle(effectiveCalendarStateStyles, slotState)
            : undefined;

          return (
            <div
              key={slot.start}
              className={cn(
                "absolute inset-x-0 border-t border-border first:border-t-0",
                slotStyle ? undefined : "bg-background",
              )}
              style={{ top: i * SLOT_PX, height: SLOT_PX, ...slotStyle }}
            >
              <span className="pl-1.5 text-[10px] text-muted-foreground">
                {slot.start}
                {isForeignBusy ? "・外店預約中" : isPartialLeave ? "・時段排休" : ""}
              </span>
            </div>
          );
        })}

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
    </div>
  );
}
