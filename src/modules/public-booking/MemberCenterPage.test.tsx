// 客戶端第 4 批 4-A:會員中心元件測試(狀態機、底部選單錢包規則、取消流程、我的資料生日鎖定)。
// 資料庫 / Edge Function 用假的頂著(真的接口在 e2e-local 驗,介面見 .project/notes/c4-contract.md)。

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
  bookings: {} as Record<string, unknown>,
  wallet: null as unknown,
  profile: null as unknown,
  cancelResults: [] as string[],
  cancelCalls: [] as string[],
  updateCalls: [] as unknown[],
  joinUrl: "https://access.line.me/oauth2/v2.1/authorize?client_id=1",
  redirects: [] as string[],
  toasts: [] as string[],
  signOutCalls: 0,
  profileCalls: [] as unknown[],
}));

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
    startLineJoin: vi.fn(async () => state.joinUrl),
    redirectToAuthorizeUrl: vi.fn((url: string) => {
      state.redirects.push(url);
    }),
    completeCustomerProfile: vi.fn(async (params: unknown) => {
      state.profileCalls.push(params);
      state.session = {
        state: "linked",
        memberName: "王小明",
        memberPhone: null,
        memberAddress: null,
      };
      return { kind: "linked", created: true, existing: false };
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
    fetchMyBookings: vi.fn(async (_slug: string, scope: string) =>
      logic.parseMemberBookingPage(state.bookings[scope]),
    ),
    fetchMyWallet: vi.fn(async () => logic.parseMemberWalletPage(state.wallet)),
    fetchMyProfile: vi.fn(async () => logic.parseMemberProfile(state.profile)),
    updateMyProfile: vi.fn(async (_slug: string, values: unknown) => {
      state.updateCalls.push(values);
      return "ok";
    }),
    cancelMyBooking: vi.fn(async (_slug: string, id: string) => {
      state.cancelCalls.push(id);
      return state.cancelResults.shift() ?? "server_error";
    }),
  };
});

// 4-B 聯絡人區塊(「我的資料」裡):這份測試只放「只有自己一位」;各種視角在 MemberContactsSection.test.tsx。
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
  const actual = await vi.importActual<typeof import("./memberContactsApi")>("./memberContactsApi");
  const logic =
    await vi.importActual<typeof import("./memberContactsLogic")>("./memberContactsLogic");
  return {
    ...actual,
    fetchMemberContacts: vi.fn(async () =>
      logic.parseMemberContacts({
        state: "ok",
        me: { contact_id: "c1", is_primary: true },
        contacts: [
          {
            id: "c1",
            line_display_name: "小明",
            line_picture_url: null,
            is_primary: true,
            is_me: true,
            contact_phone: null,
            joined_at: "2026-10-01T00:00:00Z",
          },
        ],
        requests: [],
        invites: [],
      }),
    ),
  };
});

const { default: MemberCenterPage } = await import("./MemberCenterPage");
const { putPendingDraft, takePendingDraft, LINE_LOGIN_ORIGIN_STORAGE_KEY } =
  await import("./customerLoginLogic");

function makePage(lineLoginEnabled = true): PublicBookingPage {
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
      line_login_enabled: lineLoginEnabled,
      customer_cancel_deadline_hours: 24,
    },
    member_policy: { enabled: true, content: "會員政策內容" },
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
};

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    start_at: "2099-10-13T02:00:00+00:00",
    end_at: "2099-10-13T03:00:00+00:00",
    status: "pending_confirmation",
    staff_display: "阿明",
    items: [{ name: "室內機清洗", quantity: 2 }],
    address: null,
    amount: 6200,
    points_redeemed: 0,
    booked_by: null,
    can_cancel: true,
    cancel_deadline_at: "2099-10-12T02:00:00+00:00",
    ...overrides,
  };
}

function home(pointsEnabled = true, next: unknown = view()) {
  return {
    state: "ok",
    member: { name: "王小明", is_primary: true, missing: ["birthday", "email", "address"] },
    next_booking: next,
    upcoming_count: next ? 1 : 0,
    wallet: {
      points_enabled: pointsEnabled,
      points_balance: pointsEnabled ? 320 : null,
      stored_value: null,
    },
    pending_contact_requests: 0,
  };
}

function PathProbe() {
  const loc = useLocation();
  return <p data-testid="path-probe">{`${loc.pathname}${loc.search}`}</p>;
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
          <Route path="/booking/:slug/me/bookings" element={<MemberCenterPage tab="bookings" />} />
          <Route path="/booking/:slug/me/wallet" element={<MemberCenterPage tab="wallet" />} />
          <Route path="/booking/:slug/me/profile" element={<MemberCenterPage tab="profile" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.page = makePage();
  state.session = { state: "anonymous" };
  state.home = home();
  state.bookings = {
    upcoming: {
      state: "ok",
      items: [view()],
      next_cursor: null,
      counts: { upcoming: 1, history: 0 },
    },
    history: { state: "ok", items: [], next_cursor: null, counts: { upcoming: 1, history: 0 } },
  };
  state.wallet = {
    state: "ok",
    points: {
      enabled: true,
      balance: 320,
      history: [
        {
          type: "referral_bonus",
          delta: 50,
          created_at: "2026-10-02T08:00:00Z",
          booking_summary: null,
        },
        {
          type: "redeem_booking",
          delta: -100,
          created_at: "2026-09-10T08:00:00Z",
          booking_summary: null,
        },
      ],
      next_cursor: null,
    },
    stored_value: null,
  };
  state.profile = {
    state: "ok",
    member: { name: "王小明", phone: "0912345678", birthday: null, address: null, email: null },
    me: {
      line_display_name: "小明",
      line_picture_url: null,
      is_primary: true,
      contact_phone: null,
    },
    can_edit: true,
  };
  state.cancelResults = [];
  state.cancelCalls = [];
  state.updateCalls = [];
  state.redirects = [];
  state.toasts = [];
  state.signOutCalls = 0;
  state.profileCalls = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  takePendingDraft("cool-shop");
});
afterEach(() => cleanup());

describe("C4-B02 / B03 狀態機", () => {
  it("沒啟用 LINE 登入 ⇒ 這間店目前沒有開放會員中心 + 聯絡 + 回店家首頁", async () => {
    state.page = makePage(false);
    renderAt("/booking/cool-shop/me");
    const closed = await screen.findByTestId("member-center-closed");
    expect(closed).toHaveTextContent("這間店目前沒有開放會員中心");
    expect(within(closed).getByTestId("public-booking-contacts")).toBeInTheDocument();
  });

  it("沒登入 ⇒ 登入頁;按 LINE 登入 ⇒ purpose join、記下從會員中心出發", async () => {
    renderAt("/booking/cool-shop/me/bookings");
    const login = await screen.findByTestId("member-center-login");
    expect(login).toHaveTextContent("登入「涼風工匠」會員中心");
    expect(login).toHaveTextContent("用 LINE 登入就能查看預約、取消預約、查看紅利點數。");
    await userEvent.setup().click(screen.getByTestId("member-center-login-button"));
    await waitFor(() => expect(state.redirects).toEqual([state.joinUrl]));
    expect(window.sessionStorage.getItem(LINE_LOGIN_ORIGIN_STORAGE_KEY)).toBe("member_center");
  });

  it("登入回來、已接上 ⇒ 會員中心首頁 + 提示「已登入」一次", async () => {
    state.session = LINKED;
    putPendingDraft("cool-shop", { outcome: "logged_in", draft: null });
    renderAt("/booking/cool-shop/me");
    expect(await screen.findByTestId("member-home-greeting")).toHaveTextContent("王小明，你好");
    await waitFor(() => expect(state.toasts).toEqual(["已登入「涼風工匠」會員中心"]));
  });

  it("登入回來、還沒接上 ⇒ ⑥-2「加入會員」⇒ 完成後會員中心首頁 + 提示「已加入」", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    putPendingDraft("cool-shop", { outcome: "logged_in", draft: null });
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me");
    expect(await screen.findByTestId("customer-profile")).toBeInTheDocument();
    expect(screen.getByTestId("customer-profile-submit")).toHaveTextContent("加入會員");
    expect(screen.queryByTestId("public-booking-step-label")).toBeNull();
    await user.type(screen.getByLabelText(/電話/), "0912345678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    await user.click(screen.getByTestId("customer-profile-submit"));
    expect(await screen.findByTestId("member-home-greeting")).toBeInTheDocument();
    expect(state.toasts).toEqual(["已加入「涼風工匠」會員"]);
    expect(state.profileCalls).toEqual([
      { slug: "cool-shop", phone: "0912345678", name: "", agreePolicy: true },
    ]);
  });

  it("會員中心函式回 not_linked ⇒ 登出、回登入頁", async () => {
    state.session = LINKED;
    state.home = { state: "not_linked" };
    renderAt("/booking/cool-shop/me");
    expect(await screen.findByTestId("member-center-login")).toBeInTheDocument();
    expect(state.signOutCalls).toBe(1);
    expect(screen.getByTestId("member-center-login-notice")).toHaveTextContent(
      "登入狀態已失效，請重新用 LINE 登入。",
    );
  });
});

describe("C4-C02 首頁 / C4-W01 底部選單", () => {
  it("首頁:最新的預約卡、補資料提示(略過後不再出現)、沒有 LINE 通知卡", async () => {
    state.session = LINKED;
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me");
    const next = await screen.findByTestId("member-home-next");
    expect(next).toHaveTextContent("最新的預約");
    expect(next).toHaveTextContent("待確認");
    expect(next).toHaveTextContent("室內機清洗 ×2");
    expect(next).toHaveTextContent("NT$ 6,200");
    expect(screen.getByTestId("member-home-missing")).toHaveTextContent("補上生日、地址和 Email");
    expect(document.body.textContent).not.toContain("LINE 通知");
    await user.click(screen.getByTestId("member-home-missing-skip"));
    expect(screen.queryByTestId("member-home-missing")).toBeNull();
    cleanup();
    renderAt("/booking/cool-shop/me");
    await screen.findByTestId("member-home-next");
    expect(screen.queryByTestId("member-home-missing")).toBeNull();
  });

  it("沒有預約 ⇒「目前沒有即將到來的預約」+「預約新的服務」", async () => {
    state.session = LINKED;
    state.home = home(true, null);
    renderAt("/booking/cool-shop/me");
    expect(await screen.findByTestId("member-home-empty")).toHaveTextContent(
      "目前沒有即將到來的預約",
    );
  });

  it("紅利有開 ⇒ 底部四格;紅利關掉 ⇒ 沒有「錢包」,直接打 /me/wallet 回 /me", async () => {
    state.session = LINKED;
    renderAt("/booking/cool-shop/me");
    await screen.findByTestId("member-nav-wallet");
    expect(screen.getByTestId("member-center-nav")).toHaveTextContent("首頁我的預約錢包我的資料");
    cleanup();
    state.home = home(false);
    renderAt("/booking/cool-shop/me/wallet");
    await waitFor(() =>
      expect(screen.getByTestId("path-probe")).toHaveTextContent(/^\/booking\/cool-shop\/me$/),
    );
    await screen.findByTestId("member-nav-home");
    expect(screen.queryByTestId("member-nav-wallet")).toBeNull();
  });
});

describe("C4-C04 / D06 我的預約與取消", () => {
  it("可以取消 ⇒ 期限文字 + 取消預約;確認窗逐字;成功 ⇒ toast + 重讀", async () => {
    state.session = LINKED;
    state.cancelResults = ["cancelled"];
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/bookings");
    expect(await screen.findByTestId("member-booking-deadline")).toHaveTextContent(
      "10月12日 10:00 以前可以取消",
    );
    expect(screen.getByTestId("member-bookings-tab-upcoming")).toHaveTextContent("即將到來1");
    await user.click(screen.getByTestId("member-booking-cancel"));
    const dialog = await screen.findByTestId("member-cancel-dialog");
    expect(dialog).toHaveTextContent("確定要取消 10月13日（二）10:00 的預約嗎？");
    expect(dialog).toHaveTextContent(
      "取消後這個時段會開放給其他人預約，店家也會收到通知。想改時間的話，請取消後重新預約。",
    );
    expect(within(dialog).getByTestId("member-cancel-keep")).toHaveTextContent("先不要");
    await user.click(within(dialog).getByTestId("member-cancel-confirm"));
    await waitFor(() => expect(state.toasts).toEqual(["已取消預約"]));
    expect(state.cancelCalls).toEqual(["b1"]);
    await waitFor(() => expect(screen.queryByTestId("member-cancel-dialog")).toBeNull());
  });

  it("期限過了 ⇒ 沒有取消鈕,改成聯絡店家", async () => {
    state.session = LINKED;
    state.bookings["upcoming"] = {
      state: "ok",
      items: [view({ can_cancel: false })],
      next_cursor: null,
      counts: { upcoming: 1, history: 0 },
    };
    renderAt("/booking/cool-shop/me/bookings");
    expect(await screen.findByTestId("member-booking-no-cancel")).toHaveTextContent(
      "服務前 24 小時內不能線上取消，請直接聯絡店家",
    );
    expect(screen.queryByTestId("member-booking-cancel")).toBeNull();
  });

  it("按確定時伺服器說期限過了 ⇒ 關窗,清單上方說明 + 聯絡按鈕;500 ⇒ 保留視窗", async () => {
    state.session = LINKED;
    state.cancelResults = ["server_error", "deadline_passed"];
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/bookings");
    await user.click(await screen.findByTestId("member-booking-cancel"));
    await user.click(await screen.findByTestId("member-cancel-confirm"));
    expect(await screen.findByTestId("member-cancel-error")).toHaveTextContent(
      "取消時發生問題，請稍後再試。",
    );
    await user.click(screen.getByTestId("member-cancel-confirm"));
    const notice = await screen.findByTestId("member-bookings-notice");
    expect(notice).toHaveTextContent("已經超過可以線上取消的時間，請直接聯絡店家。");
    expect(within(notice).getByTestId("public-booking-contacts")).toBeInTheDocument();
  });

  it("歷史分頁:網址 ?tab=history、空狀態「還沒有任何紀錄」", async () => {
    state.session = LINKED;
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/bookings");
    await screen.findByTestId("member-booking-card");
    await user.click(screen.getByTestId("member-bookings-tab-history"));
    expect(await screen.findByTestId("member-bookings-empty")).toHaveTextContent("還沒有任何紀錄");
    expect(screen.getByTestId("path-probe")).toHaveTextContent("?tab=history");
  });
});

describe("C4-W03 錢包", () => {
  it("餘額 + 明細(推薦類顯示「活動贈點」、負數用減號)", async () => {
    state.session = LINKED;
    renderAt("/booking/cool-shop/me/wallet");
    expect(await screen.findByTestId("member-wallet-balance")).toHaveTextContent("320");
    const entries = screen.getAllByTestId("member-wallet-entry");
    expect(entries[0]).toHaveTextContent("活動贈點");
    expect(entries[0]).toHaveTextContent("+50");
    expect(entries[1]).toHaveTextContent("折抵消費");
    expect(entries[1]).toHaveTextContent("−100");
    expect(document.body.textContent).not.toContain("推薦");
  });
});

describe("C4-E02 我的資料", () => {
  it("手機唯讀;沒改 ⇒ 儲存停用 + 常駐 !;第一次填生日 ⇒ 提醒;存檔送四欄", async () => {
    state.session = LINKED;
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    const phone = await screen.findByTestId("member-profile-phone");
    expect(phone).toHaveTextContent("手機號碼不能自行修改，要更換請聯絡店家。");
    expect(screen.getByTestId("member-profile-save")).toBeDisabled();
    expect(screen.getByTestId("member-profile-unchanged")).toHaveTextContent("還沒有修改任何資料");
    expect(screen.getByTestId("member-profile-line")).toHaveTextContent("LINE 帳號");
    expect(screen.getByTestId("member-profile-line")).toHaveTextContent("已綁定");
    expect(document.body.textContent).not.toContain("通知");
    await user.type(screen.getByLabelText("地址"), "台北市松仁路 58 號");
    expect(screen.getByTestId("member-profile-save")).toBeEnabled();
    expect(screen.queryByTestId("member-profile-unchanged")).toBeNull();
    await user.click(screen.getByTestId("member-profile-save"));
    await waitFor(() => expect(state.toasts).toContain("已儲存會員資料"));
    expect(state.updateCalls[0]).toEqual({
      name: "王小明",
      birthday: "",
      address: "台北市松仁路 58 號",
      email: "",
    });
    // 會員政策 / 隱私權政策 / 登出
    expect(screen.getByTestId("member-profile-policy")).toHaveTextContent("會員政策");
    expect(screen.getByTestId("member-profile-links")).toHaveTextContent("隱私權政策");
    expect(screen.getByTestId("member-profile-logout")).toHaveTextContent("登出");
  });

  it("生日已經有值 ⇒ 唯讀 + 說明(Q3 = A)", async () => {
    state.session = LINKED;
    state.profile = {
      ...(state.profile as Record<string, unknown>),
      member: {
        name: "王小明",
        phone: "0912345678",
        birthday: "1990-05-01",
        address: null,
        email: null,
      },
    };
    renderAt("/booking/cool-shop/me/profile");
    const locked = await screen.findByTestId("member-profile-birthday-locked");
    expect(locked).toHaveTextContent("1990-05-01");
    expect(locked).toHaveTextContent("生日填寫後不能自行修改，要更改請聯絡店家。");
    expect(screen.queryByLabelText("生日")).toBeNull();
  });

  it("登出 ⇒ 只登出客戶 client、回登入頁", async () => {
    state.session = LINKED;
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/me/profile");
    await user.click(await screen.findByTestId("member-profile-logout"));
    expect(await screen.findByTestId("member-center-login")).toBeInTheDocument();
    expect(state.signOutCalls).toBe(1);
  });
});
