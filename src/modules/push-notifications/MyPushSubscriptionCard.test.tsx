// 模組 15 擴充 §7.2:MyPushSubscriptionCard 的角色解析測試。
// 重點:角色是 staff(或 null)時回傳 null —— 服務人員的卡片掛在 HomePage,由那裡明確傳
// targetType="staff";在 ManagePage 再渲染一張會變成同一個人看到兩張一樣的卡片。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useCurrentMerchantMock = vi.fn();
const useCurrentMerchantRoleMock = vi.fn();
const getVerifiedUserMock = vi.fn();
const maybeSingleMock = vi.fn();
const pushSubscriptionCardPropsSpy = vi.fn();

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => useCurrentMerchantMock(),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => useCurrentMerchantRoleMock(),
}));
vi.mock("@/lib/auth-guard", () => ({
  getVerifiedUser: () => getVerifiedUserMock(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => maybeSingleMock() }),
        }),
      }),
    }),
  },
}));
vi.mock("./PushSubscriptionCard", () => ({
  PushSubscriptionCard: (props: Record<string, unknown>) => {
    pushSubscriptionCardPropsSpy(props);
    return <div data-testid="push-subscription-card" />;
  },
}));

import { MyPushSubscriptionCard } from "./MyPushSubscriptionCard";

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MyPushSubscriptionCard />
    </QueryClientProvider>,
  );
}

describe("MyPushSubscriptionCard(§7.2)", () => {
  beforeEach(() => {
    useCurrentMerchantMock.mockReset().mockReturnValue({
      merchant: { id: "merchant-1", name: "涼風工匠" },
    });
    useCurrentMerchantRoleMock.mockReset().mockReturnValue({ data: "admin" });
    getVerifiedUserMock.mockReset().mockResolvedValue({ id: "user-1" });
    maybeSingleMock.mockReset().mockResolvedValue({ data: { id: "admin-row-1" }, error: null });
    pushSubscriptionCardPropsSpy.mockReset();
  });
  afterEach(() => cleanup());

  it("管理員:傳出 targetType='admin' 與自己那一列的 id", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByTestId("push-subscription-card")).toBeInTheDocument());
    expect(pushSubscriptionCardPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: "merchant-1",
        targetType: "admin",
        targetId: "admin-row-1",
        targetLabel: "商家管理員",
        merchantName: "涼風工匠",
      }),
    );
  });

  it("客服:傳出 targetType='agent'", async () => {
    useCurrentMerchantRoleMock.mockReturnValue({ data: "agent" });
    maybeSingleMock.mockResolvedValue({ data: { id: "agent-row-1" }, error: null });
    renderCard();
    await waitFor(() => expect(screen.getByTestId("push-subscription-card")).toBeInTheDocument());
    expect(pushSubscriptionCardPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "agent",
        targetId: "agent-row-1",
        targetLabel: "客服",
      }),
    );
  });

  it("角色是 staff 時回傳 null(服務人員的卡片掛在 HomePage,不在這裡重複渲染)", async () => {
    useCurrentMerchantRoleMock.mockReturnValue({ data: "staff" });
    renderCard();
    await waitFor(() => expect(getVerifiedUserMock).toHaveBeenCalled());
    expect(screen.queryByTestId("push-subscription-card")).not.toBeInTheDocument();
    expect(pushSubscriptionCardPropsSpy).not.toHaveBeenCalled();
  });

  it("角色還沒解析出來 / 跟這間店無關時回傳 null", async () => {
    useCurrentMerchantRoleMock.mockReturnValue({ data: null });
    renderCard();
    await waitFor(() => expect(getVerifiedUserMock).toHaveBeenCalled());
    expect(screen.queryByTestId("push-subscription-card")).not.toBeInTheDocument();
  });

  it("還沒選定商家時回傳 null", async () => {
    useCurrentMerchantMock.mockReturnValue({ merchant: null });
    renderCard();
    await waitFor(() => expect(getVerifiedUserMock).toHaveBeenCalled());
    expect(screen.queryByTestId("push-subscription-card")).not.toBeInTheDocument();
  });
});
