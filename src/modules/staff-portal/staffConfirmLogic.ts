// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認 — 純函式(方便 Vitest 直接測)。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第三節。
//
// 名詞:畫面「待確認」= 資料庫 pending_confirmation;畫面「已確認」= 資料庫 accepted(沒有 confirmed)。

import { isoToTaipeiDateKey } from "@/modules/booking/dateUtils";

import type { MyBookingScheduleItem } from "./api";

/**
 * 預約詳情要不要出現「確認接單」按鈕:訂單是待確認、而且自己是主要服務人員(主腦裁決 ①)。
 * 協助人員、已確認、已完成、已取消一律不顯示。
 * ⚠️ 這只是畫面判斷;真正的權限在資料庫 public.staff_confirm_booking(前端不能只靠隱藏按鈕擋)。
 */
export function canStaffConfirmBooking(
  booking: Pick<MyBookingScheduleItem, "status" | "role_in_booking"> | null | undefined,
): boolean {
  if (!booking) return false;
  return booking.status === "pending_confirmation" && booking.role_in_booking === "primary";
}

/**
 * 月曆日期格的兩色數量(第三節第 3 點):只算待確認、已確認兩種,已完成不算(主腦裁決 ④)。
 * 同一筆訂單只算一次(防禦:get_my_booking_schedule 對同一人不會同時回主要與協助,但不依賴這件事)。
 */
export function countDayStatusBadges(
  bookings: readonly Pick<MyBookingScheduleItem, "id" | "status">[] | null | undefined,
): { pending: number; accepted: number } {
  const seen = new Set<string>();
  let pending = 0;
  let accepted = 0;
  for (const b of bookings ?? []) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    if (b.status === "pending_confirmation") pending += 1;
    else if (b.status === "accepted") accepted += 1;
  }
  return { pending, accepted };
}

/**
 * 鈴鐺「你有 N 筆訂單待確認」的 N(第三節第 4 點):只算自己是主要服務人員、今天以後(含今天,台北日期)的待確認單。
 * todayKey 格式 YYYY-MM-DD(跟 isoToTaipeiDateKey 同一套),由呼叫端傳入方便測試。
 */
export function countMyPendingConfirmations(
  bookings:
    | readonly Pick<MyBookingScheduleItem, "id" | "status" | "role_in_booking" | "start_at">[]
    | null
    | undefined,
  todayKey: string,
): number {
  const seen = new Set<string>();
  for (const b of bookings ?? []) {
    if (b.role_in_booking !== "primary" || b.status !== "pending_confirmation") continue;
    if (isoToTaipeiDateKey(b.start_at) < todayKey) continue;
    seen.add(b.id);
  }
  return seen.size;
}

/**
 * 鈴鐺待確認提醒往後看幾天。get_my_booking_schedule 一次最多查 62 天(後端硬上限),
 * 所以「今天以後」實際上是今天起 62 天內。
 */
export const PENDING_REMINDER_RANGE_DAYS = 62;
