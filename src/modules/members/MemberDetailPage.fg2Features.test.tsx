// SPECS-INDEX #1025 功能開關 第 2 批(QA M1):會員詳情「LINE 綁定」卡 × 平台功能「LINE 通知」。
//
//   1. 開著 ⇒ 卡片標題「LINE 綁定」,完整區塊(綁定碼 / 解除綁定 + 客人 LINE 登入)照舊;未驗證提醒照舊
//   2. 關著 ⇒ 標題改「LINE 登入」,只掛 LINE 登入相關的區塊;「請用下面的 LINE 綁定產生綁定碼」的提醒不顯示;
//      不出現「沒開通」這類字
//   3. 讀取中 ⇒ 跟關著一樣(不先露出通知相關內容)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemberDetail } from "./types";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  member: null as unknown,
  line: undefined as boolean | undefined,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: MERCHANT_ID, name: "測試商家" } }),
}));
vi.mock("./RequireMembersAccess", () => ({
  RequireMembersAccess: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./MemberPointsPanel", () => ({ MemberPointsPanel: () => null }));
vi.mock("@/modules/line-notifications/MemberLineBindingSection", () => ({
  MemberLineBindingSection: () => <div data-testid="binding-full" />,
  MemberLineLoginOnlySection: () => <div data-testid="binding-login-only" />,
}));
vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: { lineNotifications: "line_notifications" },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => (key === "line_notifications" ? state.line : true),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./api", () => ({
  setMemberBlacklistStatus: vi.fn(),
  updateMember: vi.fn(),
  useMember: () => ({ data: state.member, isLoading: false }),
  useMemberReferrals: () => ({ data: [] }),
  useMemberRelatedBookings: () => ({ data: [] }),
  useMerchantPointsFeatureEnabled: () => ({ data: false }),
  useMerchantMemberTiers: () => ({ data: [] }),
}));

const { default: MemberDetailPage } = await import("./MemberDetailPage");

function makeMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: MEMBER_ID,
    merchant_id: MERCHANT_ID,
    name: "王小明",
    phone: "0912345678",
    email: null,
    birthday: null,
    address: null,
    notes: null,
    status: "active",
    tier_id: null,
    points_balance: 0,
    referral_code: "ABC123",
    is_blacklisted: false,
    blacklist_reason: null,
    identity_verified_at: null,
    identity_first_verified_at: null,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/app/members/${MEMBER_ID}`]}>
        <Routes>
          <Route path="/app/members/:id" element={<MemberDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.line = undefined;
});

describe("會員詳情 LINE 卡 × LINE 通知功能開關(#1025 FG2,QA M1)", () => {
  it("開著 ⇒ 標題「LINE 綁定」、完整區塊、未驗證提醒照舊", () => {
    state.member = makeMember();
    state.line = true;
    renderPage();
    expect(screen.getByTestId("member-line-card")).toHaveTextContent("LINE 綁定");
    expect(screen.getByTestId("binding-full")).toBeInTheDocument();
    expect(screen.queryByTestId("binding-login-only")).not.toBeInTheDocument();
    expect(screen.getByText(/產生綁定碼給他/)).toBeInTheDocument();
  });

  it("關著 ⇒ 標題「LINE 登入」、只剩 LINE 登入區塊、不提綁定碼", () => {
    state.member = makeMember();
    state.line = false;
    const { container } = renderPage();
    const card = screen.getByTestId("member-line-card");
    expect(card).toHaveTextContent("LINE 登入");
    expect(card).not.toHaveTextContent("LINE 綁定");
    expect(screen.getByTestId("binding-login-only")).toBeInTheDocument();
    expect(screen.queryByTestId("binding-full")).not.toBeInTheDocument();
    expect(screen.queryByText(/產生綁定碼給他/)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/尚未開通|沒有開放|方案|價格|加購/);
  });

  it("讀取中 ⇒ 不先露出通知相關內容", () => {
    state.member = makeMember();
    state.line = undefined;
    renderPage();
    expect(screen.getByTestId("binding-login-only")).toBeInTheDocument();
    expect(screen.queryByTestId("binding-full")).not.toBeInTheDocument();
  });
});
