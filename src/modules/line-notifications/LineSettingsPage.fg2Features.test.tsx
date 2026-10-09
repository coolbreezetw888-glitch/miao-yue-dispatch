// SPECS-INDEX #1025 功能開關 第 2 批(主腦裁決 1):LINE 串接設定頁 × 平台功能「LINE 通知」。
//
//   1. 開著 ⇒ 完整頁面(官方帳號連線狀態、憑證表單、LINE 登入設定卡),行為不變
//   2. 關著 ⇒ 頁面仍進得來,只剩「LINE 登入」設定卡;Messaging API 憑證、連線狀態、解除串接都看不到;
//      沒有「沒開通」這類字
//   3. 讀取中 ⇒ 只顯示骨架,不先露出通知相關內容
//   4. 讀取失敗 ⇒ 可重試的錯誤,也不露出通知相關內容

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  line: undefined as boolean | undefined,
  isError: false,
}));

vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    lineNotifications: "line_notifications",
    lineMarketing: "line_marketing",
    pushNotifications: "push_notifications",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => (key === "line_notifications" ? s.line : true),
    isLoading: false,
    isError: s.isError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1", name: "測試店" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/RequireMerchantAdmin", () => ({
  RequireMerchantAdmin: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./LineLoginSettingsCard", () => ({
  LineLoginSettingsCard: ({
    merchantId,
    showNotificationHints,
  }: {
    merchantId: string;
    showNotificationHints?: boolean;
  }) => (
    <div data-testid="line-login-card" data-hints={String(showNotificationHints ?? true)}>
      {merchantId}
    </div>
  ),
}));
vi.mock("./api", () => ({
  useMerchantLineConfigStatus: () => ({
    data: {
      isConnected: true,
      channelId: "1234567890",
      displayName: "測試官方帳號",
      lineBotBasicId: "abc123",
      channelAccessTokenMasked: "****abcd",
      lastTestedAt: null,
      lastTestResult: null,
    },
    isLoading: false,
  }),
  setMerchantLineCredentials: vi.fn(),
  testLineConnection: vi.fn(),
  disconnectMerchantLine: vi.fn(),
}));

const { default: LineSettingsPage } = await import("./LineSettingsPage");

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/line-settings"]}>
        <LineSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  s.line = undefined;
  s.isError = false;
});

describe("LINE 串接設定頁 × LINE 通知功能開關(#1025 FG2,主腦裁決 1)", () => {
  it("開著 ⇒ 完整頁面:連線狀態、憑證表單、LINE 登入設定卡", () => {
    s.line = true;
    renderPage();
    expect(screen.getByText("目前連線狀態")).toBeInTheDocument();
    expect(document.getElementById("line-channel-token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存並測試連線" })).toBeInTheDocument();
    expect(screen.getByTestId("line-login-card")).toHaveAttribute("data-hints", "true");
    expect(screen.queryByTestId("line-settings-login-only")).not.toBeInTheDocument();
  });

  it("關著 ⇒ 只剩 LINE 登入設定卡;通知用的憑證、連線狀態、解除串接都看不到", () => {
    s.line = false;
    const { container } = renderPage();
    expect(screen.getByTestId("line-settings-login-only")).toBeInTheDocument();
    expect(screen.getByTestId("line-login-card")).toHaveTextContent("merchant-1");
    // 不承諾目前做不到的事:LINE 登入卡不提「收得到 LINE 通知」。
    expect(screen.getByTestId("line-login-card")).toHaveAttribute("data-hints", "false");
    expect(screen.getByText("設定客人用 LINE 登入會員中心。")).toBeInTheDocument();
    expect(screen.queryByText("目前連線狀態")).not.toBeInTheDocument();
    expect(document.getElementById("line-channel-token")).toBeNull();
    expect(screen.queryByRole("button", { name: "儲存並測試連線" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解除串接" })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/尚未開通|沒有開放|方案|價格|加購/);
  });

  it("讀取中 ⇒ 不先露出通知相關內容,也不顯示 LINE 登入卡", () => {
    s.line = undefined;
    renderPage();
    expect(screen.queryByText("目前連線狀態")).not.toBeInTheDocument();
    expect(screen.queryByTestId("line-login-card")).not.toBeInTheDocument();
  });

  it("讀取失敗 ⇒ 可重試的錯誤,不露出通知相關內容", () => {
    s.line = undefined;
    s.isError = true;
    renderPage();
    expect(screen.getByText("讀不到這個頁面的設定")).toBeInTheDocument();
    expect(screen.queryByText("目前連線狀態")).not.toBeInTheDocument();
  });
});
