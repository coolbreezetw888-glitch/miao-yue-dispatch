// 客戶端第 5 批 5-B(#1047,C5-P01):再行銷通知的「可收到 X 人」與發送確認窗「共 M 則訊息」。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatMarketingConfirmText,
  formatReachableCount,
  formatUnreachableNote,
  parseLineMarketingPreview,
} from "./marketingPreview";

const state = vi.hoisted(() => ({
  members: [] as unknown[],
  previewCalls: [] as { p_merchant_id: string; p_member_ids: string[] }[],
  perMember: {} as Record<string, number>,
  previewError: null as unknown,
  invokeCalls: [] as unknown[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: { p_merchant_id: string; p_member_ids: string[] }) => {
      if (fn === "list_line_marketable_members") return { data: state.members, error: null };
      if (fn === "preview_line_marketing_recipients") {
        state.previewCalls.push(args);
        if (state.previewError) return { data: null, error: state.previewError };
        const members = args.p_member_ids.map((id) => ({
          member_id: id,
          recipient_count: state.perMember[id] ?? 0,
        }));
        return {
          data: {
            member_count: members.filter((m) => m.recipient_count > 0).length,
            message_count: members.reduce((a, m) => a + m.recipient_count, 0),
            members,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    functions: {
      invoke: vi.fn(async (_fn: string, opts: unknown) => {
        state.invokeCalls.push(opts);
        return { data: { sentCount: 1, failedCount: 0, skippedCount: 0 }, error: null };
      }),
    },
  },
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "涼風工匠" } }),
}));
vi.mock("@/modules/members/api", () => ({
  useMerchantMemberTiers: () => ({ data: [] }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: "admin" }),
  useAgentPermission: () => ({ data: true }),
}));
vi.mock("./RequireLineMarketingAccess", () => ({
  RequireLineMarketingAccess: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { default: LineMarketingPage } = await import("./LineMarketingPage");

function member(id: string, name: string, isBlacklisted = false) {
  return { id, name, phone: null, tier_id: null, is_blacklisted: isBlacklisted };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LineMarketingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.members = [member("a", "王小明"), member("b", "陳公司"), member("c", "林小姐")];
  state.perMember = { a: 1, b: 2, c: 0 };
  state.previewCalls = [];
  state.previewError = null;
  state.invokeCalls = [];
});
afterEach(() => cleanup());

describe("C5-P01 純函式", () => {
  it("parse / 文字", () => {
    const p = parseLineMarketingPreview({
      member_count: 2,
      message_count: 3,
      members: [
        { member_id: "a", recipient_count: 1 },
        { member_id: "b", recipient_count: 2 },
        { bogus: true },
      ],
    });
    expect(p.memberCount).toBe(2);
    expect(p.messageCount).toBe(3);
    expect(p.perMember.get("b")).toBe(2);
    expect(parseLineMarketingPreview(null).messageCount).toBe(0);
    expect(formatReachableCount(2)).toBe("可收到 2 人");
    expect(formatReachableCount(undefined)).toBeNull();
    expect(formatMarketingConfirmText(2, 3)).toBe(
      "即將發送給 2 位會員，共 3 則訊息（會用掉 3 則官方帳號額度），確定要送出嗎？",
    );
    expect(formatUnreachableNote(3, 2)).toContain("另外 1 位會員目前沒有人收得到");
    expect(formatUnreachableNote(2, 2)).toBeNull();
  });
});

describe("C5-P01 再行銷通知頁", () => {
  it("名單每位顯示「可收到 X 人」", async () => {
    renderPage();
    const list = await screen.findByTestId("line-marketing-individual-list");
    await waitFor(() =>
      expect(within(list).getAllByTestId("line-marketing-reachable")).toHaveLength(3),
    );
    expect(list).toHaveTextContent("王小明可收到 1 人");
    expect(list).toHaveTextContent("陳公司可收到 2 人");
    expect(list).toHaveTextContent("林小姐可收到 0 人");
  });

  it("確認窗:用最後要送的名單算「N 位會員，共 M 則」;有收不到的會員另外說明;確定後才送", async () => {
    renderPage();
    const list = await screen.findByTestId("line-marketing-individual-list");
    for (const name of ["王小明", "陳公司", "林小姐"]) {
      await userEvent.click(within(list).getByText(name));
    }
    await userEvent.type(screen.getByLabelText("要發送的訊息"), "週年慶");
    await userEvent.click(screen.getByRole("button", { name: "發送" }));
    const dialog = await screen.findByTestId("line-marketing-confirm");
    await waitFor(() =>
      expect(within(dialog).getByTestId("line-marketing-confirm-text")).toHaveTextContent(
        "即將發送給 2 位會員，共 3 則訊息（會用掉 3 則官方帳號額度），確定要送出嗎？",
      ),
    );
    expect(dialog).toHaveTextContent("另外 1 位會員目前沒有人收得到");
    expect(dialog).toHaveTextContent("訊息一旦送到會員的 LINE 就無法收回，也不能編輯。");
    expect(state.previewCalls.at(-1)?.p_member_ids).toEqual(["a", "b", "c"]);
    expect(state.invokeCalls).toHaveLength(0);
    await userEvent.click(within(dialog).getByTestId("line-marketing-confirm-send"));
    await waitFor(() => expect(state.invokeCalls).toHaveLength(1));
  });

  it("一則都不會發 ⇒ 確定鈕停用 + 常駐 ! 說原因", async () => {
    state.perMember = { a: 0, b: 0, c: 0 };
    renderPage();
    const list = await screen.findByTestId("line-marketing-individual-list");
    await userEvent.click(within(list).getByText("王小明"));
    await userEvent.type(screen.getByLabelText("要發送的訊息"), "週年慶");
    await userEvent.click(screen.getByRole("button", { name: "發送" }));
    const dialog = await screen.findByTestId("line-marketing-confirm");
    expect(await within(dialog).findByTestId("line-marketing-nobody")).toHaveTextContent(
      "選到的會員目前都收不到",
    );
    expect(within(dialog).getByTestId("line-marketing-confirm-send")).toBeDisabled();
  });

  it("算不出則數 ⇒ 說明 + 仍可發送;名單不顯示「可收到」", async () => {
    state.previewError = { code: "500" };
    renderPage();
    const list = await screen.findByTestId("line-marketing-individual-list");
    expect(within(list).queryByTestId("line-marketing-reachable")).toBeNull();
    await userEvent.click(within(list).getByText("王小明"));
    await userEvent.type(screen.getByLabelText("要發送的訊息"), "週年慶");
    await userEvent.click(screen.getByRole("button", { name: "發送" }));
    const dialog = await screen.findByTestId("line-marketing-confirm");
    await waitFor(() => expect(dialog).toHaveTextContent("暫時算不出這次會用掉幾則官方帳號額度"));
    expect(within(dialog).getByTestId("line-marketing-confirm-text")).toHaveTextContent(
      "即將發送給 1 位會員，確定要送出嗎？",
    );
    expect(within(dialog).getByTestId("line-marketing-confirm-send")).toBeEnabled();
  });
});
