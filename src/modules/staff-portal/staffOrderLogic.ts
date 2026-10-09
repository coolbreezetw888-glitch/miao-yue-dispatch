// SPECS-INDEX #977 第 7 批(2026-10-07):服務人員端「新增編輯訂單」的純邏輯(畫面要不要出現互動 / 哪些按鈕)。
// 🔴 這裡只決定「要不要顯示」—— 真正的安全邊界在後端(staff_ 包裝 RPC 每一支都重驗本人、商家、兩個開關、
//    行事曆檢視、是不是主要服務人員)。前端藏按鈕只是體驗(裁決 10)。

import { canStaffConfirmBooking } from "./staffConfirmLogic";

export interface StaffOrderAbilityInput {
  staffRow:
    | {
        can_create_edit_orders: boolean;
        show_member_info: boolean;
        compensation_type: string;
      }
    | null
    | undefined;
  /** 「行事曆檢視」權限(useMyStaffPermission('staff_calendar_view').data)。 */
  hasCalendarView: boolean | null | undefined;
  /** 「可預約時段/休假自助調整」權限(useMyStaffPermission('staff_availability_self_manage').data)。 */
  hasSelfManageAvailability: boolean | null | undefined;
  /**
   * SPECS-INDEX #1025 FG3-F01:平台功能「服務人員新增編輯訂單」(useMerchantFeatures().hasFeature('staff_order_editing'))。
   * 後端 staff_order_self_ok 同一個條件;讀取中(undefined)當作不能用。
   */
  hasOrderEditingFeature: boolean | null | undefined;
}

export interface StaffOrderAbility {
  /** 規格 4-1:新增編輯訂單有效 = 開關開 + 顯示會員資料開 + 行事曆檢視 + 平台功能開(#1025;後端 staff_order_self_ok 同一組條件)。 */
  canEditOrders: boolean;
  /**
   * 方案 B2(使用者 2026-10-07 裁決):選單的「開啟 / 關閉時段」只給 canEditOrders + 按件計酬 + 排班自助權限的人
   * (後端 private.staff_slot_toggle_ok 同一組條件)。月薪制開了新增編輯訂單也只有「新增預約」。
   */
  canToggleSlots: boolean;
}

export function resolveStaffOrderAbility(input: StaffOrderAbilityInput): StaffOrderAbility {
  const row = input.staffRow;
  const canEditOrders =
    Boolean(row) &&
    row!.can_create_edit_orders === true &&
    row!.show_member_info === true &&
    input.hasCalendarView === true &&
    input.hasOrderEditingFeature === true;
  const canToggleSlots =
    canEditOrders &&
    row!.compensation_type === "piece_rate" &&
    input.hasSelfManageAvailability === true;
  return { canEditOrders, canToggleSlots };
}

export interface StaffDetailActions {
  showCancel: boolean;
  showEdit: boolean;
  showConfirm: boolean;
  showComplete: boolean;
  /** 方案 A1:自己是主要服務人員的已完成訂單 ⇒ 跟客服同一句常駐 `!`(不能取消 / 還原)。 */
  showCompletedNote: boolean;
}

/**
 * 預約詳情底部按鈕(規格 4-4):
 *   ・開關有效 + 自己是主要:待確認 ⇒ 取消預約 / 編輯 / 確認接單;已確認 ⇒ 取消預約 / 編輯 / 標記完成;
 *     已完成 ⇒ 常駐 `!`(A1);已取消 ⇒ 都沒有
 *   ・開關沒開或是協助人員:維持第 4 批現況(主要 + 待確認才有「確認接單」)
 */
export function resolveStaffDetailActions(
  booking: { status: string; role_in_booking: "primary" | "assistant" },
  canEditOrders: boolean,
): StaffDetailActions {
  const isPrimary = booking.role_in_booking === "primary";
  const editable = canEditOrders && isPrimary;
  const active = booking.status === "pending_confirmation" || booking.status === "accepted";
  return {
    showCancel: editable && active,
    showEdit: editable && active,
    showConfirm: canStaffConfirmBooking(booking),
    showComplete: editable && booking.status === "accepted",
    showCompletedNote: editable && booking.status === "completed",
  };
}
