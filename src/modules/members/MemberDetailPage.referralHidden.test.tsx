// #1037(客戶端第 1 批 C1-E02 + 主腦裁決 Q3):會員詳細頁的「推薦碼」與「推薦名單」跟紅利設定的
// 「推薦系統」分頁共用同一個隱藏開關(referralVisibility.ts 的 REFERRAL_UI_HIDDEN)。
//   - 開關 = true(正式值)⇒ 兩塊都看不到
//   - 開關 = false(恢復)⇒ 兩塊照舊顯示(證明只是藏起來,不是刪掉)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberDetail } from "./types";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({ member: null as unknown, referralHidden: true }));

vi.mock("./referralVisibility", () => ({
  get REFERRAL_UI_HIDDEN() {
    return state.referralHidden;
  },
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
  MemberLineBindingSection: () => null,
  // SPECS-INDEX #1025 FG-2:平台沒開 LINE 通知時改掛的「只剩 LINE 登入」版本。
  MemberLineLoginOnlySection: () => null,
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
    referral_code: "REFCODE77",
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

beforeEach(() => {
  state.member = makeMember();
  state.referralHidden = true;
});
afterEach(() => cleanup());

describe("#1037 會員詳細頁的推薦碼 / 推薦名單隱藏", () => {
  it("隱藏開關打開(正式值)⇒ 推薦碼與推薦名單都看不到,其他資訊照舊", () => {
    renderPage();
    expect(screen.queryByText("推薦碼")).toBeNull();
    expect(screen.queryByText("REFCODE77")).toBeNull();
    expect(screen.queryByText("推薦名單")).toBeNull();
    expect(screen.queryByTestId("member-referrals-card")).toBeNull();
    expect(screen.getByText("會員等級")).toBeInTheDocument();
    expect(screen.getByText("黑名單狀態")).toBeInTheDocument();
  });

  it("隱藏開關關掉(恢復)⇒ 推薦碼與推薦名單照舊顯示", () => {
    state.referralHidden = false;
    renderPage();
    expect(screen.getByText("推薦碼")).toBeInTheDocument();
    expect(screen.getByText("REFCODE77")).toBeInTheDocument();
    expect(screen.getByText("推薦名單")).toBeInTheDocument();
  });

  it("#1037 第 2 輪:隱藏時「編輯會員資料」沒有推薦人唯讀列,副標題也不提推薦人", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "編輯" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("只有姓名是必填的。");
    expect(dialog.textContent).not.toMatch(/推薦/);
  });

  it("#1037 第 2 輪:恢復時編輯視窗的推薦人唯讀列照舊", async () => {
    state.referralHidden = false;
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "編輯" }));
    expect(
      await screen.findByText("推薦人只能在建立會員時設定，之後無法變更。"),
    ).toBeInTheDocument();
  });
});
