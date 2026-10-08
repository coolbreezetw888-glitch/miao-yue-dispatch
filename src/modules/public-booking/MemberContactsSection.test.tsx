// 客戶端第 4 批 4-B(#1041):會員中心的「多位聯絡人」元件測試 ——
//   狀態機(join_pending / 申請被拒)、首頁申請提示、「我的資料」主要 / 第二聯絡人兩種視角、
//   邀請連結(複製 / 用 LINE 傳送)、移除 / 轉移 / 退出確認窗、第二聯絡人自己的電話、純文字顯示。
// 資料庫用假的頂著(真的接口在 e2e-local c4b-contacts 驗,介面見 .project/notes/c4-contract.md 4-B)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBookingPage } from "./types";

const state = vi.hoisted(() => ({
  page: null as unknown,
  session: { state: "anonymous" } as unknown,
  home: null as unknown,
  profile: null as unknown,
  contacts: null as unknown,
  calls: [] as unknown[][],
  results: {} as Record<string, unknown[]>,
  toasts: [] as string[],
  signOutCalls: 0,
}));

function nextResult(fn: string, fallback: unknown): unknown {
  const list = state.results[fn];
  return list && list.length > 0 ? list.shift() : fallback;
}

vi.mock("sonner", () => ({
  toast: Object.assign((msg: string) => state.toasts.push(msg), {
    success: (msg: string) => state.toasts.push(msg),
    error: (msg: string) => state.toasts.push(msg),
  }),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, fetchPublicBookingPage: vi.fn(async () => state.page) };
});

vi.mock("./customerAuthApi", async () => {
  const actual = await vi.importActual<typeof import("./customerAuthApi")>("./customerAuthApi");
  return {
    ...actual,
    fetchCustomerSessionState: vi.fn(async () => state.session),
    completeCustomerProfile: vi.fn(async (params: unknown) => {
      state.calls.push(["completeCustomerProfile", params]);
      const r = nextResult("completeCustomerProfile", { kind: "join_pending" }) as {
        kind: string;
      };
      if (r.kind === "join_pending") {
        state.session = { state: "join_pending", lineDisplayName: "小李", linePictureUrl: null };
      }
      return r;
    }),
    signOutCustomer: vi.fn(async () => {
      state.signOutCalls += 1;
      state.session = { state: "anonymous" };
    }),
  };
});

vi.mock("./memberCenterApi", async () => {
  const actual = await vi.importActual<typeof import("./memberCenterApi")>("./memberCenterApi");
  const logic = await vi.importActual<typeof import("./memberCenterLogic")>("./memberCenterLogic");
  return {
    ...actual,
    fetchMemberHome: vi.fn(async () => logic.parseMemberHome(state.home)),
    fetchMyProfile: vi.fn(async () => logic.parseMemberProfile(state.profile)),
  };
});

// 第 5 批 C5-M02:我的資料多「LINE 通知」區塊;這份測試不測它(店家不能用 LINE 通知 ⇒ 不顯示),
// 各種情況在 MemberLineNotify.test.tsx。
vi.mock("./lineNotifyApi", async () => {
  const actual = await vi.importActual<typeof import("./lineNotifyApi")>("./lineNotifyApi");
  const logic = await vi.importActual<typeof import("./lineNotifyLogic")>("./lineNotifyLogic");
  const unavailable = logic.parseMemberNotifyPrefs({ state: "ok", available: false });
  return {
    ...actual,
    fetchMyNotifyPrefs: vi.fn(async () => unavailable),
    setMyNotifyPrefs: vi.fn(async () => unavailable),
  };
});

vi.mock("./memberContactsApi", async () => {
  const logic =
    await vi.importActual<typeof import("./memberContactsLogic")>("./memberContactsLogic");
  const record =
    (fn: string, fallback: unknown) =>
    async (...args: unknown[]) => {
      state.calls.push([fn, ...args]);
      return nextResult(fn, fallback);
    };
  return {
    fetchMemberContacts: vi.fn(async () => logic.parseMemberContacts(state.contacts)),
    createContactInvite: vi.fn(async (slug: string) => {
      state.calls.push(["createContactInvite", slug]);
      return logic.parseCreateInviteResult(
        nextResult("createContactInvite", {
          state: "ok",
          invite: {
            id: "i9",
            created_at: "2026-10-09T01:00:00Z",
            expires_at: "2026-10-12T06:00:00Z",
          },
          path: `/booking/cool-shop/invite/${"A".repeat(32)}`,
        }),
        slug,
        window.location.origin,
      );
    }),
    revokeContactInvite: vi.fn(record("revokeContactInvite", { state: "ok" })),
    resolveContactRequest: vi.fn(record("resolveContactRequest", { state: "approved" })),
    removeContact: vi.fn(record("removeContact", { state: "ok" })),
    leaveMember: vi.fn(record("leaveMember", { state: "ok" })),
    transferPrimary: vi.fn(record("transferPrimary", { state: "ok" })),
    setMyContactPhone: vi.fn(async (...args: unknown[]) => {
      state.calls.push(["setMyContactPhone", ...args]);
      return logic.parseSetMyPhoneResult(
        nextResult("setMyContactPhone", { state: "ok", contact_phone: "0933111222" }),
      );
    }),
    cancelMyJoinRequest: vi.fn(async (slug: string) => {
      state.calls.push(["cancelMyJoinRequest", slug]);
      state.session = {
        state: "needs_profile",
        lineDisplayName: "小李",
        linePictureUrl: null,
        joinRequest: null,
      };
    }),
  };
});

const { default: MemberCenterPage } = await import("./MemberCenterPage");

function makePage(): PublicBookingPage {
  return {
    status: "ok",
    merchant: {
      name: "涼風工匠",
      industry_type: "on_site_dispatch",
      logo_url: null,
      address: null,
      phone: "02-1234-5678",
      intro: null,
      theme_preset: null,
      theme_custom_color: null,
      announcement: null,
      line_friend_url: "https://lin.ee/abc",
    },
    booking_settings: {
      allow_guest_booking: true,
      is_on_site: true,
      line_login_enabled: true,
      customer_cancel_deadline_hours: 24,
    },
    member_policy: { enabled: false, content: null },
    categories: [],
    service_items: [],
    staff: [],
  };
}

const LINKED = {
  state: "linked",
  memberName: "王小明",
  memberPhone: "0912345678",
  memberAddress: null,
  isPrimary: true,
};

function home(isPrimary: boolean, pending: number) {
  return {
    state: "ok",
    member: { name: "王小明", is_primary: isPrimary, missing: ["birthday"] },
    next_booking: null,
    upcoming_count: 0,
    wallet: { points_enabled: false, points_balance: null, stored_value: null },
    pending_contact_requests: pending,
  };
}

function profile(isPrimary: boolean, name = "王小明") {
  return {
    state: "ok",
    member: { name, phone: "0912345678", birthday: null, address: "台北市", email: null },
    me: {
      line_display_name: isPrimary ? "小明" : "小李",
      line_picture_url: null,
      is_primary: isPrimary,
      contact_phone: isPrimary ? null : "0933111222",
    },
    can_edit: isPrimary,
  };
}

function contact(overrides: Record<string, unknown>) {
  return {
    id: "c1",
    line_display_name: "小明",
    line_picture_url: null,
    is_primary: true,
    is_me: true,
    contact_phone: null,
    joined_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const PRIMARY_VIEW = {
  state: "ok",
  me: { contact_id: "c1", is_primary: true },
  contacts: [
    contact({}),
    contact({
      id: "c2",
      line_display_name: "小李",
      is_primary: false,
      is_me: false,
      contact_phone: "0933111222",
    }),
  ],
  requests: [
    {
      id: "r1",
      line_display_name: "阿華",
      line_picture_url: null,
      phone: "0912345678",
      created_at: "2026-10-08T02:00:00Z",
    },
  ],
  invites: [{ id: "i1", created_at: "2026-10-08T00:00:00Z", expires_at: "2026-10-11T06:00:00Z" }],
  limits: { max_contacts: 10, max_invites: 5 },
};

const SECONDARY_VIEW = {
  state: "ok",
  me: { contact_id: "c2", is_primary: false },
  contacts: [
    contact({ is_me: false, contact_phone: null }),
    contact({
      id: "c2",
      line_display_name: "小李",
      is_primary: false,
      is_me: true,
      contact_phone: "0933111222",
    }),
    contact({ id: "c3", line_display_name: "阿美", is_primary: false, is_me: false }),
  ],
  requests: [],
  invites: [],
};

function PathProbe() {
  const loc = useLocation();
  return <p data-testid="path-probe">{`${loc.pathname}${loc.hash}`}</p>;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <PathProbe />
        <Routes>
          <Route path="/booking/:slug" element={<p data-testid="booking-home-probe" />} />
          <Route path="/booking/:slug/me" element={<MemberCenterPage tab="home" />} />
          <Route path="/booking/:slug/me/profile" element={<MemberCenterPage tab="profile" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.page = makePage();
  state.session = LINKED;
  state.home = home(true, 0);
  state.profile = profile(true);
  state.contacts = PRIMARY_VIEW;
  state.calls = [];
  state.results = {};
  state.toasts = [];
  state.signOutCalls = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

const calls = (fn: string) => state.calls.filter((c) => c[0] === fn);

describe("C4-H04 加入聯絡人申請(join_pending)", () => {
  it("填了別人會員的電話 ⇒「申請已送出」畫面;不帶會員資料;「改用其他電話」⇒ 取消申請回 ⑥-2", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me");
    await user.type(await screen.findByLabelText(/電話/), "0912345678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    await user.click(screen.getByTestId("customer-profile-submit"));
    const pending = await screen.findByTestId("customer-join-pending");
    expect(pending).toHaveTextContent(
      "這支電話已經是會員。主要聯絡人打開會員中心時會看到你的申請，同意後你就能使用會員中心。",
    );
    expect(pending).not.toHaveTextContent("王小明");
    expect(within(pending).getByTestId("public-booking-contacts")).toBeInTheDocument();
    // 會員中心不是預約流程 ⇒ 沒有「不登入，直接預約」
    expect(screen.queryByTestId("customer-join-pending-guest")).toBeNull();
    await user.click(screen.getByTestId("customer-join-pending-other-phone"));
    expect(await screen.findByTestId("customer-profile")).toBeInTheDocument();
    expect(calls("cancelMyJoinRequest")).toHaveLength(1);
  });

  it("重新打開時登入狀態是 join_pending ⇒ 直接顯示同一個畫面", async () => {
    state.session = { state: "join_pending", lineDisplayName: "小李", linePictureUrl: null };
    renderAt("/booking/cool-shop/me/profile");
    expect(await screen.findByTestId("customer-join-pending")).toBeInTheDocument();
  });

  it.each([
    ["rejected", "主要聯絡人沒有同意你的申請，請改用其他電話，或聯絡店家。"],
    ["expired", "你的申請已經過期，請重新填寫電話，或聯絡店家。"],
  ])("申請被%s ⇒ ⑥-2 上方說明 + 聯絡按鈕", async (status, text) => {
    state.session = {
      state: "needs_profile",
      lineDisplayName: "小李",
      linePictureUrl: null,
      joinRequest: status,
    };
    renderAt("/booking/cool-shop/me");
    const note = await screen.findByTestId(`customer-join-${status}`);
    expect(note).toHaveTextContent(text);
    expect(within(note).getByTestId("public-booking-contacts")).toBeInTheDocument();
  });
});

describe("C4-C02 首頁申請提示", () => {
  it("主要聯絡人有待處理申請 ⇒ 黃色提示卡 +「去處理」到我的資料 · 聯絡人", async () => {
    state.home = home(true, 2);
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me");
    const card = await screen.findByTestId("member-home-requests");
    expect(card).toHaveTextContent("有 2 位想加入成為聯絡人");
    await user.click(within(card).getByTestId("member-home-requests-go"));
    await waitFor(() =>
      expect(screen.getByTestId("path-probe")).toHaveTextContent(
        "/booking/cool-shop/me/profile#contacts",
      ),
    );
  });

  it("第二聯絡人 ⇒ 沒有申請提示(伺服器回 0 也不顯示)、也沒有「補上生日」卡", async () => {
    state.home = home(false, 3);
    renderAt("/booking/cool-shop/me");
    await screen.findByTestId("member-home-greeting");
    expect(screen.queryByTestId("member-home-requests")).toBeNull();
    expect(screen.queryByTestId("member-home-missing")).toBeNull();
  });
});

describe("C4-H09 聯絡人區塊:主要聯絡人", () => {
  it("清單(含第二聯絡人電話)、申請、有效邀請;同意 / 撤銷", async () => {
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    const section = await screen.findByTestId("member-contacts-primary");
    const rows = within(section).getAllByTestId("member-contact-row");
    expect(rows[0]).toHaveTextContent("小明");
    expect(rows[0]).toHaveTextContent("主要聯絡人");
    expect(rows[0]).toHaveTextContent("（你）");
    expect(rows[1]).toHaveTextContent("小李");
    expect(rows[1]).toHaveTextContent("0933111222");
    // 主要聯絡人有其他聯絡人 ⇒ 不能退出,常駐 !
    expect(within(rows[0]!).getByTestId("member-contact-leave-blocked")).toHaveTextContent(
      "請先把主要聯絡人轉給別人，才能退出。",
    );
    const request = within(section).getByTestId("member-contact-request");
    expect(request).toHaveTextContent("阿華");
    expect(request).toHaveTextContent("0912345678");
    await user.click(within(request).getByTestId("member-contact-request-approve"));
    await waitFor(() => expect(state.toasts).toContain("已同意，對方已加入成為聯絡人"));
    expect(calls("resolveContactRequest")[0]).toEqual([
      "resolveContactRequest",
      "cool-shop",
      "r1",
      true,
    ]);
    expect(within(section).getByTestId("member-contact-invite")).toHaveTextContent("前有效");
    await user.click(within(section).getByTestId("member-contact-invite-revoke"));
    await waitFor(() => expect(state.toasts).toContain("已撤銷邀請連結"));
    expect(calls("revokeContactInvite")[0]).toEqual(["revokeContactInvite", "cool-shop", "i1"]);
  });

  it("申請人已經是別的會員的聯絡人 ⇒ 固定句子,不顯示伺服器原文", async () => {
    state.results["resolveContactRequest"] = [{ state: "already_member_elsewhere" }];
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    await user.click(await screen.findByTestId("member-contact-request-approve"));
    expect(await screen.findByTestId("member-contacts-notice")).toHaveTextContent(
      "這位申請人已經是這間店另一位會員的聯絡人，不能加入。",
    );
  });

  it("邀請聯絡人 ⇒ 訊息逐字、網址用本站 + path、「用 LINE 傳送」是 LINE 官方分享網址", async () => {
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    await user.click(await screen.findByTestId("member-contacts-invite"));
    const panel = await screen.findByTestId("member-contacts-invite-panel");
    const url = `${window.location.origin}/booking/cool-shop/invite/${"A".repeat(32)}`;
    const message = `邀請你成為「涼風工匠」會員「王小明」的聯絡人：${url}（72 小時內有效）`;
    expect(within(panel).getByTestId("member-contacts-invite-message")).toHaveTextContent(message);
    expect(within(panel).getByTestId("member-contacts-invite-line")).toHaveAttribute(
      "href",
      `https://line.me/R/share?text=${encodeURIComponent(message)}`,
    );
  });

  it("已經 10 位聯絡人 ⇒「邀請聯絡人」停用 + 常駐 !", async () => {
    state.contacts = {
      ...PRIMARY_VIEW,
      contacts: Array.from({ length: 10 }, (_, i) =>
        contact({ id: `c${i}`, is_primary: i === 0, is_me: i === 0, line_display_name: `人${i}` }),
      ),
    };
    renderAt("/booking/cool-shop/me/profile");
    expect(await screen.findByTestId("member-contacts-invite-blocked")).toHaveTextContent(
      "每位會員最多 10 位聯絡人",
    );
    expect(screen.getByTestId("member-contacts-invite")).toBeDisabled();
  });

  it("設為主要聯絡人 ⇒ 確認窗逐字 ⇒ 轉移;移除 ⇒ 確認窗 ⇒ 移除", async () => {
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    await user.click(await screen.findByTestId("member-contact-transfer"));
    const dialog = await screen.findByTestId("member-contacts-confirm");
    expect(dialog).toHaveTextContent(
      "把主要聯絡人轉給 小李 嗎？轉移後只有 小李 可以修改會員資料、管理聯絡人。",
    );
    // 轉移主要 ⇒ 主要樣式(不是危險)
    expect(within(dialog).getByTestId("member-contacts-confirm-ok")).not.toHaveClass(
      /text-destructive/,
    );
    await user.click(within(dialog).getByTestId("member-contacts-confirm-ok"));
    await waitFor(() => expect(state.toasts).toContain("已轉移主要聯絡人"));
    expect(calls("transferPrimary")[0]).toEqual(["transferPrimary", "cool-shop", "c2"]);
    await waitFor(() => expect(screen.queryByTestId("member-contacts-confirm")).toBeNull());
    await user.click(screen.getByTestId("member-contact-remove"));
    const removeOk = within(await screen.findByTestId("member-contacts-confirm")).getByTestId(
      "member-contacts-confirm-ok",
    );
    // QA 低-3:移除會連帶封鎖 ⇒ 危險樣式(白底紅字淡紅框)
    expect(removeOk).toHaveClass(/text-destructive/);
    expect(removeOk).toHaveClass(/bg-background/);
    await user.click(removeOk);
    await waitFor(() => expect(state.toasts).toContain("已移除這位聯絡人"));
    expect(calls("removeContact")[0]).toEqual(["removeContact", "cool-shop", "c2"]);
  });

  it("只有自己一位 ⇒「目前只有你一位聯絡人」+「邀請聯絡人」", async () => {
    state.contacts = { ...PRIMARY_VIEW, contacts: [contact({})], requests: [], invites: [] };
    renderAt("/booking/cool-shop/me/profile");
    const solo = await screen.findByTestId("member-contacts-solo");
    expect(solo).toHaveTextContent("目前只有你一位聯絡人");
    expect(within(solo).getByTestId("member-contacts-invite")).toBeEnabled();
  });
});

describe("C4-H09 聯絡人區塊:第二聯絡人", () => {
  beforeEach(() => {
    state.profile = profile(false);
    state.contacts = SECONDARY_VIEW;
    state.home = home(false, 0);
  });

  it("會員資料唯讀 + 說明;看不到別人的電話、沒有管理按鈕;自己那列「退出」", async () => {
    renderAt("/booking/cool-shop/me/profile");
    expect(await screen.findByTestId("member-profile-readonly")).toHaveTextContent(
      "只有主要聯絡人可以修改會員資料。",
    );
    expect(screen.queryByTestId("member-profile-save")).toBeNull();
    const section = await screen.findByTestId("member-contacts-secondary");
    expect(within(section).queryByTestId("member-contact-transfer")).toBeNull();
    expect(within(section).queryByTestId("member-contact-remove")).toBeNull();
    expect(within(section).queryByTestId("member-contacts-invite")).toBeNull();
    expect(within(section).queryByTestId("member-contacts-requests")).toBeNull();
    const rows = within(section).getAllByTestId("member-contact-row");
    expect(rows).toHaveLength(3);
    expect(rows[2]).not.toHaveTextContent(/09\d{8}/);
    expect(within(rows[1]!).getByTestId("member-contact-leave")).toBeInTheDocument();
  });

  it("退出 ⇒ 確認窗 ⇒ 等於登出,回會員中心登入頁", async () => {
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    await user.click(await screen.findByTestId("member-contact-leave"));
    const dialog = await screen.findByTestId("member-contacts-confirm");
    expect(dialog).toHaveTextContent("退出後你的 LINE 不能再查看這位會員的預約");
    expect(within(dialog).getByTestId("member-contacts-confirm-ok")).not.toHaveClass(
      /text-destructive/,
    );
    await user.click(within(dialog).getByTestId("member-contacts-confirm-ok"));
    expect(await screen.findByTestId("member-center-login")).toBeInTheDocument();
    expect(state.signOutCalls).toBe(1);
    expect(calls("leaveMember")).toHaveLength(1);
  });

  it("我的電話:沒改 ⇒ 停用;這支電話是別的會員 ⇒ 固定句子;清空 ⇒ 送 空字串", async () => {
    state.results["setMyContactPhone"] = [{ state: "phone_in_use" }];
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    const form = await screen.findByTestId("member-contacts-my-phone");
    expect(within(form).getByTestId("member-contacts-my-phone-save")).toBeDisabled();
    const input = within(form).getByLabelText("我的電話");
    expect(input).toHaveValue("0933111222");
    await user.clear(input);
    await user.type(input, "0922000111");
    await user.click(within(form).getByTestId("member-contacts-my-phone-save"));
    expect(await screen.findByTestId("member-contacts-my-phone-message")).toHaveTextContent(
      "這支電話已經是其他會員的電話，沒有加上。",
    );
    expect(calls("setMyContactPhone")[0]).toEqual(["setMyContactPhone", "cool-shop", "0922000111"]);
    await user.clear(input);
    await user.click(within(form).getByTestId("member-contacts-my-phone-save"));
    await waitFor(() => expect(state.toasts).toContain("已清除你的電話"));
    expect(calls("setMyContactPhone")[1]).toEqual(["setMyContactPhone", "cool-shop", ""]);
  });
});

describe("C4-F05 客人可輸入的文字一律純文字(QA 4-A 低項)", () => {
  it("會員姓名、LINE 顯示名是 <script> ⇒ 原樣顯示文字,不產生 script 元素", async () => {
    const evil = "<script>window.__pwned=1</script>";
    state.profile = profile(false, evil);
    state.contacts = {
      ...SECONDARY_VIEW,
      contacts: [contact({ is_me: false, line_display_name: `<img src=x onerror=alert(1)>` })],
    };
    state.home = { ...home(false, 0), member: { name: evil, is_primary: false, missing: [] } };
    renderAt("/booking/cool-shop/me/profile");
    const readonly = await screen.findByTestId("member-profile-readonly");
    expect(readonly).toHaveTextContent(evil);
    expect(await screen.findByTestId("member-contacts-list")).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    cleanup();
    renderAt("/booking/cool-shop/me");
    expect(await screen.findByTestId("member-home-greeting")).toHaveTextContent(`${evil}，你好`);
    expect(document.querySelector("script")).toBeNull();
  });
});
