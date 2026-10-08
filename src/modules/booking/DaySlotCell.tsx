// SPECS-INDEX #977 第 7 批(2026-10-07):時間軸背景「可以點的格子」從 CalendarPage.tsx 搬到這裡,
// 商家端行事曆與服務人員端時間軸(MyCalendarTimelineView)共用同一份,**不要複製一份**。
// 元件內容一字未改;手勢判斷(#641 點擊 vs 拖曳)在 daySlotGrid.ts 的 useTapVsDragOpenState。

import type { CSSProperties } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { useTapVsDragOpenState, type DaySlotState } from "./daySlotGrid";

export function DaySlotCell({
  top,
  height,
  cellClassName,
  cellStyle,
  ariaLabel,
  slotState,
  badgeText,
  showCreateOption,
  onCreateBooking,
  showOverrideOption,
  overrideOptionLabel,
  onToggleOverride,
}: {
  top: number;
  height: number;
  cellClassName: string;
  // SPECS-INDEX #644:時段排休(單日例外關閉)這一格改讀商家自訂顏色 + 圖樣,不能只靠
  // Tailwind class(build-time 就固定,無法接受任意動態色碼),所以額外開這個可選的 inline style
  // 插槽,查無資料的其他分支繼續維持純 className,不受影響。
  // #1021 第 21 批:服務人員可預約時段的淡色底(只有 backgroundColor)也走這個插槽。
  cellStyle?: CSSProperties | undefined;
  ariaLabel: string;
  /** 見 daySlotGrid.ts 的 DaySlotState 說明:輸出成 data-slot-state 屬性,給 e2e 測試穩定選取用。 */
  slotState: DaySlotState;
  badgeText: string;
  showCreateOption: boolean;
  onCreateBooking: () => void;
  showOverrideOption: boolean;
  overrideOptionLabel: string;
  onToggleOverride: () => void;
}) {
  const { open, onOpenChange, onPointerDown, onPointerMove, onPointerUp, onPointerCancel } =
    useTapVsDragOpenState();

  // #1023 第 22 批:選單一個選項都沒有(例:每週可預約時段外的灰格,拿掉「開啟時段」之後)⇒ 格子不可點、
  // 不掛選單(否則點了會跳一個空白小框),游標一般箭頭(#1022)。外觀(底色 / 斜線 / data-slot-state)照舊;
  // 呼叫端這時不要傳 hover 樣式(點了沒反應的格子不該有滑過回饋)。
  if (!showCreateOption && !showOverrideOption) {
    return (
      <div
        className={cn(
          "absolute inset-x-0 cursor-default border-b border-border p-1 text-left text-[9px] leading-tight",
          cellClassName,
        )}
        style={{ top, height, ...cellStyle }}
        aria-label={ariaLabel}
        data-slot-state={slotState}
      >
        {badgeText}
      </div>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "absolute inset-x-0 border-b border-border p-1 text-left text-[9px] leading-tight",
            // #1022 第 21 批:點了會跳選單(新增預約 / 開關時段)的格子,滑鼠移上去是手指
            // (沒有任何選項的格子在上面就改畫成不可點的 div 了)。
            "cursor-pointer",
            cellClassName,
          )}
          style={{ top, height, ...cellStyle }}
          aria-label={ariaLabel}
          data-slot-state={slotState}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {badgeText}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {showCreateOption ? (
          <DropdownMenuItem className="h-10 cursor-pointer" onClick={onCreateBooking}>
            新增預約
          </DropdownMenuItem>
        ) : null}
        {showOverrideOption ? (
          <DropdownMenuItem className="h-10 cursor-pointer" onClick={onToggleOverride}>
            {overrideOptionLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
