// 客戶端第 2 批(C2-H03 + 主腦複查追加):會員詳細頁「客戶端登入」那一行與「允許重新接上」按鈕。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: { linked: false, lastLoginAt: null, relinkBlocked: true } as unknown,
  role: "admin" as string | null,
  agentMembers: null as boolean | null,
  allowCalls: [] as string[],
}));

vi.mock("./memberCustomerLoginApi", async () => {
  const actual = await vi.importActual<typeof import("./memberCustomerLoginApi")>(
    "./memberCustomerLoginApi",
  );
  return {
    ...actual,
    fetchMemberCustomerLoginStatus: vi.fn(async () => state.status),
    allowMemberCustomerRelink: vi.fn(async (id: string) => {
      state.allowCalls.push(id);
      state.status = { linked: false, lastLoginAt: null, relinkBlocked: false };
    }),
  };
});

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: state.role }),
  useAgentPermission: () => ({ data: state.agentMembers }),
}));

const { MemberCustomerLoginRow } = await import("./MemberCustomerLoginRow");
const { canManageMembers } = await import("./memberCustomerLoginApi");

function renderRow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemberCustomerLoginRow memberId="m1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.status = { linked: false, lastLoginAt: null, relinkBlocked: true };
  state.role = "admin";
  state.agentMembers = null;
  state.allowCalls = [];
});
afterEach(() => cleanup());

describe("允許重新接上", () => {
  it("relink_blocked + 管理員 ⇒ 有按鈕;確認後呼叫並重抓,按鈕消失", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(await screen.findByTestId("member-customer-relink-button"));
    expect(await screen.findByText(/這位會員的 LINE 綁定先前被你解除過/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "允許" }));
    await waitFor(() => expect(state.allowCalls).toEqual(["m1"]));
    await waitFor(() => expect(screen.queryByTestId("member-customer-relink-button")).toBeNull());
  });

  it("取消 ⇒ 不呼叫", async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(await screen.findByTestId("member-customer-relink-button"));
    await user.click(await screen.findByRole("button", { name: "取消" }));
    expect(state.allowCalls).toEqual([]);
  });

  it("沒有被擋 ⇒ 不顯示", async () => {
    state.status = { linked: true, lastLoginAt: "2026-10-08T02:00:00Z", relinkBlocked: false };
    renderRow();
    expect(await screen.findByText("已連結")).toBeInTheDocument();
    expect(screen.queryByTestId("member-customer-relink-button")).toBeNull();
  });

  it("客服沒有會員管理權限 ⇒ 不顯示(有權限才顯示)", async () => {
    state.role = "agent";
    state.agentMembers = false;
    renderRow();
    expect(await screen.findByText("未連結")).toBeInTheDocument();
    expect(screen.queryByTestId("member-customer-relink-button")).toBeNull();
    cleanup();
    state.agentMembers = true;
    renderRow();
    expect(await screen.findByTestId("member-customer-relink-button")).toBeInTheDocument();
  });

  it("canManageMembers", () => {
    expect(canManageMembers("admin", null)).toBe(true);
    expect(canManageMembers("agent", true)).toBe(true);
    expect(canManageMembers("agent", false)).toBe(false);
    expect(canManageMembers("staff", true)).toBe(false);
    expect(canManageMembers(null, null)).toBe(false);
  });
});
