// SPECS-INDEX #778:推播發送記錄頁的元件測試 —— 在真的渲染出來的 DOM 上驗「白話說明有顯示出來」,
// 不只驗純函式(純函式對了、頁面沒接上,就是 #778 原本的問題)。
//
// 這裡 mock 掉三支 hook(記錄、名冊、商家 context)與路由守衛,只測這一頁自己的渲染邏輯;
// 守衛本身在 RequirePushNotificationAccess.tsx,跟 LINE 那支一樣不在這裡重測。

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recipientKey, type RecipientDirectory } from "./pushLogView";
import type { PushNotificationLogRow } from "./types";

const usePushNotificationLogMock = vi.fn();
const usePushLogRecipientDirectoryMock = vi.fn();

vi.mock("./api", () => ({
  usePushNotificationLog: (...args: unknown[]) => usePushNotificationLogMock(...args),
  usePushLogRecipientDirectory: (...args: unknown[]) => usePushLogRecipientDirectoryMock(...args),
}));
vi.mock("./RequirePushNotificationAccess", () => ({
  RequirePushNotificationAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試店" } }),
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import PushLogsPage from "./PushLogsPage";

function makeRow(overrides: Partial<PushNotificationLogRow> = {}): PushNotificationLogRow {
  return {
    id: "log-1",
    merchant_id: "m1",
    event_type: "booking_created",
    booking_id: "b1",
    target_type: "staff",
    target_id: "staff-1",
    status: "sent",
    skip_reason: null,
    device_count: 1,
    success_count: 1,
    error_detail: null,
    rendered_title: "新訂單通知",
    rendered_body: "10/01 10:00 王小明 剪髮",
    attempted_at: "2026-09-27T16:27:00.000Z",
    ack_subscription_id: null,
    ack_token: null,
    acked_at: null,
    ...overrides,
  };
}

const directory: RecipientDirectory = new Map([
  [recipientKey("agent", "agent-1"), { name: "阿金", userId: "user-gold" }],
  [recipientKey("staff", "staff-1"), { name: "阿金", userId: "user-gold" }],
  [recipientKey("admin", "admin-1"), { name: "老闆", userId: "user-boss" }],
]);

function setLogs(rows: PushNotificationLogRow[] | undefined, isLoading = false) {
  usePushNotificationLogMock.mockReturnValue({ data: rows, isLoading });
}

describe("PushLogsPage(#778)", () => {
  beforeEach(() => {
    usePushNotificationLogMock.mockReset();
    usePushLogRecipientDirectoryMock.mockReset().mockReturnValue({ data: directory });
  });
  afterEach(() => cleanup());

  it("載入中 / 空狀態", () => {
    // ui-v1-full 第 3 批:載入中改成灰色骨架方塊(skill 二之八,不用「載入中⋯」四個字),
    // 空狀態改成 EmptyState(圖示 + 還沒有什麼 + 有了之後能幹嘛 + 一顆下一步按鈕)。
    // 要守的事情沒變:載入中不可以先顯示空狀態、空的時候要講清楚現在是空的。
    setLogs(undefined, true);
    render(<PushLogsPage />);
    expect(screen.queryByText("載入中⋯")).not.toBeInTheDocument();
    expect(screen.queryByText("還沒有任何發送記錄")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("push-log-group")).toHaveLength(0);
    cleanup();

    setLogs([]);
    render(<PushLogsPage />);
    expect(screen.getByText("還沒有任何發送記錄")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去看推播通知設定" })).toBeInTheDocument();
  });

  it("核心:沒發成功的那一列,直接看得到白話原因與「可以怎麼做」,畫面上沒有英文代碼", () => {
    setLogs([
      makeRow({
        id: "a",
        target_type: "admin",
        target_id: "admin-1",
        status: "skipped",
        skip_reason: "no_subscription",
        device_count: 0,
        success_count: 0,
      }),
    ]);
    render(<PushLogsPage />);

    // 前提斷言:那一列真的渲染出來了(避免空清單假通過)
    const recipient = screen.getByTestId("push-log-recipient");
    expect(within(recipient).getByText("商家管理員 老闆")).toBeInTheDocument();
    // 行為斷言:白話說明**不用點「查看詳情」**就在畫面上
    expect(within(recipient).getByTestId("push-log-recipient-detail")).toHaveTextContent(
      "這個人還沒在任何裝置上開通推播",
    );
    expect(within(recipient).getByTestId("push-log-recipient-hint")).toHaveTextContent("開啟通知");
    // 負向:原始代碼不出現
    expect(recipient.textContent).not.toContain("no_subscription");
    // 整組徽章
    expect(screen.getByTestId("push-log-group")).toHaveAttribute("data-summary", "skipped");
    expect(screen.getByText("沒有發送")).toBeInTheDocument();
  });

  it("成功的列:寫出送到幾台裝置、沒有「可以怎麼做」(正向對照:同一個渲染路徑分得出成功與沒成功)", () => {
    setLogs([
      makeRow({
        id: "a",
        target_type: "admin",
        target_id: "admin-1",
        device_count: 2,
        success_count: 2,
      }),
    ]);
    render(<PushLogsPage />);
    const recipient = screen.getByTestId("push-log-recipient");
    expect(within(recipient).getByTestId("push-log-recipient-detail")).toHaveTextContent(
      "已送到 2 台裝置",
    );
    expect(within(recipient).queryByTestId("push-log-recipient-hint")).toBeNull();
    expect(screen.getByText("全部送達")).toBeInTheDocument();
  });

  it("同一個人兩個身份:同一筆訂單只有一組、底下兩列標出角色,並明講「手機只會收到一次」", () => {
    setLogs([
      makeRow({
        id: "a",
        target_type: "staff",
        target_id: "staff-1",
        attempted_at: "2026-09-27T16:27:05.000Z",
      }),
      makeRow({
        id: "b",
        target_type: "agent",
        target_id: "agent-1",
        status: "skipped",
        skip_reason: "no_subscription",
        device_count: 0,
        success_count: 0,
        attempted_at: "2026-09-27T16:27:04.000Z",
      }),
    ]);
    render(<PushLogsPage />);

    expect(screen.getAllByTestId("push-log-group")).toHaveLength(1);
    const recipients = screen.getAllByTestId("push-log-recipient");
    expect(recipients).toHaveLength(2);
    expect(recipients[0]).toHaveTextContent("客服 阿金");
    expect(recipients[1]).toHaveTextContent("服務人員 阿金");
    expect(screen.getByTestId("push-log-same-user-note")).toHaveTextContent(
      "阿金同時是客服和服務人員，所以這裡有 2 列;他的手機只會收到一次。",
    );
    expect(screen.getByText("部分送達")).toBeInTheDocument();
  });

  it("名冊還沒載入(或沒權限)時頁面照樣能用:只顯示角色,不顯示同一個人的註記", () => {
    usePushLogRecipientDirectoryMock.mockReturnValue({ data: undefined });
    setLogs([
      makeRow({ id: "a", target_type: "staff", target_id: "staff-1" }),
      makeRow({ id: "b", target_type: "agent", target_id: "agent-1" }),
    ]);
    render(<PushLogsPage />);
    const recipients = screen.getAllByTestId("push-log-recipient");
    expect(recipients[0]).toHaveTextContent("客服 —");
    expect(recipients[1]).toHaveTextContent("服務人員 —");
    expect(screen.queryByTestId("push-log-same-user-note")).toBeNull();
  });

  it("通知內容收在「查看通知內容」裡(白話原因不在裡面,不用點就看得到)", () => {
    setLogs([makeRow({ id: "a", target_type: "admin", target_id: "admin-1" })]);
    render(<PushLogsPage />);
    expect(screen.queryByText(/內容：10\/01 10:00 王小明 剪髮/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看通知內容" }));
    expect(screen.getByText(/內容：10\/01 10:00 王小明 剪髮/)).toBeInTheDocument();
  });

  it("hook 一開始就用「全部事件 / 全部結果 / 第 0 頁 / 每頁 20 列」呼叫", () => {
    setLogs([]);
    render(<PushLogsPage />);
    expect(usePushNotificationLogMock).toHaveBeenCalledWith(
      "m1",
      { eventType: null, problemsOnly: false },
      0,
      20,
    );
  });
});
