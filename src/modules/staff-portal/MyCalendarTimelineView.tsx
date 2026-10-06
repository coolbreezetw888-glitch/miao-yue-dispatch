// 對應規格書 v2 §10.2.3:服務人員自助行事曆的「時間軸格線」檢視,針對目前選定的單一一天,
// 畫出跟商家端 CalendarPageInner 同樣風格的單欄時間軸格線(從開店到打烊依半小時切格)。
//
// 🔴 SPECS-INDEX #977 第 7 批(2026-10-07):下面第 2 點改成「開關關閉時」的版本(裁決 1 / 2 / 9):
//   ・「服務人員新增編輯訂單」沒有生效(開關關、顯示會員資料關、或沒有行事曆檢視)⇒ **完全維持下面的唯讀現況**。
//   ・生效 ⇒ 背景格子改成可點(跟商家端同一個 DaySlotCell + #641 點擊 vs 拖曳判斷,直接拖空白格 = 捲動),
//     每一格的狀態用跟商家端同一支 resolveDaySlot 算(營業時間 ∩ 每週時段 + 單日例外 + 請假 + 跨店佔用);
//     選單:可預約的格子有「新增預約」;「開啟 / 關閉時段」只給方案 B2 的人(按件計酬 + 排班自助權限)。
//     自己是主要服務人員、待確認 / 已確認的色塊可以長按 0.5 秒上下拖改時間(同一個 useCalendarBookingDrag,
//     改打 staff_move_booking;只有一欄,不能轉派)。協助、已完成、已取消的色塊維持點一下開詳情。
//
// 跟商家端時間軸的差異(規格書明講的三點):
//   1. 只有一欄(自己),不是多位服務人員並排。
//   2. (開關關閉時)不掛 DropdownMenu、不能點格子開關時段/新增預約——服務人員這裡純粹是唯讀顯示排程用的。
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
// 🔴 SPECS-INDEX #860(2026-09-30 使用者實機巡檢):**預約色塊的顏色**這次也改成讀商家自訂的
// 訂單狀態顏色表(merchant_booking_status_colors),跟商家端 CalendarPage.tsx 套用完全同一支
// bookingBlockStyle。改版前這裡用的是 bookingBlockClasses(status)——寫死的 Tailwind class,
// 所以商家把「已確認」改成粉紅色,商家端變了、服務人員的手機上還是原來的藍色,同一筆預約兩種顏色。
// 當初寫死的原因是服務人員讀不到那張表(SELECT 政策條件是 private.can_manage_bookings,
// 純服務人員身分讀到 0 筆),#860 用 SECURITY DEFINER 的 get_my_booking_status_colors 解掉了
// (做法比照下面已經在用的 get_my_calendar_state_styles,沒有放寬任何 RLS 政策)。
//
// 跟規格書 10.2.4「傳入 merchantId」的描述有一個小幅偏離:這個元件實際只需要 staffId(拿去查
// 10.2.1 的營業時間、SPECS-INDEX #644 的排程狀態/顏色設定),不需要 merchantId 本身,所以介面
// 設計上直接改成接受 staffId,由呼叫端(已經透過 useActiveMyStaffRecord 拿到 staffId)傳入,
// 減少一層不必要的間接轉換。已在回報中向主腦說明這個偏離。

import { useCallback, useMemo, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { LoadingSkeleton } from "@/components/patterns";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import {
  BookingDragGhost,
  DraggableBookingBlock,
  PastDropConfirmDialog,
  useCalendarBookingDrag,
} from "@/modules/booking/calendarBookingDrag";
import { useStaffAvailabilityWindows } from "@/modules/booking/context";
import { DaySlotCell } from "@/modules/booking/DaySlotCell";
import {
  buildStaffDayAvailableWindows,
  resolveDaySlot,
  SLOT_TAP_VS_DRAG_THRESHOLD_PX,
} from "@/modules/booking/daySlotGrid";
import { isoToTaipeiTime, minutesToTime, timeToMinutes } from "@/modules/booking/dateUtils";
import {
  bookingBlockStyle,
  calendarStateBlockStyle,
  DEFAULT_BOOKING_STATUS_COLORS,
  DEFAULT_CALENDAR_STATE_STYLES,
  type BookingStatus,
  type DayScheduleOwnBooking,
  type DayScheduleStaffBlock,
} from "@/modules/booking/types";

import {
  useMyBookingStatusColors,
  useMyCalendarStateStyles,
  useMyDayBusinessHours,
  useMyDayScheduleState,
} from "./context";
import { staffMoveBooking, staffSetMySlot, type MyBookingScheduleItem } from "./api";
import { invalidateStaffSchedule } from "./staffScheduleChannel";

const SLOT_MINUTES = 30;
const SLOT_PX = 30;

/** #977 第 7 批:開關生效時才傳進來;沒傳 = 唯讀現況(裁決 1)。 */
export interface MyTimelineOrderActions {
  /** 「商家後台編輯無時段限制」:可約區間 = 整段營業時間(跟資料庫 get_merchant_day_schedule 同一條規則)。 */
  unlimitedBackendEdit: boolean;
  /** 方案 B2:選單有沒有「開啟 / 關閉時段」。 */
  canToggleSlots: boolean;
  /** 選單「新增預約」→ 打開服務人員模式的建單畫面,預帶日期與這一格的時間。 */
  onCreateBooking: (dateKey: string, time: string) => void;
}

export function MyCalendarTimelineView({
  staffId,
  selectedDateKey,
  bookings,
  onSelectBooking,
  orderActions = null,
}: {
  staffId: string | null | undefined;
  selectedDateKey: string;
  bookings: MyBookingScheduleItem[];
  onSelectBooking: (bookingId: string) => void;
  orderActions?: MyTimelineOrderActions | null;
}) {
  const queryClient = useQueryClient();
  const interactive = orderActions !== null && Boolean(staffId);
  const { data: businessHours, isLoading } = useMyDayBusinessHours(staffId, selectedDateKey);
  // SPECS-INDEX #644:這一天的全天休假/時段排休/跨店佔用狀態明細 + 商家自訂的對應顏色設定。
  const { data: dayState } = useMyDayScheduleState(staffId, selectedDateKey);
  const { data: calendarStateStyles } = useMyCalendarStateStyles(staffId);
  const effectiveCalendarStateStyles = calendarStateStyles ?? DEFAULT_CALENDAR_STATE_STYLES;
  // SPECS-INDEX #860:預約色塊的顏色改讀商家自訂的訂單狀態顏色表,跟商家端 CalendarPage.tsx
  // 完全同一支 bookingBlockStyle。載入中/查無資料時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS
  // (= 商家沒自訂過時的色碼,肉眼跟改版前的寫死配色一致),所以不會有「先閃一下錯的顏色」。
  const { data: bookingStatusColors } = useMyBookingStatusColors(staffId);
  const effectiveStatusColors = bookingStatusColors ?? DEFAULT_BOOKING_STATUS_COLORS;

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

  // ───── #977 第 7 批:開關生效時才用到的資料與接線(hook 一律無條件呼叫,沒生效時查詢停用)─────
  const { data: weeklyWindows } = useStaffAvailabilityWindows(interactive ? staffId : null);
  const availableWindows = useMemo(
    () =>
      businessHours
        ? buildStaffDayAvailableWindows({
            hasSetting: businessHours.has_setting,
            isClosed: businessHours.is_closed,
            openTime: businessHours.open_time,
            closeTime: businessHours.close_time,
            unlimitedBackendEdit: orderActions?.unlimitedBackendEdit === true,
            dayOfWeek: new Date(`${selectedDateKey}T00:00:00`).getDay(),
            weeklyWindows: weeklyWindows ?? [],
          })
        : [],
    [businessHours, orderActions?.unlimitedBackendEdit, selectedDateKey, weeklyWindows],
  );

  const refreshAfterChange = useCallback(() => {
    invalidateStaffSchedule(queryClient);
    void queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-bookable-start-times"],
    });
  }, [queryClient]);

  // 拖拉:只有一欄(自己),只放「自己是主要服務人員」的色塊進去(協助色塊不能拖)。
  const dragStaffBlocks = useMemo<DayScheduleStaffBlock[] | undefined>(() => {
    if (!interactive || !staffId) return undefined;
    return [
      {
        staff_id: staffId,
        staff_name: "",
        unlimited_backend_edit: orderActions?.unlimitedBackendEdit === true,
        available_windows: [],
        availability_overrides: [],
        on_leave: dayState?.on_leave ?? null,
        foreign_bookings: [],
        bookings: bookings
          .filter((b) => b.role_in_booking === "primary")
          .map<DayScheduleOwnBooking>((b) => ({
            id: b.id,
            start_at: b.start_at,
            end_at: b.end_at,
            status: b.status as BookingStatus,
            customer_name: b.customer_name,
            customer_phone: b.customer_phone ?? "",
            notes: null,
            role: "main",
            service_items: [],
          })),
      },
    ];
  }, [interactive, staffId, orderActions?.unlimitedBackendEdit, dayState?.on_leave, bookings]);
  const staffNameById = useMemo(() => new Map<string, string>(), []);
  const dragController = useCalendarBookingDrag({
    dateKey: selectedDateKey,
    staffBlocks: dragStaffBlocks,
    staffNameById,
    gridStartMin,
    slotCount: slots.length,
    slotMinutes: SLOT_MINUTES,
    slotPx: SLOT_PX,
    thresholdPx: SLOT_TAP_VS_DRAG_THRESHOLD_PX,
    onOpenDetail: (bookingId) => onSelectBooking(bookingId),
    onMoved: refreshAfterChange,
    moveFn: (input) => staffMoveBooking(input),
  });

  async function handleToggleSlot(start: string, end: string, currentlyAvailable: boolean) {
    if (!staffId) return;
    try {
      const conflictCount = await staffSetMySlot({
        staffId,
        date: selectedDateKey,
        startTime: start,
        endTime: end,
        isAvailable: !currentlyAvailable,
      });
      // 文字跟商家端 handleToggleDayOverride 一樣:有既有預約只提示不擋。
      if (conflictCount > 0) {
        toast.warning(
          `這個時段目前還有 ${conflictCount} 筆既有預約，系統不會自動取消或搬移，請自行確認是否需要另外處理。`,
        );
      } else {
        toast.success(currentlyAvailable ? "已關閉這個時段" : "已開啟這個時段");
      }
      refreshAfterChange();
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    }
  }

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。
    return <LoadingSkeleton variant="lines" rows={5} />;
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
          休假：{onLeave.leave_type_name}
        </p>
      ) : null}
      <div
        // #977 第 7 批:開關生效時這一層同時是拖拉的格線根節點(touchmove 只在拖拉中才 preventDefault)。
        ref={interactive ? dragController.setGridRoot : undefined}
        data-testid="my-timeline-grid"
        data-interactive={interactive ? "true" : undefined}
        data-drag-phase={interactive ? dragController.phase : undefined}
        className={cn(
          "relative overflow-hidden rounded-md border border-border",
          interactive && dragController.isCommitting && "pointer-events-none",
        )}
        style={{ height: gridTotalPx }}
      >
        {slots.map((slot, i) => {
          const slotStartMin = timeToMinutes(slot.start);
          const slotEndMin = slotStartMin + SLOT_MINUTES;

          // #977 第 7 批:開關生效、沒有整天請假 ⇒ 用跟商家端同一支 resolveDaySlot 算狀態、畫可點的格子。
          if (interactive && !onLeave) {
            const resolved = resolveDaySlot({
              slotStartMin,
              slotEndMin,
              availableWindows,
              overrides: dayState?.availability_overrides ?? [],
              foreignBookings: dayState?.foreign_bookings ?? [],
            });
            const label = `${slot.start}${
              resolved.foreignBusy
                ? "・外店預約中"
                : resolved.isOverride && !resolved.finalAvailable
                  ? "・時段排休"
                  : ""
            }`;
            const showOverride = orderActions?.canToggleSlots === true;
            // 跨店佔用、或這一格沒有任何可用操作(不可預約又不能開關時段)⇒ 純顯示,不包選單(比照商家端)。
            if (resolved.foreignBusy || (!resolved.finalAvailable && !showOverride)) {
              const plainStyle = resolved.foreignBusy
                ? calendarStateBlockStyle(effectiveCalendarStateStyles, "cross_store_occupied")
                : resolved.isOverride
                  ? calendarStateBlockStyle(effectiveCalendarStateStyles, "partial_leave")
                  : undefined;
              return (
                <div
                  key={slot.start}
                  className={cn(
                    "absolute inset-x-0 border-t border-border first:border-t-0",
                    plainStyle ? undefined : "bg-muted/40",
                  )}
                  style={{ top: i * SLOT_PX, height: SLOT_PX, ...plainStyle }}
                  data-slot-state={resolved.state}
                  aria-label="不可預約"
                >
                  <span className="pl-1.5 text-[10px] text-muted-foreground">{label}</span>
                </div>
              );
            }
            return (
              <DaySlotCell
                key={slot.start}
                top={i * SLOT_PX}
                height={SLOT_PX}
                cellClassName={cn(
                  "pl-1.5 text-[10px] text-muted-foreground",
                  resolved.finalAvailable
                    ? resolved.isOverride
                      ? "bg-brand-soft/70 ring-1 ring-inset ring-brand hover:bg-brand-soft"
                      : "bg-background hover:bg-brand-soft/40"
                    : resolved.isOverride
                      ? "hover:opacity-80"
                      : "bg-muted/40 hover:bg-muted/60",
                )}
                cellStyle={
                  resolved.isOverride && !resolved.finalAvailable
                    ? calendarStateBlockStyle(effectiveCalendarStateStyles, "partial_leave")
                    : undefined
                }
                ariaLabel={
                  resolved.finalAvailable ? `${slot.start} 可預約` : `${slot.start} 不可預約`
                }
                slotState={resolved.state}
                badgeText={label}
                showCreateOption={resolved.finalAvailable}
                onCreateBooking={() => orderActions?.onCreateBooking(selectedDateKey, slot.start)}
                showOverrideOption={showOverride}
                overrideOptionLabel={resolved.finalAvailable ? "關閉時段" : "開啟時段"}
                onToggleOverride={() =>
                  void handleToggleSlot(
                    slot.start,
                    minutesToTime(slotEndMin),
                    resolved.finalAvailable,
                  )
                }
              />
            );
          }

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

        {/* #977 第 7 批:拖拉落點計算要的「欄位」(只有一欄 = 自己)。放在格子後面、不吃滑鼠事件,
            唯讀時不渲染(不影響原本第一格的 first:border-t-0)。 */}
        {interactive && staffId ? (
          <div className="pointer-events-none absolute inset-0" data-drag-column={staffId} />
        ) : null}
        {bookings.map((b) => {
          const bStartMin = timeToMinutes(isoToTaipeiTime(b.start_at));
          const bEndMin = timeToMinutes(isoToTaipeiTime(b.end_at));
          const top = Math.max(0, ((bStartMin - gridStartMin) / SLOT_MINUTES) * SLOT_PX);
          const height = Math.max(SLOT_PX / 2, ((bEndMin - bStartMin) / SLOT_MINUTES) * SLOT_PX);
          // #977 第 7 批(裁決 9):開關生效 + 自己是主要服務人員 + 待確認 / 已確認 ⇒ 可以長按拖拉改時間。
          // 用商家端同一個 DraggableBookingBlock(手勢、長按 500ms、復原提示都同一份);位置照服務人員端的
          // left-16 right-1(inline style 蓋過元件預設的 inset-x-0)。
          const ownDraggable =
            interactive &&
            staffId &&
            b.role_in_booking === "primary" &&
            (b.status === "pending_confirmation" || b.status === "accepted");
          if (ownDraggable && staffId) {
            return (
              <DraggableBookingBlock
                key={`${b.id}-${b.role_in_booking}`}
                booking={{
                  id: b.id,
                  start_at: b.start_at,
                  end_at: b.end_at,
                  status: b.status as BookingStatus,
                  customer_name: b.customer_name,
                  customer_phone: b.customer_phone ?? "",
                  notes: null,
                  role: "main",
                  service_items: [],
                }}
                staffId={staffId}
                style={{
                  top,
                  height,
                  left: 64,
                  right: 4,
                  ...staffPortalWhiteBlockStyle(
                    bookingBlockStyle(effectiveStatusColors, b.status as BookingStatus),
                  ),
                }}
                controller={dragController}
              />
            );
          }
          return (
            <button
              key={`${b.id}-${b.role_in_booking}`}
              type="button"
              onClick={() => onSelectBooking(b.id)}
              // SPECS-INDEX #860:原本這裡是 bookingBlockClasses(status)——寫死的 Tailwind class,
              // 所以商家在「訂單狀態顏色設定」改的顏色完全不會反映到服務人員的手機上,兩端看到的
              // 同一筆預約是不同顏色。改成跟商家端 CalendarPage.tsx:2448 同一支 bookingBlockStyle
              // (背景 16% 透明 + 實色文字/邊框),兩端的色塊從此一致。
              // 動態顏色沒辦法寫成 Tailwind class(build 時就固定了),所以是 inline style。
              className="absolute left-16 right-1 z-10 overflow-hidden rounded-sm border p-1 text-left text-[11px] leading-tight shadow-sm"
              // 🔴 SPECS-INDEX #981(2026-10-06):服務人員端「時間軸格線」檢視的預約色塊也照 #970 一律白底
              // (規格書:服務人員端行事曆含各種檢視)。做法:沿用 bookingBlockStyle 的文字色 / 邊框色,
              // 只把背景換成卡片底色(var(--card),深色模式自動跟著主題),再補一條 4px 左側狀態色條,
              // 狀態仍一眼看得出來。⚠️ 刻意只在這個檔案就地覆寫,**不改 bookingBlockStyle 本身** ——
              // 那支函式商家端 CalendarPage.tsx 也在用,商家端行事曆的色塊不在這次範圍內。
              style={{
                top,
                height,
                ...staffPortalWhiteBlockStyle(
                  bookingBlockStyle(effectiveStatusColors, b.status as BookingStatus),
                ),
              }}
            >
              <p className="truncate font-medium">
                {b.customer_name}
                {b.role_in_booking === "assistant" ? "(協助)" : ""}
              </p>
            </button>
          );
        })}
      </div>
      {interactive ? (
        <>
          {/* #811 殘影(position: fixed)與 #816 拖到過去時間的確認框,同商家端。 */}
          <BookingDragGhost ghost={dragController.ghost} />
          <PastDropConfirmDialog
            request={dragController.pastConfirm}
            onResolve={dragController.resolvePastConfirm}
          />
        </>
      ) : null}
    </div>
  );
}

/** #981:把商家端共用的色塊樣式(淡色底 + 實色字 + 半透明框)轉成服務人員端的白底版本。
 * 背景 = 卡片底色;左側 4px 用狀態的實色(= bookingBlockStyle 的文字色),其他三邊維持原本的半透明框。 */
function staffPortalWhiteBlockStyle(base: {
  backgroundColor: string;
  color: string;
  borderColor: string;
}): CSSProperties {
  return {
    color: base.color,
    borderColor: base.borderColor,
    borderLeftColor: base.color,
    borderLeftWidth: 4,
    backgroundColor: "var(--card)",
  };
}
