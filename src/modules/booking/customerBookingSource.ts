// 客戶端第 3 批(C3-E01):客人自己線上預約的訂單,在後台 / 服務人員端的標示。純函式,vitest 逐條驗。
//
//   ・source = 'customer' 而且 is_guest_booking = false ⇒「線上預約」(屬性標籤,灰底安靜)
//   ・source = 'customer' 而且 is_guest_booking = true  ⇒「訪客預約」(待辦標籤,黃底 + !)+ 詳細頁一行提示
//   ・其他來源(manual / smart / import)⇒ 不顯示
//
// 「建單的人」:客人送出的單 created_by_user_id 是客人帳號(訪客是 null),查不到客服名字 ⇒ 不能顯示成
// 「(已移除的人員)」,改顯示「客人(線上預約)」/「訪客(線上預約)」。

export type CustomerBookingSourceKind = "online" | "guest";

export interface CustomerBookingSourceInput {
  source?: string | null | undefined;
  is_guest_booking?: boolean | null | undefined;
}

export function customerBookingSourceKind(
  booking: CustomerBookingSourceInput,
): CustomerBookingSourceKind | null {
  if (booking.source !== "customer") return null;
  return booking.is_guest_booking === true ? "guest" : "online";
}

export const CUSTOMER_BOOKING_SOURCE_LABELS: Record<CustomerBookingSourceKind, string> = {
  online: "線上預約",
  guest: "訪客預約",
};

/** 後台詳細頁(看得到電話):第七章原文。 */
export const GUEST_BOOKING_BACKEND_HINT = "客人沒有登入，電話未經驗證，請自行與客戶電話確認。";
/** 服務人員端關了「顯示會員資料」(看不到電話)時的版本。 */
export const GUEST_BOOKING_STAFF_HIDDEN_PHONE_HINT = "客人沒有登入，請與店家確認客人聯絡方式。";

/** 服務人員端的提示:看得到電話用後台同一句,看不到電話改「請與店家確認」。 */
export function guestBookingStaffHint(canSeePhone: boolean): string {
  return canSeePhone ? GUEST_BOOKING_BACKEND_HINT : GUEST_BOOKING_STAFF_HIDDEN_PHONE_HINT;
}

/** 客人送出的單:「建單人」顯示什麼(不是客人送出的 ⇒ null,照原本查客服名字)。 */
export function customerBookingCreatorLabel(booking: CustomerBookingSourceInput): string | null {
  const kind = customerBookingSourceKind(booking);
  if (kind === "guest") return "訪客（線上預約）";
  if (kind === "online") return "客人（線上預約）";
  return null;
}
