// SPECS-INDEX #984(2026-10-07):月曆日期格的「待確認 / 已確認」兩色數字徽章,商家端行事曆與服務人員端
// 行事曆共用。markup 跟 #977 第 4 批服務人員端原本寫在 MyCalendarPage.tsx 裡的一字不差(搬家而已,
// 服務人員端外觀與 data-testid 不變)。
//
// 手機 375 寬一格約 44~45px(含 1px 邊框)。兩種都是兩位數(例如 12 / 10)時,原本 px-1 + 2px 間距
// 會超出格子邊框 ⇒ 左右內距 2px、間距 1px、數字等寬(tabular-nums),兩位數一顆約 16px,
// 兩顆加起來約 33px,留得下邊框與餘裕。whitespace-nowrap 防止擠成兩行。
// 顏色用商家自訂狀態色(solidFillStyle:原樣底色 + 固定深色字與邊框)。

import { solidFillStyle } from "@/lib/statusPillStyle";

import { getBookingStatusColor, type BookingStatusColorMap } from "./types";

export interface DayStatusCountBadgesProps {
  pending: number;
  accepted: number;
  statusColors: BookingStatusColorMap;
}

/** 兩顆都是 0 ⇒ 回傳 null(什麼都不畫);其中一顆是 0 ⇒ 那一顆不畫。 */
export function DayStatusCountBadges({
  pending,
  accepted,
  statusColors,
}: DayStatusCountBadgesProps) {
  if (pending <= 0 && accepted <= 0) return null;
  return (
    <span className="flex items-center gap-px whitespace-nowrap">
      {pending > 0 ? (
        <span
          data-testid="day-pending-count"
          aria-label={`待確認 ${pending} 筆`}
          className="min-w-4 rounded-full border px-0.5 text-[10px] leading-4 tabular-nums"
          style={solidFillStyle(getBookingStatusColor(statusColors, "pending_confirmation"))}
        >
          {pending}
        </span>
      ) : null}
      {accepted > 0 ? (
        <span
          data-testid="day-accepted-count"
          aria-label={`已確認 ${accepted} 筆`}
          className="min-w-4 rounded-full border px-0.5 text-[10px] leading-4 tabular-nums"
          style={solidFillStyle(getBookingStatusColor(statusColors, "accepted"))}
        >
          {accepted}
        </span>
      ) : null}
    </span>
  );
}
