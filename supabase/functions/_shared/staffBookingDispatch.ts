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
    console.error(
      "[staff-booking-dispatch] can_staff_dispatch_booking_notification 呼叫失敗",
      error,
    );
    return "error";
  }
  return data === true;
}

/**
 * #977 第 7 批(資安):服務人員路徑放行時,通知內容不採信呼叫端自由填的欄位。
 *   ・previousStaffId:一律 null(服務人員不能換主要服務人員,staff_ 包裝 RPC 也不允許)
 *   ・changeSummary:一律伺服器端固定文字,不用 body.change_summary
 * 管理員 / 客服路徑(viaStaffPath = false):照舊採用 body 的值(空字串視同沒帶)。
 * LINE(line-notify-dispatch)沒有任何自由文字欄位(內容全由伺服器依訂單組裝),不需要這一段。
 */
//
// #986 第 9 批:這句只會送到商家內部(管理員 / 客服 / 服務人員)的手機推播與鈴鐺,改成內部口吻,
// 免得讀起來像是對客人說的。
export const STAFF_PATH_CHANGE_SUMMARY = "服務人員已修改預約內容，請至系統查看";

/**
 * #986 第 9 批(使用者裁決):服務人員改單 / 拖拉**不通知客戶**。
 * line-notify-dispatch 走服務人員路徑時,只放行這幾個 LINE 事件(建單、取消、完成照舊可能發給客戶);
 * 其他事件(包含以後若有人替 LINE 加「改單」事件)一律在伺服器端擋下,不靠前端。
 * 管理員 / 客服路徑不受影響。
 */
export const STAFF_PATH_LINE_EVENTS: readonly string[] = [
  "booking_created",
  "booking_cancelled",
  "booking_completed",
];

export const STAFF_PATH_LINE_EVENT_BLOCKED_MESSAGE = "服務人員修改預約不會發送 LINE 通知";

export function isStaffPathLineEventAllowed(eventType: string): boolean {
  return STAFF_PATH_LINE_EVENTS.includes(eventType);
}

export function resolveStaffSafeDispatchFields(
  viaStaffPath: boolean,
  body: { change_summary?: string | undefined; previous_staff_id?: string | undefined },
): { changeSummary: string | undefined; previousStaffId: string | null } {
  if (viaStaffPath) {
    return { changeSummary: STAFF_PATH_CHANGE_SUMMARY, previousStaffId: null };
  }
  const previousStaffId = body.previous_staff_id?.trim();
  return {
    changeSummary: body.change_summary,
    previousStaffId: previousStaffId ? previousStaffId : null,
  };
}
