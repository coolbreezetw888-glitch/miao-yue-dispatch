// SPECS-INDEX #1025:「服務人員管理 > 編輯」裡哪些開關要依平台功能開關隱藏(純函式,從 StaffListPage 抽出)。

/** SPECS-INDEX #1025 ⚠️6:只對「客戶線上預約」有作用的兩個開關(另外兩個數字欄位是 STAFF_NUMBER_PERMISSION_FIELDS 整組)。 */
export const ONLINE_BOOKING_ONLY_STAFF_FIELDS: ReadonlySet<string> = new Set([
  "no_time_slot_limit",
  "auto_accept_booking",
]);

/**
 * SPECS-INDEX #1025 FG3-U02:「編輯」裡依平台功能開關要不要顯示這個開關。
 *   ・服務人員登入端關 ⇒「服務人員新增編輯訂單」「服務人員是否顯示會員資料」不顯示
 *   ・新增編輯訂單(細部功能)關 ⇒「服務人員新增編輯訂單」不顯示
 *   ・客戶線上預約關 ⇒ 只跟線上預約有關的兩個開關不顯示(⚠️6)
 * 值保留(T9):form 從資料庫灌進原值,藏起來就沒有地方能改,存檔照樣原值送回。
 * 「商家後台確認後直接接單」照常顯示(F9)。
 */
export function isStaffBooleanFieldVisible(
  fieldKey: string,
  features: { onlineBooking: boolean; staffPortal: boolean; staffOrderEditing: boolean },
): boolean {
  if (!features.onlineBooking && ONLINE_BOOKING_ONLY_STAFF_FIELDS.has(fieldKey)) return false;
  if (fieldKey === "show_member_info") return features.staffPortal;
  if (fieldKey === "can_create_edit_orders")
    return features.staffPortal && features.staffOrderEditing;
  return true;
}
