// 客戶端第 4 批 4-B(C4-H11 + QA 低-3):會員詳細頁「解除綁定」先跳確認窗,文字講清楚會解除所有聯絡人;
// 確認鈕是危險樣式(白底紅字淡紅框)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ unbindCalls: [] as unknown[][] }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./api", () => ({
  useMemberLineBindingStatus: () => ({ data: { lineBound: true }, isLoading: false }),
  generateMemberLineBindingCode: vi.fn(),
  unbindLineAccount: vi.fn(async (...args: unknown[]) => {
    state.unbindCalls.push(args);
  }),
}));
vi.mock("./MemberCustomerLoginRow", () => ({ MemberCustomerLoginRow: () => null }));
vi.mock("./MemberContactsCard", () => ({ MemberContactsCard: () => null }));

const { MemberLineBindingSection } = await import("./MemberLineBindingSection");

afterEach(() => cleanup());

describe("解除 LINE 綁定確認窗", () => {
  it("按「解除綁定」⇒ 確認窗(會解除所有聯絡人)⇒ 危險樣式確認鈕 ⇒ 才真的解除", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemberLineBindingSection memberId="m1" />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "解除綁定" }));
    const dialog = await screen.findByTestId("member-unbind-dialog");
    expect(dialog).toHaveTextContent("會解除這位會員所有聯絡人的 LINE 登入");
    expect(state.unbindCalls).toEqual([]);
    const ok = within(dialog).getByTestId("member-unbind-confirm");
    expect(ok).toHaveClass(/text-destructive/);
    expect(ok).toHaveClass(/bg-background/);
    await user.click(ok);
    await waitFor(() => expect(state.unbindCalls).toEqual([["member", "m1"]]));
  });
});
