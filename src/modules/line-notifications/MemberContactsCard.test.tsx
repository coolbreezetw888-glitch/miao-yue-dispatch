// 客戶端第 4 批 4-B(C4-K04):會員詳細頁「聯絡人」卡各狀態(沒有 / 主要 + 第二 / 申請 / 權限)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: null as unknown,
  role: "admin" as string | null,
  agentMembers: null as boolean | null,
  calls: [] as unknown[][],
  results: [] as string[],
  toasts: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign((msg: string) => state.toasts.push(msg), {
    success: (msg: string) => state.toasts.push(msg),
    error: (msg: string) => state.toasts.push(msg),
  }),
}));

vi.mock("./memberContactsAdminApi", async () => {
  const actual = await vi.importActual<typeof import("./memberContactsAdminApi")>(
    "./memberContactsAdminApi",
  );
  const rec =
    (fn: string) =>
    async (...args: unknown[]) => {
      state.calls.push([fn, ...args]);
      return state.results.shift() ?? "ok";
    };
  return {
    ...actual,
    fetchAdminMemberContacts: vi.fn(async () => actual.parseAdminMemberContacts(state.data)),
    merchantSetPrimaryContact: vi.fn(rec("setPrimary")),
    merchantRemoveMemberContact: vi.fn(rec("remove")),
    merchantResolveContactRequest: vi.fn(rec("resolve")),
  };
});

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: state.role }),
  useAgentPermission: () => ({ data: state.agentMembers }),
}));

const { MemberContactsCard } = await import("./MemberContactsCard");
const { PROMO_SWITCH_VISIBLE } = await import("@/lib/customerLinePromo");

const TWO = {
  contacts: [
    {
      id: "c2",
      line_display_name: "小李",
      is_primary: false,
      contact_phone: "0933111222",
      joined_via: "invite",
      joined_at: "2026-10-08T02:00:00Z",
      last_login_at: null,
      line_user_id: "U-should-not-show",
    },
    {
      id: "c1",
      line_display_name: "王小明",
      is_primary: true,
      contact_phone: null,
      joined_via: "first_login",
      joined_at: "2026-10-01T02:00:00Z",
      last_login_at: "2026-10-09T02:00:00Z",
    },
  ],
  requests: [
    {
      id: "r1",
      line_display_name: "阿華",
      phone: "0911000222",
      created_at: "2026-10-09T01:00:00Z",
    },
  ],
  relink_blocked: false,
};

function renderCard(showNotificationInfo?: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {showNotificationInfo === undefined ? (
        <MemberContactsCard memberId="m1" />
      ) : (
        <MemberContactsCard memberId="m1" showNotificationInfo={showNotificationInfo} />
      )}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.data = TWO;
  state.role = "admin";
  state.agentMembers = null;
  state.calls = [];
  state.results = [];
  state.toasts = [];
});
afterEach(() => cleanup());

describe("C4-K04 會員詳細頁聯絡人卡", () => {
  it("沒有聯絡人 ⇒ 說明一句", async () => {
    state.data = { contacts: [], requests: [], relink_blocked: false };
    renderCard();
    expect(await screen.findByTestId("member-contacts-card-empty")).toHaveTextContent(
      "還沒有聯絡人",
    );
  });

  it("主要排第一;顯示主要 / 第二、聯絡人電話、加入方式與時間、最後登入;不顯示 LINE userId", async () => {
    renderCard();
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    expect(rows[0]).toHaveTextContent("王小明");
    expect(rows[0]).toHaveTextContent("主要聯絡人");
    expect(rows[0]).toHaveTextContent("第一次登入");
    expect(rows[0]).toHaveTextContent("最後登入 10月9日");
    expect(rows[1]).toHaveTextContent("第二聯絡人");
    expect(rows[1]).toHaveTextContent("聯絡人電話 0933111222");
    expect(rows[1]).toHaveTextContent("邀請連結 10月8日");
    expect(document.body.textContent).not.toContain("U-should-not-show");
    expect(within(rows[0]!).queryByTestId("member-contacts-card-set-primary")).toBeNull();
    expect(within(rows[1]!).getByTestId("member-contacts-card-set-primary")).toBeInTheDocument();
  });

  it("設為主要聯絡人 ⇒ 確認 ⇒ 呼叫", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByTestId("member-contacts-card-set-primary"));
    expect(await screen.findByTestId("member-contacts-card-confirm")).not.toHaveClass(
      /text-destructive/,
    );
    await user.click(await screen.findByTestId("member-contacts-card-confirm"));
    await waitFor(() => expect(state.toasts).toContain("已設為主要聯絡人"));
    expect(state.calls).toEqual([["setPrimary", "c2"]]);
  });

  it("移除主要聯絡人(還有別人)⇒ 同一個視窗先選新的主要聯絡人,沒選不能按", async () => {
    const user = userEvent.setup();
    renderCard();
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    await user.click(within(rows[0]!).getByTestId("member-contacts-card-remove"));
    const dialog = await screen.findByTestId("member-contacts-card-dialog");
    expect(within(dialog).getByTestId("member-contacts-card-need-primary")).toBeInTheDocument();
    expect(within(dialog).getByTestId("member-contacts-card-confirm")).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: "小李" }));
    await user.click(within(dialog).getByTestId("member-contacts-card-confirm"));
    await waitFor(() => expect(state.toasts).toContain("已移除這位聯絡人"));
    expect(state.calls).toEqual([["remove", "c1", "c2"]]);
  });

  it("移除第二聯絡人 ⇒ 不用選新的主要", async () => {
    const user = userEvent.setup();
    renderCard();
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    await user.click(within(rows[1]!).getByTestId("member-contacts-card-remove"));
    const dialog = await screen.findByTestId("member-contacts-card-dialog");
    expect(within(dialog).queryByTestId("member-contacts-card-new-primary")).toBeNull();
    // QA 低-3:移除會連帶封鎖 ⇒ 危險樣式
    expect(within(dialog).getByTestId("member-contacts-card-confirm")).toHaveClass(
      /text-destructive/,
    );
    await user.click(within(dialog).getByTestId("member-contacts-card-confirm"));
    await waitFor(() => expect(state.calls).toEqual([["remove", "c2", null]]));
  });

  it("待處理申請 ⇒ 同意 / 拒絕;額滿 ⇒ 固定句子", async () => {
    state.results = ["contact_limit"];
    const user = userEvent.setup();
    renderCard();
    const req = await screen.findByTestId("member-contacts-card-request");
    expect(req).toHaveTextContent("阿華");
    expect(req).toHaveTextContent("0911000222");
    await user.click(within(req).getByTestId("member-contacts-card-approve"));
    await waitFor(() => expect(state.calls).toEqual([["resolve", "r1", true]]));
    expect(state.toasts).toContain("沒有處理成功");
  });

  it("沒有會員管理權限的客服 ⇒ 只看不能操作", async () => {
    state.role = "agent";
    state.agentMembers = false;
    renderCard();
    await screen.findAllByTestId("member-contacts-card-row");
    expect(screen.queryByTestId("member-contacts-card-remove")).toBeNull();
    expect(screen.queryByTestId("member-contacts-card-approve")).toBeNull();
  });
});

describe("C5-F03 聯絡人卡多「LINE 好友 / 預約通知 / 優惠通知」(唯讀)", () => {
  it("每位聯絡人顯示三個欄位;沒回 ⇒ 不確定 / 開(預設)", async () => {
    state.data = {
      ...TWO,
      contacts: [
        {
          ...TWO.contacts[0],
          line_friend_status: "not_friend",
          notify_booking: false,
          notify_promo: true,
        },
        {
          ...TWO.contacts[1],
          line_friend_status: "friend",
          notify_booking: true,
          notify_promo: false,
        },
      ],
    };
    renderCard();
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    expect(within(rows[0]!).getByTestId("member-contacts-card-notify")).toHaveTextContent(
      "LINE 好友：已加入・預約通知：開・優惠通知：關",
    );
    expect(within(rows[1]!).getByTestId("member-contacts-card-notify")).toHaveTextContent(
      "LINE 好友：未加入・預約通知：關・優惠通知：開",
    );
    // 唯讀:沒有任何開關;「優惠通知」5-B 起跟客人端一起顯示(PROMO_SWITCH_VISIBLE)。
    expect(screen.queryByRole("switch")).toBeNull();
    expect(PROMO_SWITCH_VISIBLE).toBe(true);
  });

  it("舊版回傳(沒有這三個欄位)⇒ 不確定 / 開", async () => {
    renderCard();
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    expect(within(rows[0]!).getByTestId("member-contacts-card-notify")).toHaveTextContent(
      "LINE 好友：不確定・預約通知：開・優惠通知：開",
    );
  });

  it("沒有聯絡人、用舊綁定碼綁過 LINE ⇒ 顯示 LINE 好友狀態", async () => {
    state.data = {
      contacts: [],
      requests: [],
      relink_blocked: false,
      legacy_line: { friend_status: "friend" },
    };
    renderCard();
    expect(await screen.findByTestId("member-contacts-card-legacy-friend")).toHaveTextContent(
      "LINE 好友：已加入",
    );
  });

  it("沒有聯絡人但有待處理申請 + 舊綁定碼 ⇒ 好友狀態跟申請列表各自顯示", async () => {
    state.data = {
      contacts: [],
      requests: TWO.requests,
      relink_blocked: false,
      legacy_line: { friend_status: "not_friend" },
    };
    renderCard();
    expect(await screen.findByTestId("member-contacts-card-legacy-friend")).toHaveTextContent(
      "LINE 好友：未加入",
    );
    expect(screen.getByTestId("member-contacts-card-requests")).toHaveTextContent("阿華");
    expect(screen.queryByTestId("member-contacts-card-empty")).toBeNull();
  });

  it("SPECS-INDEX #1025 FG-2:平台沒開 LINE 通知(showNotificationInfo=false)⇒ 聯絡人照常列出,但沒有好友 / 預約通知 / 優惠通知那一行", async () => {
    renderCard(false);
    const rows = await screen.findAllByTestId("member-contacts-card-row");
    expect(rows.length).toBe(2);
    expect(screen.queryByTestId("member-contacts-card-notify")).toBeNull();
  });

  it("SPECS-INDEX #1025 FG-2:平台沒開 LINE 通知 ⇒ 舊綁定碼會員的好友狀態也不顯示,待處理申請照常", async () => {
    state.data = {
      contacts: [],
      requests: TWO.requests,
      relink_blocked: false,
      legacy_line: { friend_status: "friend" },
    };
    renderCard(false);
    expect(await screen.findByTestId("member-contacts-card-requests")).toHaveTextContent("阿華");
    expect(screen.queryByTestId("member-contacts-card-legacy-friend")).toBeNull();
  });

  it("沒有聯絡人也沒綁過 ⇒ 不顯示好友狀態", async () => {
    state.data = { contacts: [], requests: [], relink_blocked: false, legacy_line: null };
    renderCard();
    await screen.findByTestId("member-contacts-card-empty");
    expect(screen.queryByTestId("member-contacts-card-legacy-friend")).toBeNull();
  });
});
