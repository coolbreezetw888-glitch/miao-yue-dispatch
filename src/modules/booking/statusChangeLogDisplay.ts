// 模組 6 §9.1(SPECS-INDEX #597)+ #844 §4.6:操作記錄每一列要顯示的文字。
// 從 BookingDetailDialog.tsx 抽出來成純函式,方便 Vitest 直接驗對照表。
import { BOOKING_STATUS_LABELS, type BookingStatusChangeLog } from "./types";

/** 「操作者 + 這句話」的後半句。 */
export function statusChangeLogText(log: BookingStatusChangeLog): string {
  if (log.fromStatus === null) {
    return `建立訂單(${BOOKING_STATUS_LABELS[log.toStatus]})`;
  }
  // #844 §4.6:已完成之後的兩條新轉換,用動作名稱講清楚,不只是「從 A 改成 B」——
  // 一般人看到「從已完成改成已確認」會以為是系統出錯,寫「還原完成」才知道是有人刻意做的。
  if (log.fromStatus === "completed" && log.toStatus === "accepted") {
    return `還原完成(訂單從「${BOOKING_STATUS_LABELS.completed}」退回「${BOOKING_STATUS_LABELS.accepted}」)`;
  }
  if (log.fromStatus === "completed" && log.toStatus === "cancelled") {
    return `取消已完成訂單(訂單從「${BOOKING_STATUS_LABELS.completed}」改成「${BOOKING_STATUS_LABELS.cancelled}」)`;
  }
  return `把訂單狀態從「${BOOKING_STATUS_LABELS[log.fromStatus]}」改成「${BOOKING_STATUS_LABELS[log.toStatus]}」`;
}

/** #844 §4.6:有原因時回「原因:…」,沒有原因回 null(畫面就不顯示那一行)。 */
export function statusChangeLogNoteText(log: BookingStatusChangeLog): string | null {
  const note = log.note?.trim();
  return note ? `原因：${note}` : null;
}
