// SPECS-INDEX #1005(第 14 批,2026-10-07):行事曆時間軸「預約卡片」的共用樣式與版型判斷。
// 商家端(CalendarPage → DraggableBookingBlock)與服務人員端(MyCalendarTimelineView)兩邊共用,
// **不要各寫一份** —— 改一邊另一邊會又長得不一樣(主腦補上的決定,可單獨退)。
// 卡片內容元件在 BookingBlockContent.tsx(.tsx 只放元件,避免 react-refresh 警告)。

import type { CSSProperties } from "react";

/**
 * 卡片高度(px)達到這個值才排成三層「時間標籤 / 虛線 / 名字」,低於就把時間與名字排在同一行、不畫虛線。
 *
 * 怎麼算的(時間軸一格 30 分鐘 = 30px):卡片上下框 2px + 上下內距 8px,三層內容 = 時間標籤 14px
 * + 虛線含上下間距 5px + 名字一行約 14px ≈ 33px ⇒ 卡片至少要 2 + 8 + 33 = 43px,取 44px。
 * ⇒ 半小時(30px)一行;45 分鐘(45px)以上三層;一小時(60px)三層。
 */
export const BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX = 44;

export type BookingBlockLayout = "stacked" | "inline";

/** 高度不明(沒給數字)時當成放得下 —— 寧可多一層,也不要把一張長卡片擠成一行。 */
export function bookingBlockLayout(heightPx: number | undefined): BookingBlockLayout {
  if (typeof heightPx !== "number" || !Number.isFinite(heightPx)) return "stacked";
  return heightPx >= BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX ? "stacked" : "inline";
}

/**
 * 把共用的狀態色(bookingBlockStyle:淡色底 + 實色字 + 半透明框)轉成「白底卡片」版本:
 * 背景 = 卡片底色(var(--card),深色模式自動跟著主題),左側 4px 用狀態的實色,其他三邊維持原本的半透明框。
 *
 * 原本是服務人員端 MyCalendarTimelineView 自己的 staffPortalWhiteBlockStyle(#981),#1005 使用者要商家端
 * 也採用同一種外觀,所以搬到這裡兩邊共用。⚠️ 刻意**不改 bookingBlockStyle 本身**:那支的淡色底仍是
 * 「狀態顏色設定」預覽等地方的基準。
 */
export function whiteBookingBlockStyle(base: {
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
