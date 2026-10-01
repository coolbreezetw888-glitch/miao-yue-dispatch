// 紅利系統重構 批次 7(§4.8 / §3.13):會員詳情頁「相關訂單」每一列的紅利標籤(預定 / 已入帳 / 折抵)。
// 抽成純函式的理由同 booking/bookingPointsLogic.ts:標籤該不該出現、出現什麼字,寫在 JSX 裡測不到。
// 只看這張訂單自己的快照欄位(不看商家目前的紅利開關)—— 歷史訂單當初派過 / 折過的紀錄,功能關閉後
// 仍是已經發生的事(§4.7 同一個原則)。
//
// #844 §4.8(批次 3):「已入帳」改看淨額,跟訂單詳情共用 describeEarnedPoints ——
//   get_member_related_bookings 的 earned_points 現在就是本單本會員的有效入帳、reversed_points 是收回數。

import { describeEarnedPoints } from "@/modules/booking/bookingPointsLogic";

import type { MemberRelatedBooking } from "./types";

export function describeRelatedBookingPointsTags(
  booking: Pick<
    MemberRelatedBooking,
    | "status"
    | "pointsPlanned"
    | "pointsPlannedOverridden"
    | "earnedPoints"
    | "reversedPoints"
    | "pointsRedeemed"
  >,
): string[] {
  const tags: string[] = [];
  if (booking.pointsPlanned > 0 || booking.pointsPlannedOverridden) {
    tags.push(
      `預定 ${booking.pointsPlanned} 點${booking.pointsPlannedOverridden ? "(人工設定)" : ""}`,
    );
  }
  const earnedText = describeEarnedPoints({
    status: booking.status,
    // 毛額 = 有效 + 收回;只用來分辨「從未入帳(null)」。
    earned: booking.earnedPoints === null ? null : booking.earnedPoints + booking.reversedPoints,
    reversed: booking.reversedPoints,
    effective: booking.earnedPoints,
  });
  if (earnedText !== null) tags.push(earnedText);
  if (booking.pointsRedeemed > 0) tags.push(`折抵 ${booking.pointsRedeemed} 點`);
  if (tags.length === 0) tags.push("未派點");
  return tags;
}
