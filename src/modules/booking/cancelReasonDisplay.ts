// 客戶端第 4 批(C4-D07,主腦 2026-10-09 補派):後台訂單詳細(訂單管理 / 行事曆共用的 BookingDetailDialog)
// 對「已取消」的單顯示一行「取消原因：〇〇」。客人在會員中心自己取消的單,原因是「客人線上取消」。
//
// 只在 status = cancelled 而且 cancelled_reason 有內容時顯示;原因是店家 / 客人輸入的文字 ⇒ 純文字顯示
// (React 文字節點,不用 dangerouslySetInnerHTML),長文字換行由畫面處理。

export function cancelReasonText(booking: {
  status: string;
  cancelled_reason: string | null | undefined;
}): string | null {
  if (booking.status !== "cancelled") return null;
  const reason = (booking.cancelled_reason ?? "").trim();
  return reason === "" ? null : `取消原因：${reason}`;
}
