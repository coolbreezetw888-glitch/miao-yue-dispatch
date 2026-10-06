// SPECS-INDEX #977 第 7 批(2026-10-07):時間軸背景「可以點的格子」從 CalendarPage.tsx 搬到這裡,
// 商家端行事曆與服務人員端時間軸(MyCalendarTimelineView)共用同一份,**不要複製一份**。
// 元件內容一字未改;手勢判斷(#641 點擊 vs 拖曳)在 daySlotGrid.ts 的 useTapVsDragOpenState。

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
  cellStyle?:
    | { backgroundColor: string; backgroundImage: string; borderColor: string; color: string }
    | undefined;
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

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "absolute inset-x-0 border-b border-border p-1 text-left text-[9px] leading-tight",
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
