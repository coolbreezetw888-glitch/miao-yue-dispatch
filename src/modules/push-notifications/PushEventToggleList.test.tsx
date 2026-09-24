// 模組 15 擴充 §7.4:四個事件開關的畫面測試。
// 對應 §4.2 第 4 點(商家總開關關閉時要灰掉 + 寫明原因)、§4.5(管理員/客服少一張卡片)、
// §4.4 第 3 點(小字誠實寫出量有多大)、§7.4 第 4 點(只有管理員看得到設定頁連結)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useMyPushEventSubscriptionsMock = vi.fn();
const useMerchantPushEventEnabledMapMock = vi.fn();
const setMyPushEventSubscriptionMock = vi.fn();

vi.mock("./api", () => ({
  useMyPushEventSubscriptions: (...args: unknown[]) => useMyPushEventSubscriptionsMock(...args),
  useMerchantPushEventEnabledMap: (...args: unknown[]) =>
    useMerchantPushEventEnabledMapMock(...args),
  setMyPushEventSubscription: (...args: unknown[]) => setMyPushEventSubscriptionMock(...args),
  pushEventSubscriptionsQueryKey: () => ["push-notifications-module", "my-event-subscriptions"],
}));

import { PushEventToggleList } from "./PushEventToggleList";

const ALL_ENABLED = {
  booking_created: true,
  booking_cancelled: true,
  booking_updated: true,
  booking_reminder_next_day: true,
};

function renderList(
  targetType: "admin" | "agent" | "staff",
  { isMerchantAdmin = false }: { isMerchantAdmin?: boolean } = {},
) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PushEventToggleList
          merchantId="merchant-1"
          targetType={targetType}
          targetId="target-1"
          isMerchantAdmin={isMerchantAdmin}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PushEventToggleList(§7.4)", () => {
  beforeEach(() => {
    useMyPushEventSubscriptionsMock.mockReset().mockReturnValue({ data: [], isLoading: false });
    useMerchantPushEventEnabledMapMock.mockReset().mockReturnValue({ data: ALL_ENABLED });
    setMyPushEventSubscriptionMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("§4.5:服務人員看到 4 個開關,管理員/客服只有 3 個(沒有「前一天提醒隔天預約」)", () => {
    renderList("staff");
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.getByText("前一天提醒隔天預約")).toBeInTheDocument();
    cleanup();

    renderList("admin", { isMerchantAdmin: true });
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByText("前一天提醒隔天預約")).not.toBeInTheDocument();
    cleanup();

    renderList("agent");
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByText("前一天提醒隔天預約")).not.toBeInTheDocument();
  });

  it("§4.4 第 3 點:管理員/客服的小字明寫「這間店每一筆新訂單都會通知你」", () => {
    renderList("agent");
    expect(screen.getByText("這間店每一筆新訂單都會通知你")).toBeInTheDocument();
    cleanup();

    renderList("staff");
    expect(screen.getByText("指派給你的訂單有新單時通知你")).toBeInTheDocument();
    expect(screen.queryByText("這間店每一筆新訂單都會通知你")).not.toBeInTheDocument();
  });

  it("§4.2 第 4 點(核心):商家總開關關閉的那一項要停用並寫明原因", () => {
    useMerchantPushEventEnabledMapMock.mockReturnValue({
      data: { ...ALL_ENABLED, booking_created: false },
    });
    renderList("staff");

    const row = screen.getByTestId("push-event-toggle-booking_created");
    expect(row.className).toContain("opacity-60");
    expect(row.querySelector("button[role='switch']")).toBeDisabled();
    expect(screen.getByText(/商家尚未開啟這個事件的推播通知/)).toBeInTheDocument();

    // 其他三項不受影響。
    const other = screen.getByTestId("push-event-toggle-booking_cancelled");
    expect(other.querySelector("button[role='switch']")).not.toBeDisabled();
  });

  it("§7.4 第 4 點:只有管理員看得到「前往推播通知設定」連結(客服/服務人員可能沒有權限進那一頁)", () => {
    useMerchantPushEventEnabledMapMock.mockReturnValue({
      data: { ...ALL_ENABLED, booking_created: false },
    });
    renderList("admin", { isMerchantAdmin: true });
    expect(screen.getByRole("link", { name: "前往推播通知設定" })).toHaveAttribute(
      "href",
      "/app/push-events",
    );
    cleanup();

    useMerchantPushEventEnabledMapMock.mockReturnValue({
      data: { ...ALL_ENABLED, booking_created: false },
    });
    renderList("staff");
    expect(screen.queryByRole("link", { name: "前往推播通知設定" })).not.toBeInTheDocument();
  });

  it("商家總開關狀態還查不到時,一律當成「還沒開」—— 寧可多解釋,也不要讓人以為打開了卻收不到", () => {
    useMerchantPushEventEnabledMapMock.mockReturnValue({ data: undefined });
    renderList("staff");
    expect(screen.getAllByText(/商家尚未開啟這個事件的推播通知/)).toHaveLength(4);
    for (const toggle of screen.getAllByRole("switch")) {
      expect(toggle).toBeDisabled();
    }
  });

  it("個人開關的勾選狀態來自 push_event_subscriptions(沒有那一列就是關的)", () => {
    useMyPushEventSubscriptionsMock.mockReturnValue({
      data: [
        { event_type: "booking_created", enabled: true },
        { event_type: "booking_cancelled", enabled: false },
      ],
      isLoading: false,
    });
    renderList("staff");

    const created = screen
      .getByTestId("push-event-toggle-booking_created")
      .querySelector("button[role='switch']");
    const cancelled = screen
      .getByTestId("push-event-toggle-booking_cancelled")
      .querySelector("button[role='switch']");
    const updated = screen
      .getByTestId("push-event-toggle-booking_updated")
      .querySelector("button[role='switch']");

    expect(created).toHaveAttribute("data-state", "checked");
    expect(cancelled).toHaveAttribute("data-state", "unchecked");
    expect(updated).toHaveAttribute("data-state", "unchecked");
  });
});
