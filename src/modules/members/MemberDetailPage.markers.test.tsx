// 第 11 批 D(#991,2026-10-07):會員詳情「標記」區塊拿掉「電話驗證狀態」人工標記。
//
// 規格書 §10.4 D-1 / §10.6:「標記」區塊只剩「黑名單狀態」;「電話驗證狀態」「標記為已驗證」
// 「取消驗證標記」三段字都不可以再出現。黑名單那一列(含解除黑名單按鈕)完全不動。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemberDetail } from "./types";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({ member: null as unknown }));

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

afterEach(() => cleanup());

describe("第 11 批 D:會員詳情「標記」區塊只剩黑名單", () => {
  it("一般會員:沒有電話驗證狀態那一列,黑名單狀態還在", () => {
    state.member = makeMember();
    renderPage();
    expect(screen.getByText("黑名單狀態")).toBeInTheDocument();
    expect(screen.queryByText("電話驗證狀態")).toBeNull();
    expect(screen.queryByText("此為人工標記，非簡訊驗證")).toBeNull();
    expect(screen.queryByRole("button", { name: "標記為已驗證" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消驗證標記" })).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/電話驗證|電話已驗證/);
  });

  it("黑名單會員:解除黑名單按鈕照舊顯示", () => {
    state.member = makeMember({ is_blacklisted: true, blacklist_reason: "多次爽約" });
    renderPage();
    expect(screen.getByText("黑名單狀態")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除黑名單" })).toBeInTheDocument();
    expect(screen.getByText("原因：多次爽約")).toBeInTheDocument();
    expect(screen.queryByText("電話驗證狀態")).toBeNull();
  });
});
