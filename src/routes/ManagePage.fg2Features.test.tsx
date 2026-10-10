// SPECS-INDEX #1025 功能開關 第 2 批 FG2-T01 / FG2-U01:功能頁 × LINE 通知 / 再行銷通知 / 手機推播通知。
//
//   1. 全開 ⇒ LINE 串接設定、LINE 通知設定、LINE 發送記錄、再行銷通知、推播通知設定、推播發送記錄、
//      個人「我的 LINE 綁定」「我的推播通知」卡都看得到(照舊)
//   2. LINE 通知關 ⇒ LINE 通知設定、LINE 發送記錄、再行銷(細部功能跟著主功能關;effective 由資料庫算好)、
//      我的 LINE 綁定都看不到;「LINE 串接設定」卡照常(頁面只剩 LINE 登入設定),說明改成講 LINE 登入;推播照常
//   3. 只關再行銷 ⇒ 只有再行銷卡不見,其他 LINE 卡照常
//   4. 手機推播關 ⇒ 推播設定、推播發送記錄、我的推播通知卡都看不到;LINE 照常
//   5. 讀取中(還不知道)⇒ 都先不出現(「LINE 串接設定」照常、用原本的說明)
//   6. 客服(權限全開)一樣看不到沒開通的
//   7. 沒有「尚未開通」「方案」這類字

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
  MyLineBindingCard: () => <div data-testid="my-line-binding-card" />,
}));
vi.mock("@/modules/push-notifications/MyPushSubscriptionCard", () => ({
  MyPushSubscriptionCard: () => <div data-testid="my-push-card" />,
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

const ALL_ON = {
  online_booking: true,
  data_import: true,
  report_export: true,
  line_notifications: true,
  line_marketing: true,
  push_notifications: true,
};
const LINE_CARDS = ["LINE 串接設定", "LINE 通知設定", "LINE 發送記錄", "再行銷通知"];
/** LINE 通知沒開時會藏起來的卡(「LINE 串接設定」不藏:裡面還有 LINE 登入設定)。 */
const LINE_NOTIFY_CARDS = ["LINE 通知設定", "LINE 發送記錄", "再行銷通知"];
const LOGIN_ONLY_DESC = "設定客人用 LINE 登入會員中心";
const FULL_DESC = "串接商家自己的 LINE 官方帳號憑證、測試連線";
const PUSH_CARDS = ["推播通知設定", "推播發送記錄"];

afterEach(() => {
  cleanup();
  s.role = "admin";
  s.features = {};
});

describe("功能頁 × LINE 通知 / 再行銷 / 手機推播(#1025 FG2-U01)", () => {
  it("全部開通 ⇒ LINE、推播的卡片與兩張個人卡都看得到(照舊)", () => {
    s.features = { ...ALL_ON };
    renderPage();
    for (const label of [...LINE_CARDS, ...PUSH_CARDS])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(FULL_DESC)).toBeInTheDocument();
    expect(screen.getByTestId("my-line-binding-card")).toBeInTheDocument();
    expect(screen.getByTestId("my-push-card")).toBeInTheDocument();
  });

  it("LINE 通知關(再行銷跟著關)⇒ 通知相關三張卡與我的 LINE 綁定都看不到;LINE 串接設定改講 LINE 登入;推播照常", () => {
    s.features = { ...ALL_ON, line_notifications: false, line_marketing: false };
    renderPage();
    for (const label of LINE_NOTIFY_CARDS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText("LINE 串接設定")).toBeInTheDocument();
    expect(screen.getByText(LOGIN_ONLY_DESC)).toBeInTheDocument();
    expect(screen.queryByText(FULL_DESC)).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-line-binding-card")).not.toBeInTheDocument();
    for (const label of PUSH_CARDS) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId("my-push-card")).toBeInTheDocument();
  });

  it("只關再行銷 ⇒ 只有「再行銷通知」不見,其他 LINE 卡照常", () => {
    s.features = { ...ALL_ON, line_marketing: false };
    renderPage();
    expect(screen.queryByText("再行銷通知")).not.toBeInTheDocument();
    for (const label of ["LINE 串接設定", "LINE 通知設定", "LINE 發送記錄"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId("my-line-binding-card")).toBeInTheDocument();
  });

  it("手機推播關 ⇒ 推播設定、推播發送記錄、我的推播通知卡都看不到;LINE 照常", () => {
    s.features = { ...ALL_ON, push_notifications: false };
    renderPage();
    for (const label of PUSH_CARDS) expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-push-card")).not.toBeInTheDocument();
    for (const label of LINE_CARDS) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("客服(權限全開):沒開通的一樣看不到", () => {
    s.role = "agent";
    s.features = {
      ...ALL_ON,
      line_notifications: false,
      line_marketing: false,
      push_notifications: false,
    };
    renderPage();
    for (const label of [...LINE_CARDS, ...PUSH_CARDS])
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-line-binding-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-push-card")).not.toBeInTheDocument();
  });

  it("讀取中(還不知道)⇒ 都先不出現", () => {
    s.features = { online_booking: true, data_import: true, report_export: true };
    renderPage();
    for (const label of [...LINE_NOTIFY_CARDS, ...PUSH_CARDS])
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.getByText(FULL_DESC)).toBeInTheDocument();
    expect(screen.queryByTestId("my-line-binding-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-push-card")).not.toBeInTheDocument();
  });

  it("沒開通時畫面上沒有「尚未開通」「方案」這類字", () => {
    s.features = {
      ...ALL_ON,
      line_notifications: false,
      line_marketing: false,
      push_notifications: false,
    };
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/尚未開通|方案|加購|價格/);
  });
});
