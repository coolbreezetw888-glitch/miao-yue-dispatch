// #844 批次 1(§4.6 / §十 Vitest「轉換文字對照」):操作記錄每一列的文字 + 原因那一行。
//
// 三層驗證:
//   1. 純函式 statusChangeLogText / statusChangeLogNoteText 的對照表。
//   2. 真的 render StatusChangeLogsView:有原因的列多一行「原因:…」,沒有原因的列不多出空行。
//   3. getBookingStatusChangeLogs 把 RPC 回來的 note 對應到 note(空白 → null)。
//
// 【故障注入(2026-10-01 實際跑過並還原)】
//   ① 讓 statusChangeLogText 裡 completed → accepted 那個 if 永遠不成立 → 「還原完成」對照 +
//      畫面那條,共 2 條轉紅。
//   ② api.ts 把 note 對應寫死成 `note: null` → 「RPC 對應」1 條轉紅。
//   ③ StatusChangeLogsView 不 render noteText → 畫面那條 1 條轉紅。

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock, functions: { invoke: vi.fn() } },
}));
vi.mock("@/modules/push-notifications/api", () => ({ dispatchPushNotification: vi.fn() }));
vi.mock("@/modules/line-notifications/api", () => ({ dispatchLineNotification: vi.fn() }));

import { getBookingStatusChangeLogs } from "./api";
import { statusChangeLogNoteText, statusChangeLogText } from "./statusChangeLogDisplay";
import { StatusChangeLogsView } from "./StatusChangeLogsView";
import type { BookingStatusChangeLog } from "./types";

function log(partial: Partial<BookingStatusChangeLog>): BookingStatusChangeLog {
  return {
    id: "log-1",
    fromStatus: "accepted",
    toStatus: "completed",
    actorNameSnapshot: "管理員甲",
    actorRoleSnapshot: "merchant_admin",
    createdAt: "2026-10-01T02:00:00+00:00",
    note: null,
    ...partial,
  };
}

describe("statusChangeLogText:轉換文字對照", () => {
  it("建立訂單", () => {
    expect(statusChangeLogText(log({ fromStatus: null, toStatus: "pending_confirmation" }))).toBe(
      "建立訂單(待確認)",
    );
  });

  it("既有轉換維持原本「從 A 改成 B」的寫法", () => {
    expect(statusChangeLogText(log({ fromStatus: "accepted", toStatus: "completed" }))).toBe(
      "把訂單狀態從「已確認」改成「已完成」",
    );
    expect(
      statusChangeLogText(log({ fromStatus: "pending_confirmation", toStatus: "cancelled" })),
    ).toBe("把訂單狀態從「待確認」改成「已取消」");
  });

  it("#844:已完成 → 已確認 顯示「還原完成」", () => {
    const text = statusChangeLogText(log({ fromStatus: "completed", toStatus: "accepted" }));
    expect(text.startsWith("還原完成")).toBe(true);
    expect(text).toBe("還原完成(訂單從「已完成」退回「已確認」)");
  });

  it("#844:已完成 → 已取消 顯示「取消已完成訂單」", () => {
    const text = statusChangeLogText(log({ fromStatus: "completed", toStatus: "cancelled" }));
    expect(text.startsWith("取消已完成訂單")).toBe(true);
    expect(text).toBe("取消已完成訂單(訂單從「已完成」改成「已取消」)");
  });
});

describe("statusChangeLogNoteText:原因那一行", () => {
  it("有原因 → 「原因:…」(去頭尾空白)", () => {
    expect(statusChangeLogNoteText(log({ note: "  誤按完成  " }))).toBe("原因：誤按完成");
  });

  it("沒有原因 / 純空白 → null(畫面不顯示那一行)", () => {
    expect(statusChangeLogNoteText(log({ note: null }))).toBeNull();
    expect(statusChangeLogNoteText(log({ note: "   " }))).toBeNull();
  });
});

describe("StatusChangeLogsView:畫面", () => {
  afterEach(cleanup);

  it("還原/取消已完成的列顯示原因;其他列不多出原因行", () => {
    render(
      <StatusChangeLogsView
        loading={false}
        onBack={() => {}}
        logs={[
          log({
            id: "a",
            fromStatus: "completed",
            toStatus: "cancelled",
            note: "客戶退單,款項系統外處理",
          }),
          log({ id: "b", fromStatus: "completed", toStatus: "accepted", note: "誤按完成" }),
          log({ id: "c", fromStatus: "accepted", toStatus: "completed", note: null }),
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const [cancelRow, revertRow, completeRow] = items as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(cancelRow).getByText(/取消已完成訂單/)).toBeInTheDocument();
    expect(within(cancelRow).getByText("原因：客戶退單,款項系統外處理")).toBeInTheDocument();

    expect(within(revertRow).getByText(/還原完成/)).toBeInTheDocument();
    expect(within(revertRow).getByText("原因：誤按完成")).toBeInTheDocument();

    expect(within(completeRow).queryByText(/原因：/)).toBeNull();
  });
});

describe("getBookingStatusChangeLogs:RPC 的 note 對應", () => {
  beforeEach(() => rpcMock.mockReset());

  it("note 原樣帶出;空字串 / 純空白 → null", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          id: "1",
          from_status: "completed",
          to_status: "accepted",
          actor_name_snapshot: "管理員甲",
          actor_role_snapshot: "merchant_admin",
          created_at: "2026-10-01T02:00:00+00:00",
          note: "誤按完成",
        },
        {
          id: "2",
          from_status: "accepted",
          to_status: "completed",
          actor_name_snapshot: "管理員甲",
          actor_role_snapshot: "merchant_admin",
          created_at: "2026-10-01T01:00:00+00:00",
          note: null,
        },
        {
          id: "3",
          from_status: "completed",
          to_status: "cancelled",
          actor_name_snapshot: "管理員甲",
          actor_role_snapshot: "merchant_admin",
          created_at: "2026-10-01T00:00:00+00:00",
          note: "   ",
        },
      ],
      error: null,
    });

    const rows = await getBookingStatusChangeLogs("booking-1");
    expect(rpcMock).toHaveBeenCalledWith("get_booking_status_change_logs", {
      p_booking_id: "booking-1",
    });
    expect(rows.map((r) => r.note)).toEqual(["誤按完成", null, null]);
  });
});
