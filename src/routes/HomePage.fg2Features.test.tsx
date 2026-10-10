// SPECS-INDEX #1025 功能開關 第 2 批 FG2-U01:服務人員端 /app 的「我的 LINE 綁定」「手機推播」卡 × 平台功能開關。
//
//   1. 全開 ⇒ 兩張卡都看得到(照舊)
//   2. LINE 通知關 ⇒ LINE 綁定卡不顯示;推播卡照常
//   3. 手機推播關 ⇒ 推播卡不顯示;LINE 綁定卡照常
//   4. 讀取中(還不知道)⇒ 兩張都先不顯示(不閃一下)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  features: {} as Record<string, boolean | undefined>,
}));

vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    lineNotifications: "line_notifications",
    lineMarketing: "line_marketing",
    pushNotifications: "push_notifications",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => s.features[key],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1", name: "測試店" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/api", () => ({
  clearStaffPendingLoginEmail: vi.fn(),
}));
vi.mock("@/modules/staff-portal/context", () => ({
  useActiveMyStaffRecord: () => ({
    data: {
      id: "staff-1",
      name: "阿明",
      nickname: null,
      phone: "0912000000",
      intro: null,
      avatar_url: null,
      pending_admin_login_email: null,
    },
  }),
  useMyStaffPermission: () => ({ data: false }),
}));
vi.mock("@/modules/staff-portal/EditMyStaffProfileDialog", () => ({
  EditMyStaffProfileDialog: () => null,
}));
vi.mock("@/modules/staff-portal/MyStaffLineBindingCard", () => ({
  MyStaffLineBindingCard: () => <div data-testid="staff-line-binding-card" />,
}));
vi.mock("@/modules/push-notifications/PushSubscriptionCard", () => ({
  PushSubscriptionCard: () => <div data-testid="staff-push-card" />,
}));
vi.mock("./appLayoutContext", () => ({
  useAppLayoutContext: () => ({
    email: "staff@test.local",
    newEmail: null,
    isStaffView: true,
    isViewResolved: true,
  }),
}));
vi.mock("./ProfileCardShared", () => ({
  LoginEmailSection: () => null,
  PendingAdminLoginEmailSuggestionCard: () => null,
}));

const { default: HomePage } = await import("./HomePage");

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  s.features = {};
});

describe("服務人員端個人資料頁 × LINE / 推播功能開關(#1025 FG2-U01)", () => {
  it("全開 ⇒ LINE 綁定卡與推播卡都看得到", () => {
    s.features = { line_notifications: true, push_notifications: true };
    render(<HomePage />, { wrapper: Wrapper });
    expect(screen.getByText("阿明")).toBeInTheDocument();
    expect(screen.getByTestId("staff-line-binding-card")).toBeInTheDocument();
    expect(screen.getByTestId("staff-push-card")).toBeInTheDocument();
  });

  it("LINE 通知關 ⇒ LINE 綁定卡不顯示,推播卡照常", () => {
    s.features = { line_notifications: false, push_notifications: true };
    render(<HomePage />, { wrapper: Wrapper });
    expect(screen.queryByTestId("staff-line-binding-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("staff-push-card")).toBeInTheDocument();
  });

  it("手機推播關 ⇒ 推播卡不顯示,LINE 綁定卡照常", () => {
    s.features = { line_notifications: true, push_notifications: false };
    render(<HomePage />, { wrapper: Wrapper });
    expect(screen.queryByTestId("staff-push-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("staff-line-binding-card")).toBeInTheDocument();
  });

  it("讀取中(還不知道)⇒ 兩張都先不顯示,個人資料照常", () => {
    s.features = {};
    render(<HomePage />, { wrapper: Wrapper });
    expect(screen.getByText("阿明")).toBeInTheDocument();
    expect(screen.queryByTestId("staff-line-binding-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("staff-push-card")).not.toBeInTheDocument();
  });
});
