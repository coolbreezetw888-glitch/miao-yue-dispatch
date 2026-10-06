// SPECS-INDEX #977 第 7 批(2026-10-07):服務人員端「新增編輯訂單」要不要出現互動 / 哪些按鈕(純邏輯)。
import { describe, expect, it } from "vitest";

import { resolveStaffDetailActions, resolveStaffOrderAbility } from "./staffOrderLogic";

const ON = {
  can_create_edit_orders: true,
  show_member_info: true,
  compensation_type: "piece_rate",
};

describe("resolveStaffOrderAbility", () => {
  it("開關 + 顯示會員資料 + 行事曆檢視 ⇒ 可以新增編輯;按件計酬 + 排班自助 ⇒ 也能開關時段", () => {
    expect(
      resolveStaffOrderAbility({
        staffRow: ON,
        hasCalendarView: true,
        hasSelfManageAvailability: true,
      }),
    ).toEqual({ canEditOrders: true, canToggleSlots: true });
  });
  it("任何一個條件不成立 ⇒ 都不能(時間軸維持唯讀,裁決 1)", () => {
    for (const input of [
      { staffRow: { ...ON, can_create_edit_orders: false }, hasCalendarView: true },
      { staffRow: { ...ON, show_member_info: false }, hasCalendarView: true },
      { staffRow: ON, hasCalendarView: false },
      { staffRow: ON, hasCalendarView: undefined },
      { staffRow: null, hasCalendarView: true },
    ]) {
      expect(resolveStaffOrderAbility({ ...input, hasSelfManageAvailability: true })).toEqual({
        canEditOrders: false,
        canToggleSlots: false,
      });
    }
  });
  it("方案 B2:月薪制開了新增編輯訂單仍不能開關時段;沒有排班自助權限也不能", () => {
    expect(
      resolveStaffOrderAbility({
        staffRow: { ...ON, compensation_type: "monthly_salary" },
        hasCalendarView: true,
        hasSelfManageAvailability: true,
      }),
    ).toEqual({ canEditOrders: true, canToggleSlots: false });
    expect(
      resolveStaffOrderAbility({
        staffRow: ON,
        hasCalendarView: true,
        hasSelfManageAvailability: false,
      }),
    ).toEqual({ canEditOrders: true, canToggleSlots: false });
  });
});

describe("resolveStaffDetailActions(主要 / 協助 × 四種狀態 × 開關開關)", () => {
  const STATUSES = ["pending_confirmation", "accepted", "completed", "cancelled"] as const;
  const fmt = (a: ReturnType<typeof resolveStaffDetailActions>) =>
    [
      a.showCancel && "取消",
      a.showEdit && "編輯",
      a.showConfirm && "確認接單",
      a.showComplete && "標記完成",
      a.showCompletedNote && "完成單說明",
    ]
      .filter(Boolean)
      .join("/");

  it("開關生效 + 主要服務人員", () => {
    expect(
      STATUSES.map((status) =>
        fmt(resolveStaffDetailActions({ status, role_in_booking: "primary" }, true)),
      ),
    ).toEqual(["取消/編輯/確認接單", "取消/編輯/標記完成", "完成單說明", ""]);
  });
  it("開關生效 + 協助人員:都沒有新按鈕", () => {
    expect(
      STATUSES.map((status) =>
        fmt(resolveStaffDetailActions({ status, role_in_booking: "assistant" }, true)),
      ),
    ).toEqual(["", "", "", ""]);
  });
  it("開關沒生效:維持第 4 批現況(主要 + 待確認才有確認接單)", () => {
    expect(
      STATUSES.map((status) =>
        fmt(resolveStaffDetailActions({ status, role_in_booking: "primary" }, false)),
      ),
    ).toEqual(["確認接單", "", "", ""]);
    expect(
      STATUSES.map((status) =>
        fmt(resolveStaffDetailActions({ status, role_in_booking: "assistant" }, false)),
      ),
    ).toEqual(["", "", "", ""]);
  });
});
