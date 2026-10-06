// SPECS-INDEX #977 第 7 批(2026-10-07):行事曆時間軸「背景格子」的共用邏輯(商家端 CalendarPage + 服務人員端
// MyCalendarTimelineView 兩邊共用同一份,不再各寫一套)。原本都在 CalendarPage.tsx 裡,這次搬出來:
//   ・useTapVsDragOpenState / SLOT_TAP_VS_DRAG_THRESHOLD_PX(SPECS-INDEX #641:點擊 vs 拖曳的判斷,一字未改)
//   ・DaySlotState / daySlotState(每一格的 data-slot-state,一字未改)
//   ・resolveDaySlot(新,純函式):原本寫在 CalendarPageInner 迴圈裡的「這一格可不可預約、是不是單日例外、
//     是不是跨店佔用」判斷,原樣搬出來,兩邊算出來的 data-slot-state 一定一樣
//   ・buildStaffDayAvailableWindows(新,純函式):服務人員端沒有 get_merchant_day_schedule,
//     用跟資料庫 get_merchant_day_schedule 的 available_windows 同一條規則在前端算出這一天的可約區間
//     (營業時間 ∩ 每週可預約時段;「商家後台編輯無時段限制」⇒ 整段營業時間;公休 / 沒設定 ⇒ 空)
// 元件本體(DaySlotCell)在 DaySlotCell.tsx(.tsx 只放元件,避免 react-refresh 警告)。

import { useRef, useState } from "react";

import { isoToTaipeiTime, timeToMinutes } from "./dateUtils";

// ---------------------------------------------------------------------------
// SPECS-INDEX #641:服務人員時間軸單一時段格子——手機版橫向滑動誤觸建單/開關時段修復。
//
// 背景:格子本身是 Radix DropdownMenuTrigger(asChild 包一個 <button>),Radix 內建行為是
// 「pointerdown 當下就開啟選單」,這是為了桌面版滑鼠點擊的即時回饋設計的。但在手機上,使用者
// 想要左右滑動瀏覽不同服務人員時,手指一碰到格子就會被 Radix 判定成「按下」而立刻彈出選單,
// 打斷原生的橫向捲動手勢,體驗上就是「滑動誤觸建單/開關時段」。
//
// 修法:把 DropdownMenu 改成受控元件(open/onOpenChange 自己管),攔下 Radix 這次自動開啟的
// 請求,改成自己用 pointerdown/pointermove/pointerup 量測這次的移動距離——超過閾值視為「拖曳
// 滑動」,不開啟選單(交給瀏覽器原生橫向捲動繼續跑,這裡完全不對 pointermove/touchmove 呼叫
// preventDefault,不會擋到原生捲動);沒有超過閾值、放開時才是真正的「點擊」,這時候才真的
// 呼叫 setOpen(true) 開啟選單。
//
// 2026-09-24 使用者回報後擴大適用範圍:原本這套判斷只在 pointerType==="touch" 時生效,滑鼠
// 維持 Radix 原本「按下就開啟」的行為。實際使用後使用者明確要求滑鼠也要一致——「要放掉左鍵
// 才出現,按住則可左右橫移」,所以現在**不分指標裝置**(滑鼠/觸控/觸控筆)一律套用同一套
// 判斷。附帶效果:桌面用滑鼠按住格子左右拖曳時不會再彈出選單,可以直接拖曳瀏覽時間軸。
//
// 邊界情況(拖曳到格子外面才放開):該格子收不到 pointerup,選單不會開啟——這正是想要的行為;
// 而且下一次重新按下時 onPointerDown 會重設狀態、放開時 onPointerUp 會直接 setOpen(true),
// 不會被上一次殘留的攔截旗標卡住(見 onPointerUp 的實作)。
// SPECS-INDEX #812:拖拉色塊的「點擊 vs 拖曳」閾值沿用這個數字(傳進 useCalendarBookingDrag →
// useBookingDragState),不另外定義第二個閾值。
export const SLOT_TAP_VS_DRAG_THRESHOLD_PX = 10;

/** 這裡指的「指標事件」只取用 pointerType/clientX/clientY 三個欄位,故意不寫成
 * `React.PointerEvent`——這樣 Vitest 測試(touchTapVsDragOpen.test.ts)可以直接傳一般物件
 * 呼叫這個 hook 回傳的 handler,不需要真的建立一個瀏覽器 PointerEvent 才能測。 */
interface MinimalPointerEvent {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** SPECS-INDEX #641:把「觸控點擊 vs 拖曳滑動」的判斷邏輯抽成獨立的 hook,好處是可以直接用
 * Vitest + @testing-library/react 的 renderHook 單獨測試這段手勢判斷邏輯,不需要整個渲染
 * CalendarPage(牽動大量 context/react-query mocking)。 */
export function useTapVsDragOpenState(thresholdPx: number = SLOT_TAP_VS_DRAG_THRESHOLD_PX) {
  const [open, setOpen] = useState(false);
  // 這次的開啟請求是不是 Radix 對觸控 pointerdown 的內建自動反應——是的話先攔下來,改由
  // onPointerUp 依照這次觸控實際有沒有拖曳超過閾值,再決定要不要真的開啟。
  const suppressAutoOpenRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  function onOpenChange(next: boolean) {
    if (next && suppressAutoOpenRef.current) return;
    setOpen(next);
  }

  // 2026-09-24 起不分指標裝置一律套用(見上方說明),所以這三支 handler 不再有 pointerType 的提前 return。
  function onPointerDown(e: MinimalPointerEvent) {
    suppressAutoOpenRef.current = true;
    draggedRef.current = false;
    touchStartRef.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: MinimalPointerEvent) {
    if (!touchStartRef.current) return;
    const dx = Math.abs(e.clientX - touchStartRef.current.x);
    const dy = Math.abs(e.clientY - touchStartRef.current.y);
    if (dx > thresholdPx || dy > thresholdPx) {
      draggedRef.current = true;
    }
  }

  function onPointerUp() {
    const wasTap = touchStartRef.current !== null && !draggedRef.current;
    touchStartRef.current = null;
    suppressAutoOpenRef.current = false;
    if (wasTap) setOpen(true);
  }

  function onPointerCancel() {
    // 瀏覽器判定這次觸控變成原生捲動手勢時會直接發 pointercancel,不會再有 pointerup——
    // 一併重置狀態,避免下一次觸控被誤判成延續上一次的拖曳/攔截狀態。
    touchStartRef.current = null;
    suppressAutoOpenRef.current = false;
    draggedRef.current = false;
  }

  return { open, onOpenChange, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/** 2026-09-24 新增(可測試性):每一格背景格線目前是哪一種狀態。
 *
 * 2026-09-24 使用者要求「例外開啟/例外關閉這個色塊不需要文字說明,只有跨店占用需要文字」之後,
 * 這幾種狀態在畫面上只剩下底色/斜線圖樣的差別,而圖樣本身是商家可自訂的動態 inline style
 * (SPECS-INDEX #644),沒有任何穩定的 class 或文字可以選取。e2e 測試需要驗證「整天/單一時段
 * 排休之後,商家管理員視角這幾格確實呈現成例外關閉」,所以把狀態本身以 data-slot-state 屬性
 * 明確標出來,改成斷言狀態而不是斷言文字。這是純粹的可測試性標記,不影響任何畫面呈現。 */
export type DaySlotState =
  /** 落在可預約時段內,沒有單日例外。 */
  | "available"
  /** 不在可預約時段內,也沒有單日例外(預設關閉)。 */
  | "unavailable"
  /** 單日例外把這一格「開啟」成可預約。 */
  | "override-open"
  /** 單日例外把這一格「關閉」(時段排休/整天排休都走這個狀態)。 */
  | "override-closed"
  /** 這位服務人員在同一時段被別家商家的預約佔用。 */
  | "cross-store-occupied";

export function daySlotState(isOverride: boolean, finalAvailable: boolean): DaySlotState {
  if (isOverride) return finalAvailable ? "override-open" : "override-closed";
  return finalAvailable ? "available" : "unavailable";
}

export interface DaySlotTimeRange {
  start_time: string;
  end_time: string;
}

export interface DaySlotOverride extends DaySlotTimeRange {
  is_available: boolean;
}

export interface DaySlotForeignBooking {
  start_at: string;
  end_at: string;
}

export interface ResolvedDaySlot {
  /** 這一格被同一個人在別家店的預約佔用(畫成「外店預約中」,不給任何操作)。 */
  foreignBusy: boolean;
  /** 這一格有單日例外。 */
  isOverride: boolean;
  /** 套上單日例外之後,這一格最後可不可以預約。 */
  finalAvailable: boolean;
  /** 輸出到 data-slot-state 的值。 */
  state: DaySlotState;
}

/**
 * 一格的狀態(模組 6 §5.3 / §5.5 第 4 點):先看有沒有落在某個單日例外區間內,有就採用該區間的
 * is_available;沒有就看是否完整落在可約區間(available_windows = 營業時間 ∩ 每週時段)。
 * 跨店佔用優先顯示。這段邏輯原本寫在 CalendarPageInner 的迴圈裡,這次原樣搬出來給兩邊共用。
 */
export function resolveDaySlot(input: {
  slotStartMin: number;
  slotEndMin: number;
  availableWindows: readonly DaySlotTimeRange[];
  overrides: readonly DaySlotOverride[];
  foreignBookings: readonly DaySlotForeignBooking[];
}): ResolvedDaySlot {
  const { slotStartMin, slotEndMin } = input;
  const inWindow = input.availableWindows.some(
    (w) => timeToMinutes(w.start_time) <= slotStartMin && timeToMinutes(w.end_time) >= slotEndMin,
  );
  const matchedOverride = input.overrides.find(
    (o) => timeToMinutes(o.start_time) <= slotStartMin && timeToMinutes(o.end_time) >= slotEndMin,
  );
  const isOverride = Boolean(matchedOverride);
  // §5.3 第 1 點:有例外直接採用例外值,不論第一層∩第二層原本判斷結果是什麼。
  const finalAvailable = matchedOverride ? matchedOverride.is_available : inWindow;
  const foreignBusy = input.foreignBookings.some((b) => {
    const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
    const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
    return bStart < slotEndMin && bEnd > slotStartMin;
  });
  return {
    foreignBusy,
    isOverride,
    finalAvailable,
    state: foreignBusy ? "cross-store-occupied" : daySlotState(isOverride, finalAvailable),
  };
}

/**
 * 服務人員端用:這一天的可約區間,規則跟資料庫 get_merchant_day_schedule 的 available_windows 逐條對應:
 *   ・沒有營業時間設定 / 公休 ⇒ 空
 *   ・「商家後台編輯無時段限制」(unlimited_backend_edit)⇒ 整段營業時間
 *   ・否則 = 這個星期幾的每週可預約時段,各自跟營業時間取交集(完全落在營業時間外的不算)
 * 時間字串可能是 "HH:MM" 或 "HH:MM:SS",比大小一律換成分鐘數。
 */
export function buildStaffDayAvailableWindows(input: {
  hasSetting: boolean;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
  unlimitedBackendEdit: boolean;
  dayOfWeek: number;
  weeklyWindows: readonly { day_of_week: number; start_time: string; end_time: string }[];
}): DaySlotTimeRange[] {
  if (!input.hasSetting || input.isClosed || !input.openTime || !input.closeTime) return [];
  const open = timeToMinutes(input.openTime);
  const close = timeToMinutes(input.closeTime);
  if (input.unlimitedBackendEdit) {
    return [{ start_time: input.openTime, end_time: input.closeTime }];
  }
  return input.weeklyWindows
    .filter(
      (w) =>
        w.day_of_week === input.dayOfWeek &&
        timeToMinutes(w.start_time) < close &&
        timeToMinutes(w.end_time) > open,
    )
    .slice()
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))
    .map((w) => ({
      start_time: timeToMinutes(w.start_time) >= open ? w.start_time : input.openTime!,
      end_time: timeToMinutes(w.end_time) <= close ? w.end_time : input.closeTime!,
    }));
}
