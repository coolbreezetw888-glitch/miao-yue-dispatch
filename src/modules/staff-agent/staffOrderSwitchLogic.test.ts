// SPECS-INDEX #977 第 7 批(2026-10-07):「服務人員新增編輯訂單」與「服務人員是否顯示會員資料」連動(裁決 6)。
import { describe, expect, it } from "vitest";

import {
  decideOrderSwitchChange,
  ORDER_SWITCH_CONFIRM_COPY,
  orderSwitchInactiveWarning,
} from "./staffOrderSwitchLogic";

describe("decideOrderSwitchChange", () => {
  it("打開新增編輯訂單、顯示會員資料是關的 ⇒ 先問要不要一起開", () => {
    expect(
      decideOrderSwitchChange("can_create_edit_orders", true, {
        canCreateEditOrders: false,
        showMemberInfo: false,
      }),
    ).toEqual({ kind: "confirm-enable-member-info" });
  });
  it("打開新增編輯訂單、顯示會員資料本來就開 ⇒ 直接套用", () => {
    expect(
      decideOrderSwitchChange("can_create_edit_orders", true, {
        canCreateEditOrders: false,
        showMemberInfo: true,
      }),
    ).toEqual({ kind: "apply" });
  });
  it("新增編輯訂單開著、要關顯示會員資料 ⇒ 先問要不要一起關", () => {
    expect(
      decideOrderSwitchChange("show_member_info", false, {
        canCreateEditOrders: true,
        showMemberInfo: true,
      }),
    ).toEqual({ kind: "confirm-disable-orders" });
  });
  it("其他切換(關新增編輯訂單、開顯示會員資料、別的開關)⇒ 直接套用", () => {
    const cur = { canCreateEditOrders: true, showMemberInfo: false };
    expect(decideOrderSwitchChange("can_create_edit_orders", false, cur)).toEqual({
      kind: "apply",
    });
    expect(decideOrderSwitchChange("show_member_info", true, cur)).toEqual({ kind: "apply" });
    expect(decideOrderSwitchChange("unlimited_backend_edit", true, cur)).toEqual({ kind: "apply" });
  });
});

describe("舊資料提示與小卡窗文案", () => {
  it("新增編輯訂單開、顯示會員資料關 ⇒ 常駐提示;其他組合不提示", () => {
    expect(orderSwitchInactiveWarning({ canCreateEditOrders: true, showMemberInfo: false })).toBe(
      "目前沒有開啟「服務人員是否顯示會員資料」，這個功能不會生效。",
    );
    expect(
      orderSwitchInactiveWarning({ canCreateEditOrders: true, showMemberInfo: true }),
    ).toBeNull();
    expect(
      orderSwitchInactiveWarning({ canCreateEditOrders: false, showMemberInfo: false }),
    ).toBeNull();
  });
  it("小卡窗文案照規格 4-6 第 3 點", () => {
    expect(ORDER_SWITCH_CONFIRM_COPY["confirm-enable-member-info"]).toEqual({
      title: "要一起開啟「服務人員是否顯示會員資料」嗎？",
      description: "服務人員新增、編輯訂單時需要看到客戶電話與地址，所以會一起開啟顯示會員資料。",
      action: "一起開啟",
    });
    expect(ORDER_SWITCH_CONFIRM_COPY["confirm-disable-orders"]).toEqual({
      title: "要一起關閉「服務人員新增編輯訂單」嗎？",
      description: "沒有顯示會員資料，服務人員就不能新增、編輯訂單，所以會一起關閉。",
      action: "一起關閉",
    });
  });
});
