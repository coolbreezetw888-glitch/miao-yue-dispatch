// SPECS-INDEX #1025 功能開關 第 2 批(QA M1):平台沒開「LINE 通知」時,會員詳情改掛的 MemberLineLoginOnlySection。
//
//   ・保留「客人 LINE 登入」那一行(MemberCustomerLoginRow,不受開關影響)與 LINE 聯絡人(不帶通知資訊)
//   ・沒有綁定狀態、產生綁定碼、解除綁定

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./api", () => ({
  generateMemberLineBindingCode: vi.fn(),
  unbindLineAccount: vi.fn(),
  useMemberLineBindingStatus: () => ({ data: { lineBound: true }, isLoading: false }),
}));
vi.mock("./MemberCustomerLoginRow", () => ({
  MemberCustomerLoginRow: ({ memberId }: { memberId: string }) => (
    <div data-testid="customer-login-row">{memberId}</div>
  ),
}));
vi.mock("./MemberContactsCard", () => ({
  MemberContactsCard: ({ showNotificationInfo }: { showNotificationInfo?: boolean }) => (
    <div data-testid="contacts-card" data-notify={String(showNotificationInfo ?? true)} />
  ),
}));

const { MemberLineLoginOnlySection, MemberLineBindingSection } =
  await import("./MemberLineBindingSection");

function wrap(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

afterEach(() => cleanup());

describe("MemberLineLoginOnlySection(#1025 FG2,QA M1)", () => {
  it("只留客人 LINE 登入那一行 + 聯絡人(不帶通知資訊);沒有綁定狀態 / 綁定碼 / 解除綁定", () => {
    wrap(<MemberLineLoginOnlySection memberId="m1" />);
    expect(screen.getByTestId("customer-login-row")).toHaveTextContent("m1");
    expect(screen.getByTestId("contacts-card")).toHaveAttribute("data-notify", "false");
    expect(screen.queryByText("綁定狀態")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解除綁定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "產生綁定碼" })).not.toBeInTheDocument();
  });

  it("對照:完整版(LINE 通知開著)照舊有綁定狀態與解除綁定,聯絡人帶通知資訊", () => {
    wrap(<MemberLineBindingSection memberId="m1" />);
    expect(screen.getByText("綁定狀態")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除綁定" })).toBeInTheDocument();
    expect(screen.getByTestId("contacts-card")).toHaveAttribute("data-notify", "true");
  });
});
