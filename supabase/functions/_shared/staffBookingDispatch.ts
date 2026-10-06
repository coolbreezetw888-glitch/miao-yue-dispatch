// SPECS-INDEX #977 第 7 批(2026-10-07):「服務人員新增編輯訂單」開了的服務人員,自己建單 / 改單 / 取消 / 完成 / 拖拉之後,
// 前端用**他自己的身分**呼叫 line-notify-dispatch / push-notify-dispatch。那兩支原本只認管理員 / 客服
// (can_dispatch_line_notification / can_manage_bookings),服務人員一定是 403。
//
// 這裡是「原本的檢查不通過之後」的第二道:只有 body 有帶訂單 id 時,才用呼叫者身分問
// public.can_staff_dispatch_booking_notification(p_merchant_id, p_booking_id, p_event_type)。
// 資料庫那支自己檢查:呼叫者是這張單的主要服務人員本人、可以自己下單、服務人員屬於這間商家、事件符合訂單現況。
//
// 回傳:true = 放行;false = 403;"error" = RPC 本身出錯(呼叫端回 500,fail closed,不當作通過)。
// 原本就放行的人不會走到這裡(呼叫端只在 !allowed 時才呼叫),行為不變。

export interface StaffDispatchRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function checkStaffBookingDispatch(
  callerClient: StaffDispatchRpcClient,
  merchantId: string,
  bookingId: string | null | undefined,
  eventType: string,
): Promise<boolean | "error"> {
  if (!bookingId) return false;
  const { data, error } = await callerClient.rpc("can_staff_dispatch_booking_notification", {
    p_merchant_id: merchantId,
    p_booking_id: bookingId,
    p_event_type: eventType,
  });
  if (error) {
    console.error("[staff-booking-dispatch] can_staff_dispatch_booking_notification 呼叫失敗", error);
    return "error";
  }
  return data === true;
}
