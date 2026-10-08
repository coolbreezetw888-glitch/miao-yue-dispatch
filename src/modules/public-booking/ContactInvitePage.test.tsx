// 客戶端第 4 批 4-B(C4-H06 / H07 / F04):聯絡人邀請落地頁。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBookingPage } from "./types";

const TOKEN = "Inv1te_Token-0123456789abcdefghijkl";

const state = vi.hoisted(() => ({
  page: null as unknown,
  session: { state: "anonymous" } as unknown,
  peek: { state: "valid", merchantName: "涼風工匠" } as unknown,
  peekCalls: [] as unknown[],
  startCalls: [] as unknown[],
  redirects: [] as string[],
  acceptCalls: [] as unknown[],
  acceptResult: { state: "linked", phoneResult: "none" } as unknown,
  toasts: [] as string[],
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
    startLineInvite: vi.fn(async (slug: string, token: string) => {
      state.startCalls.push({ slug, token });
      return "https://access.line.me/oauth2/v2.1/authorize?client_id=1";
    }),
    redirectToAuthorizeUrl: vi.fn((url: string) => state.redirects.push(url)),
    signOutCustomer: vi.fn(async () => {
      state.session = { state: "anonymous" };
    }),
  };
});

vi.mock("./memberContactsApi", () => ({
  peekContactInvite: vi.fn(async (slug: string, token: string) => {
    state.peekCalls.push({ slug, token });
    return state.peek;
  }),
  acceptContactInvite: vi.fn(async (params: unknown) => {
    state.acceptCalls.push(params);
    return state.acceptResult;
  }),
}));

const { default: ContactInvitePage } = await import("./ContactInvitePage");
const { clearPendingInvite, putClaimedInvite } = await import("./memberContactsLogic");

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
      line_friend_url: null,
    },
    booking_settings: {
      allow_guest_booking: true,
      is_on_site: true,
      line_login_enabled: lineLoginEnabled,
      customer_cancel_deadline_hours: 24,
    },
    member_policy: { enabled: false, content: null },
    categories: [],
    service_items: [],
    staff: [],
  };
}

function Probe() {
  const loc = useLocation();
  return <p data-testid="path-probe">{loc.pathname}</p>;
}

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Probe />
        <Routes>
          <Route path="/booking/:slug/invite" element={<ContactInvitePage />} />
          <Route path="/booking/:slug/invite/:token" element={<ContactInvitePage />} />
          <Route path="/booking/:slug/me" element={<p data-testid="member-center-probe" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.page = makePage();
  state.session = { state: "anonymous" };
  state.peek = { state: "valid", merchantName: "涼風工匠" };
  state.peekCalls = [];
  state.startCalls = [];
  state.redirects = [];
  state.acceptCalls = [];
  state.acceptResult = { state: "linked", phoneResult: "none" };
  state.toasts = [];
  clearPendingInvite("cool-shop");
});
afterEach(() => cleanup());

describe("C4-H06 邀請落地頁", () => {
  it("一進來就把邀請碼從網址列拿掉;沒登入 ⇒ 說明 +「用 LINE 登入並加入」(purpose invite)", async () => {
    renderAt(`/booking/cool-shop/invite/${TOKEN}`);
    expect(window.location.pathname).toBe("/booking/cool-shop/invite");
    const landing = await screen.findByTestId("contact-invite-landing");
    expect(landing).toHaveTextContent("你被邀請成為「涼風工匠」會員的聯絡人");
    expect(landing).toHaveTextContent("加入後可以一起查看預約、取消預約、查看紅利點數。");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(state.peekCalls).toEqual([{ slug: "cool-shop", token: TOKEN }]);
    await userEvent.setup().click(screen.getByTestId("contact-invite-login"));
    await waitFor(() => expect(state.redirects).toHaveLength(1));
    expect(state.startCalls).toEqual([{ slug: "cool-shop", token: TOKEN }]);
  });

  it("邀請無效 ⇒ 固定句子(不分過期 / 用過 / 撤銷)", async () => {
    state.peek = { state: "invalid" };
    renderAt(`/booking/cool-shop/invite/${TOKEN}`);
    expect(await screen.findByTestId("contact-invite-invalid")).toHaveTextContent(
      "這個邀請連結已經失效，請向主要聯絡人索取新的連結。",
    );
  });

  it("重新整理(記憶體沒有邀請碼)⇒ 請重新打開邀請連結", async () => {
    renderAt("/booking/cool-shop/invite");
    expect(await screen.findByTestId("contact-invite-invalid")).toHaveTextContent(
      "請重新打開邀請連結再試一次。",
    );
  });

  it("店家沒啟用 LINE 登入 ⇒ 無效", async () => {
    state.page = makePage(false);
    renderAt(`/booking/cool-shop/invite/${TOKEN}`);
    expect(await screen.findByTestId("contact-invite-invalid")).toBeInTheDocument();
  });
});

describe("C4-H07 接受邀請", () => {
  it("從 LINE 登入回來(已保留)⇒ 勾同意 + 電話選填 ⇒ p_token 傳 null ⇒ 到會員中心", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    putClaimedInvite("cool-shop", true);
    const user = userEvent.setup();
    renderAt("/booking/cool-shop/invite");
    const screenEl = await screen.findByTestId("contact-invite-accept-screen");
    expect(screenEl).toHaveTextContent("店家可以用這支電話找到你們的會員資料。");
    expect(screen.getByTestId("contact-invite-accept")).toBeDisabled();
    expect(screen.getByTestId("contact-invite-blocked")).toHaveTextContent("請先勾選同意");
    await user.click(screen.getByTestId("contact-invite-consent"));
    await user.click(screen.getByTestId("contact-invite-accept"));
    expect(await screen.findByTestId("member-center-probe")).toBeInTheDocument();
    expect(state.acceptCalls).toEqual([
      { slug: "cool-shop", token: null, phone: "", agreePolicy: true },
    ]);
    expect(state.peekCalls).toEqual([]);
    expect(state.toasts).toEqual(["已加入「涼風工匠」會員"]);
  });

  it("已經登入、直接點邀請連結 ⇒ 帶邀請碼接受;電話是別人的 ⇒ 加入照樣成功 + 提示", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    state.acceptResult = { state: "linked", phoneResult: "in_use" };
    const user = userEvent.setup();
    renderAt(`/booking/cool-shop/invite/${TOKEN}`);
    await user.type(await screen.findByLabelText(/你的電話/), "0912345678");
    await user.click(screen.getByTestId("contact-invite-consent"));
    await user.click(screen.getByTestId("contact-invite-accept"));
    await screen.findByTestId("member-center-probe");
    expect(state.acceptCalls[0]).toEqual({
      slug: "cool-shop",
      token: TOKEN,
      phone: "0912345678",
      agreePolicy: true,
    });
    expect(state.toasts).toContain("這支電話已經是其他會員的電話，沒有加上。");
  });

  it.each([
    ["already_member_elsewhere", "你的 LINE 已經是這間店另一位會員的聯絡人，要先退出才能加入。"],
    ["contact_limit", "這位會員的聯絡人已經額滿，請聯絡店家。"],
  ])("%s ⇒ 固定句子,不能再按加入", async (result, text) => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    state.acceptResult = { state: result };
    const user = userEvent.setup();
    renderAt(`/booking/cool-shop/invite/${TOKEN}`);
    await user.click(await screen.findByTestId("contact-invite-consent"));
    await user.click(screen.getByTestId("contact-invite-accept"));
    expect(await screen.findByTestId("contact-invite-blocked-result")).toHaveTextContent(text);
    expect(screen.queryByTestId("contact-invite-accept")).toBeNull();
  });

  it("LINE 登入回來但邀請已失效 ⇒ 失效句子", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    putClaimedInvite("cool-shop", false);
    renderAt("/booking/cool-shop/invite");
    expect(await screen.findByTestId("contact-invite-invalid")).toHaveTextContent(
      "這個邀請連結已經失效",
    );
  });
});
