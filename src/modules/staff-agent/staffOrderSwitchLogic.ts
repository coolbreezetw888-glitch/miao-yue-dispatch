// SPECS-INDEX #977 第 7 批(2026-10-07):編輯服務人員畫面「服務人員新增編輯訂單」與「服務人員是否顯示會員資料」
// 兩個開關的連動(裁決 6)。純函式,畫面在 StaffListPage.tsx。
//   ・打開「新增編輯訂單」而「顯示會員資料」是關的 ⇒ 先跳小卡窗說明會一起打開
//   ・「新增編輯訂單」開著時要關「顯示會員資料」⇒ 先跳小卡窗說明「新增編輯訂單」也會一起關掉
//   ・只改表單狀態,按「儲存」才寫入(跟其他開關一致)
// 後端保證不靠這裡:private.staff_order_self_ok 要求兩個都開(沒開「顯示會員資料」一律不能用建單 / 編輯 RPC)。

export type OrderSwitchKey = "can_create_edit_orders" | "show_member_info";

export type OrderSwitchDecision =
  /** 直接套用這次切換。 */
  | { kind: "apply" }
  /** 要先問:一起開啟「顯示會員資料」。 */
  | { kind: "confirm-enable-member-info" }
  /** 要先問:一起關閉「新增編輯訂單」。 */
  | { kind: "confirm-disable-orders" };

export function decideOrderSwitchChange(
  key: string,
  nextValue: boolean,
  current: { canCreateEditOrders: boolean; showMemberInfo: boolean },
): OrderSwitchDecision {
  if (key === "can_create_edit_orders" && nextValue && !current.showMemberInfo) {
    return { kind: "confirm-enable-member-info" };
  }
  if (key === "show_member_info" && !nextValue && current.canCreateEditOrders) {
    return { kind: "confirm-disable-orders" };
  }
  return { kind: "apply" };
}

/** 舊資料(新增編輯訂單開、顯示會員資料關):在「新增編輯訂單」下方常駐黃色 `!`,不自動改資料。 */
export function orderSwitchInactiveWarning(current: {
  canCreateEditOrders: boolean;
  showMemberInfo: boolean;
}): string | null {
  return current.canCreateEditOrders && !current.showMemberInfo
    ? "目前沒有開啟「服務人員是否顯示會員資料」，這個功能不會生效。"
    : null;
}

export const ORDER_SWITCH_CONFIRM_COPY = {
  "confirm-enable-member-info": {
    title: "要一起開啟「服務人員是否顯示會員資料」嗎？",
    description: "服務人員新增、編輯訂單時需要看到客戶電話與地址，所以會一起開啟顯示會員資料。",
    action: "一起開啟",
  },
  "confirm-disable-orders": {
    title: "要一起關閉「服務人員新增編輯訂單」嗎？",
    description: "沒有顯示會員資料，服務人員就不能新增、編輯訂單，所以會一起關閉。",
    action: "一起關閉",
  },
} as const;
