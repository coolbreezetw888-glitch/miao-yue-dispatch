// SPECS-INDEX #1025 功能開關 FG1-T03 / FG1-U06 第 1 點:功能頁卡片依平台功能開關「整個看不到」。
//
//   1. 管理員:資料匯入 / 報表匯出中心 沒開通 ⇒ 卡片不出現;開通 ⇒ 照舊出現
//   2. 客服(有 report_export 權限):報表匯出中心 沒開通 ⇒ 不出現(沒有「只給管理員看鎖頭」的例外);開通 ⇒ 出現
//   3. 客戶線上預約 沒開通 ⇒「預約網址」卡不出現(off_impact:商家後台看不到預約網址)
//   4. 讀取中(undefined)⇒ 先不出現(不閃一下)
//   5. 畫面上沒有任何「尚未開通」「方案」字樣

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  role: "admin" as "admin" | "agent",
  features: {} as Record<string, boolean | undefined>,
}));

vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    onlineBooking: "online_booking",
    dataImport: "data_import",
    reportExport: "report_export",
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
  useCurrentMerchant: () => ({
    merchant: { id: "merchant-1", name: "測試店", booking_slug: "test-shop" },
    isLoading: false,
  }),
  useMyAdminProfile: () => ({ data: null, refetch: vi.fn() }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: s.role }),
  // 客服:每一把權限都開著(要驗的是「權限開著也看不到沒開通的功能」)。
  useAgentPermission: () => ({ data: true }),
  useMyAgentProfile: () => ({ data: null, refetch: vi.fn() }),
}));
vi.mock("./appLayoutContext", () => ({
  useAppLayoutContext: () => ({
    email: "owner@test.local",
    newEmail: null,
    userId: "user-1",
    isStaffView: false,
    isViewResolved: true,
    isDualRoleEligible: false,
    onToggleStaffView: vi.fn(),
  }),
}));
vi.mock("./ProfileCardShared", () => ({
  emailNamePrefix: (email: string | null) => (email ?? "").split("@")[0] ?? "",
  LoginEmailSection: () => null,
  PendingAdminLoginEmailSuggestionCard: () => null,
}));
vi.mock("@/modules/line-notifications/MyLineBindingCard", () => ({
  MyLineBindingCard: () => null,
}));
vi.mock("@/modules/push-notifications/MyPushSubscriptionCard", () => ({
  MyPushSubscriptionCard: () => null,
}));

const { default: ManagePage } = await import("./ManagePage");

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/manage"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderPage() {
  return render(<ManagePage />, { wrapper: Wrapper });
}

const ALL_ON = { online_booking: true, data_import: true, report_export: true };

afterEach(() => {
  cleanup();
  s.role = "admin";
  s.features = {};
});

describe("功能頁卡片 × 平台功能開關(#1025 FG1-U06)", () => {
  it("管理員:全部開通 ⇒ 資料匯入、報表匯出中心、預約網址都看得到(照舊)", () => {
    s.features = { ...ALL_ON };
    renderPage();
    expect(screen.getByText("資料匯入")).toBeInTheDocument();
    expect(screen.getByText("報表匯出中心")).toBeInTheDocument();
    expect(screen.getByText("預約網址")).toBeInTheDocument();
  });

  it("管理員:資料匯入、報表匯出沒開通 ⇒ 兩張卡都看不到,其他卡照常", () => {
    s.features = { ...ALL_ON, data_import: false, report_export: false };
    renderPage();
    expect(screen.queryByText("資料匯入")).not.toBeInTheDocument();
    expect(screen.queryByText("報表匯出中心")).not.toBeInTheDocument();
    expect(screen.getByText("商家設定")).toBeInTheDocument();
  });

  it("客服(有匯出權限):報表匯出沒開通 ⇒ 看不到;開通 ⇒ 看得到", () => {
    s.role = "agent";
    s.features = { ...ALL_ON, report_export: false };
    const { unmount } = renderPage();
    expect(screen.queryByText("報表匯出中心")).not.toBeInTheDocument();
    unmount();
    s.features = { ...ALL_ON };
    renderPage();
    expect(screen.getByText("報表匯出中心")).toBeInTheDocument();
  });

  it("客戶線上預約沒開通 ⇒「預約網址」卡看不到", () => {
    s.features = { ...ALL_ON, online_booking: false };
    renderPage();
    expect(screen.queryByText("預約網址")).not.toBeInTheDocument();
    expect(screen.queryByTestId("booking-url-open")).not.toBeInTheDocument();
  });

  it("讀取中(還不知道)⇒ 三樣都先不出現", () => {
    s.features = {};
    renderPage();
    expect(screen.queryByText("資料匯入")).not.toBeInTheDocument();
    expect(screen.queryByText("報表匯出中心")).not.toBeInTheDocument();
    expect(screen.queryByText("預約網址")).not.toBeInTheDocument();
  });

  it("沒開通時畫面上沒有「尚未開通」「方案」這類字", () => {
    s.features = { online_booking: false, data_import: false, report_export: false };
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/尚未開通|方案|加購|價格/);
  });
});
