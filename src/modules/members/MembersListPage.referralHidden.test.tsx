// #1037 第 2 輪(2026-10-08 主腦裁決):會員列表卡片的推薦碼、新增會員表單的「推薦人」欄位,
// 跟紅利設定的推薦系統分頁共用同一個隱藏開關(referralVisibility.ts 的 REFERRAL_UI_HIDDEN)。
//   - 開關 = true(正式值)⇒ 看不到;新增會員送出的推薦人是空的
//   - 開關 = false(恢復)⇒ 照舊顯示(證明只是藏起來,不是刪掉)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberSummary } from "./types";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  referralHidden: true,
  createMember: vi.fn(),
}));

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
vi.mock("./api", () => ({
  createMember: state.createMember,
  deactivateMember: vi.fn(),
  reactivateMember: vi.fn(),
  fetchMerchantMembersList: vi.fn(async (): Promise<MemberSummary[]> => [
    {
      id: "m1",
      name: "王小明",
      phone: "0912345678",
      referralCode: "REFCODE77",
      pointsBalance: 10,
      status: "active",
      tierId: null,
      isBlacklisted: false,
      identityVerifiedAt: null,
    },
  ]),
  useMerchantMemberTiers: () => ({ data: [] }),
}));

const { default: MembersListPage } = await import("./MembersListPage");

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/members"]}>
        <MembersListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.referralHidden = true;
  state.createMember.mockReset().mockResolvedValue({ id: "new" });
});
afterEach(() => cleanup());

describe("#1037 第 2 輪:會員列表 / 新增會員的推薦畫面隱藏", () => {
  it("隱藏(正式值)⇒ 卡片上沒有推薦碼,電話照舊;搜尋提示不提推薦碼", async () => {
    renderPage();
    expect(await screen.findByText("王小明")).toBeInTheDocument();
    expect(screen.getByText("0912345678")).toBeInTheDocument();
    expect(screen.queryByText(/REFCODE77/)).toBeNull();
    expect(screen.queryByText(/推薦碼/)).toBeNull();
    expect(screen.getByPlaceholderText("搜尋姓名/電話")).toBeInTheDocument();
  });

  it("隱藏(正式值)⇒ 新增會員表單沒有推薦人欄位;送出的推薦人是空的", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("王小明");
    await user.click(screen.getByRole("button", { name: "新增會員" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toMatch(/推薦人/);
    await user.type(screen.getByLabelText(/^姓名/), "陳小華");
    await user.type(screen.getByLabelText(/^電話/), "0922333444");
    await user.click(screen.getByRole("button", { name: /^建立/ }));
    await waitFor(() => expect(state.createMember).toHaveBeenCalled());
    expect(state.createMember.mock.calls[0]![0]).toMatchObject({ referredByMemberId: null });
  });

  it("恢復(開關關掉)⇒ 推薦碼、推薦人欄位照舊顯示", async () => {
    state.referralHidden = false;
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("推薦碼 REFCODE77")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜尋姓名/電話/推薦碼")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新增會員" }));
    expect(await screen.findByText("推薦人(選填)")).toBeInTheDocument();
  });
});
