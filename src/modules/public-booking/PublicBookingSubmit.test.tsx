// 客戶端第 3 批(C3-D01~D07,零之零):送出預約、失敗畫面、完成頁、加入會員的元件測試。
// Edge Function / 資料庫 / Turnstile 一律用假的頂著(真的接口在 e2e-local 驗,等工程師甲的 c3-contract)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicAvailableSlots, PublicBookingPage, PublicBookingPageOk } from "./types";

type FakeTurnstileMode = "pass" | "fail" | "interactive" | "unsupported";

const state = vi.hoisted(() => ({
  page: null as unknown,
  slots: null as unknown,
  session: { state: "anonymous" } as unknown,
  profileResult: { kind: "linked", created: true, existing: false } as unknown,
  profileCalls: [] as unknown[],
  submitResults: [] as unknown[],
  submitCalls: [] as Record<string, unknown>[],
  calls: [] as string[],
  joinUrl: "https://access.line.me/oauth2/v2.1/authorize?client_id=1",
  redirects: [] as string[],
  toasts: [] as string[],
  turnstile: "pass" as FakeTurnstileMode,
  turnstileExecutes: 0,
  signOutCalls: 0,
}));

vi.mock("sonner", () => ({
  toast: Object.assign((msg: string) => state.toasts.push(msg), {
    success: (msg: string) => state.toasts.push(msg),
    error: (msg: string) => state.toasts.push(msg),
  }),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchPublicBookingPage: vi.fn(async () => state.page),
    fetchPublicAvailableSlots: vi.fn(async () => state.slots),
  };
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
      state.calls.push("profile");
      state.profileCalls.push(params);
      return state.profileResult;
    }),
    signOutCustomer: vi.fn(async () => {
      state.signOutCalls += 1;
      state.session = { state: "anonymous" };
    }),
  };
});

vi.mock("./bookingSubmitApi", async () => {
  const actual = await vi.importActual<typeof import("./bookingSubmitApi")>("./bookingSubmitApi");
  return {
    ...actual,
    submitCustomerBooking: vi.fn(async (params: Record<string, unknown>) => {
      state.calls.push("submit");
      state.submitCalls.push(params);
      const next = state.submitResults.shift();
      if (next instanceof Error) throw next;
      return next ?? { kind: "rejected", state: "server_error" };
    }),
  };
});

vi.mock("./turnstile", async () => {
  const actual = await vi.importActual<typeof import("./turnstile")>("./turnstile");
  return {
    ...actual,
    loadTurnstile: vi.fn(async () => {
      let opts: Record<string, (arg?: string) => unknown> = {};
      return {
        render: (_el: HTMLElement, o: Record<string, (arg?: string) => unknown>) => {
          opts = o;
          if (state.turnstile === "unsupported")
            setTimeout(() => opts["unsupported-callback"]?.(), 0);
          return "w1";
        },
        execute: () => {
          state.turnstileExecutes += 1;
          setTimeout(() => {
            if (state.turnstile === "fail") opts["error-callback"]?.("300030");
            else if (state.turnstile === "interactive") opts["before-interactive-callback"]?.();
            else opts["callback"]?.("TOKEN-" + state.turnstileExecutes);
          }, 0);
        },
        reset: () => undefined,
        remove: () => undefined,
      };
    }),
  };
});

const { default: PublicBookingPageView } = await import("./PublicBookingPage");
const { loadTurnstile: loadTurnstileMock } = await import("./turnstile");
const { BookingSubmitError } = await import("./bookingSubmitApi");
const { putPendingDraft, takePendingDraft } = await import("./customerLoginLogic");
const { taipeiToday, addDays } = await import("./publicBookingLogic");

const DAY = addDays(taipeiToday(), 2);

function makePage(
  settings: Partial<PublicBookingPageOk["booking_settings"]> = {},
): PublicBookingPage {
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
      ...settings,
    },
    member_policy: { enabled: false, content: null },
    categories: [],
    service_items: [
      {
        id: "wash",
        category_id: null,
        name: "室內機清洗",
        description: null,
        price: 2500,
        duration_minutes: 60,
        item_type: "primary",
      },
    ],
    staff: [
      {
        id: "s-ming",
        display_name: "阿明",
        avatar_url: null,
        intro: null,
        primary_service_item_ids: null,
      },
    ],
  };
}

function makeSlots(): PublicAvailableSlots {
  return {
    duration_minutes: 60,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(taipeiToday(), i);
      return i === 2
        ? { date, state: "open" as const, times: ["10:00", "14:00"] }
        : { date, state: "closed" as const, times: [] };
    }),
  };
}

function createdResult(extra: Record<string, unknown> = {}) {
  return {
    kind: "created",
    booking: {
      status: "pending_confirmation",
      startAt: "2026-10-13T02:00:00Z",
      endAt: "2026-10-13T03:00:00Z",
      staffDisplay: "阿明",
      items: [{ name: "室內機清洗", quantity: 1 }],
      address: "台北市信義區松仁路 58 號",
      phone: null,
      estimatedAmount: 2500,
      isGuest: false,
      completionMessage: "店家確認後會通知你。",
      ...extra,
    },
  };
}

let navigateRef: NavigateFunction | null = null;
/** 拿到 router 的 navigate,模擬手機 / 瀏覽器的「上一頁」(navigate(-1))。 */
function NavProbe() {
  navigateRef = useNavigate();
  return null;
}

function renderPage(path = "/booking/cool-shop") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/booking/:slug"
            element={
              <>
                <NavProbe />
                <PublicBookingPageView />
              </>
            }
          />
          <Route path="/booking/:slug/me" element={<div data-testid="member-center-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function walkToForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("public-booking-start"));
  await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
  await user.click(screen.getByTestId("public-booking-next"));
  await user.click(screen.getByTestId("public-booking-next")); // ③ 不指定
  await user.click(await screen.findByTestId("public-booking-time-14:00"));
  await user.click(screen.getByTestId("public-booking-next"));
  await user.type(screen.getByLabelText(/姓名/), "王小明");
  await user.type(screen.getByLabelText(/服務地址/), "台北市信義區松仁路 58 號");
  await user.type(screen.getByLabelText(/備註/), "門口有狗");
}

async function walkToGuest(user: ReturnType<typeof userEvent.setup>) {
  await walkToForm(user);
  // C3-D04:Turnstile 腳本只在 ⑥-4 才載入
  expect(loadTurnstileMock).not.toHaveBeenCalled();
  await user.click(screen.getByTestId("public-booking-submit"));
  await user.click(await screen.findByTestId("customer-guest-button"));
  await screen.findByTestId("customer-guest");
}

async function fillGuest(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/電話/), "0912-345-678");
  await user.click(screen.getByTestId("customer-guest-consent"));
  await waitFor(() => expect(screen.getByTestId("customer-guest-submit")).toBeEnabled());
}

const DRAFT = {
  items: [{ service_item_id: "wash", quantity: 1 }],
  staff_id: null,
  date: DAY,
  time: "14:00",
  name: "王小明",
  address: "台北市信義區松仁路 58 號",
  note: "門口有狗",
};

beforeEach(() => {
  state.page = makePage();
  state.slots = makeSlots();
  state.session = { state: "anonymous" };
  state.profileResult = { kind: "linked", created: true, existing: false };
  state.profileCalls = [];
  state.submitResults = [];
  state.submitCalls = [];
  state.calls = [];
  state.redirects = [];
  state.toasts = [];
  state.turnstile = "pass";
  state.turnstileExecutes = 0;
  state.signOutCalls = 0;
  vi.mocked(loadTurnstileMock).mockClear();
  takePendingDraft("cool-shop");
});
afterEach(() => cleanup());

describe("C3-D03 已登入確認送出 → ⑦-1 / ⑦-2", () => {
  it("會員:摘要含地址;送出帶草稿、不帶 guest;完成頁顯示店家文字、服務人員、固定一行聯絡", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [createdResult({ completionMessage: "第一行\n第二行 <b>不是 HTML</b>" })];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    const linked = await screen.findByTestId("customer-linked");
    expect(within(linked).getByTestId("customer-login-bar")).toHaveTextContent(
      "已用 LINE 登入：王小明（不是你？登出）",
    );
    expect(within(linked).getByTestId("public-booking-summary")).toHaveTextContent(
      "台北市信義區松仁路 58 號",
    );
    await user.click(screen.getByTestId("customer-linked-submit"));

    const done = await screen.findByTestId("booking-complete");
    expect(done).toHaveAttribute("data-kind", "member_pending");
    expect(screen.getByTestId("booking-complete-title")).toHaveTextContent("已送出，等待店家確認");
    // 店家自訂文字:純文字、保留換行(whitespace-pre-line)、不解析 HTML
    const message = screen.getByTestId("booking-complete-message");
    expect(message.textContent).toBe("第一行\n第二行 <b>不是 HTML</b>");
    expect(message.querySelector("b")).toBeNull();
    expect(screen.getByTestId("booking-complete-staff")).toHaveTextContent("阿明");
    expect(screen.getByTestId("booking-complete-time")).toHaveTextContent("10月13日（二）10:00");
    expect(screen.getByTestId("booking-complete-onsite-note")).toBeInTheDocument();
    // C4-B04:⑦-1 會員 ⇒ 取消說明改成會員中心自己取消(N = 店家設定,預設 24)+「前往會員中心」主要按鈕
    expect(screen.getByTestId("booking-complete-cancel-text")).toHaveTextContent(
      "要取消可以在服務前 24 小時以前到會員中心操作；要改時間請取消後重新預約，或聯絡店家。",
    );
    expect(
      within(screen.getByTestId("booking-complete-contact")).getByTestId("public-booking-contacts"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("booking-complete-member-center")).toHaveTextContent("前往會員中心");
    expect(screen.getByTestId("booking-complete-home")).toHaveTextContent("回店家首頁");
    expect(screen.queryByTestId("booking-complete-join")).toBeNull();

    expect(state.submitCalls).toHaveLength(1);
    expect(state.submitCalls[0]).toMatchObject({ slug: "cool-shop", guest: null, draft: DRAFT });
    expect(String(state.submitCalls[0]!["submissionId"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("直接成立 ⇒ ⑦-2「預約成功」、已確認;服務人員沒給 ⇒「由店家安排」", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [createdResult({ status: "accepted", staffDisplay: null })];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    expect(await screen.findByTestId("booking-complete")).toHaveAttribute(
      "data-kind",
      "member_accepted",
    );
    expect(screen.getByTestId("booking-complete-title")).toHaveTextContent("預約成功");
    expect(screen.getByTestId("booking-complete-summary")).toHaveTextContent("已確認");
    expect(screen.getByTestId("booking-complete-staff")).toHaveTextContent("由店家安排");
  });

  it("完成頁「回店家首頁」⇒ ①,之前選的都清掉;登入列還在", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [createdResult()];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    await user.click(await screen.findByTestId("booking-complete-home"));
    expect(await screen.findByTestId("public-booking-start")).toBeInTheDocument();
    expect(screen.getByTestId("customer-login-bar")).toHaveTextContent("王小明");
    await user.click(screen.getByTestId("public-booking-start"));
    expect(screen.getByRole("checkbox", { name: /室內機清洗/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("網路錯誤 ⇒ 畫面保留 + 說明;重按用同一個 submission_id", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [new BookingSubmitError("network"), createdResult()];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    expect(await screen.findByTestId("customer-submit-error-message")).toHaveTextContent(
      "送出時發生問題，請稍後再試。",
    );
    await user.click(screen.getByTestId("customer-linked-submit"));
    await screen.findByTestId("booking-complete");
    expect(state.submitCalls).toHaveLength(2);
    expect(state.submitCalls[0]!["submissionId"]).toBe(state.submitCalls[1]!["submissionId"]);
  });

  it("slot_taken ⇒ 回 ④ + 提示;姓名等保留;重新選時間再進確認畫面 ⇒ 新的 submission_id", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [{ kind: "rejected", state: "slot_taken" }, createdResult()];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    expect(await screen.findByTestId("public-booking-slot-taken")).toHaveTextContent(
      "這個時段剛剛被約走了，請重新選一個時間。",
    );
    expect(screen.getByTestId("public-booking-next")).toBeDisabled();
    await user.click(await screen.findByTestId("public-booking-time-10:00"));
    expect(screen.queryByTestId("public-booking-slot-taken")).toBeNull();
    await user.click(screen.getByTestId("public-booking-next"));
    expect(screen.getByLabelText(/姓名/)).toHaveValue("王小明");
    expect(screen.getByLabelText(/備註/)).toHaveValue("門口有狗");
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    await screen.findByTestId("booking-complete");
    expect(state.submitCalls[1]).toMatchObject({ draft: { ...DRAFT, time: "10:00" } });
    expect(state.submitCalls[0]!["submissionId"]).not.toBe(state.submitCalls[1]!["submissionId"]);
  });

  it("not_linked ⇒ 登出、回 ⑥-1 顯示原因", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [{ kind: "rejected", state: "not_linked" }];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    expect(await screen.findByTestId("customer-line-login-error")).toHaveTextContent(
      "登入狀態已失效，請重新用 LINE 登入。",
    );
    expect(state.signOutCalls).toBe(1);
  });
});

describe("C3-D02 ⑥-2「送出預約」:先接上會員、接著自動送出", () => {
  it("兩段依序呼叫 ⇒ 完成頁", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    state.submitResults = [createdResult()];
    putPendingDraft("cool-shop", { outcome: "logged_in", draft: DRAFT });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText(/電話/), "0912345678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    expect(screen.getByTestId("customer-profile-submit")).toHaveTextContent("送出預約");
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    await user.click(screen.getByTestId("customer-profile-submit"));
    await screen.findByTestId("booking-complete");
    expect(state.calls).toEqual(["profile", "submit"]);
    expect(state.submitCalls[0]).toMatchObject({ guest: null, draft: DRAFT });
  });
});

describe("C3-D04 ⑥-4 訪客送出 → ⑦-3", () => {
  it("拿 Turnstile token 後送出;完成頁顯示電話、店家有 LINE 登入 ⇒ 加入會員區塊", async () => {
    state.submitResults = [
      createdResult({
        isGuest: true,
        phone: "0912-345-678",
        completionMessage: "店家確認後會與你聯絡。",
      }),
    ];
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    const done = await screen.findByTestId("booking-complete");
    expect(done).toHaveAttribute("data-kind", "guest");
    expect(screen.getByTestId("booking-complete-message")).toHaveTextContent(
      "店家確認後會與你聯絡。",
    );
    expect(screen.getByTestId("booking-complete-phone")).toHaveTextContent("0912-345-678");
    expect(screen.getByTestId("booking-complete-join")).toBeInTheDocument();
    // C4-B04:⑦-3 加入會員說明 / 取消說明(逐字);訪客沒有「前往會員中心」
    expect(screen.getByTestId("booking-complete-join-text")).toHaveTextContent(
      "用 LINE 登入加入會員後，可以在會員中心查看和取消這筆預約。",
    );
    expect(screen.getByTestId("booking-complete-cancel-text")).toHaveTextContent(
      "要取消或改時間請直接聯絡店家",
    );
    expect(document.body.textContent).not.toContain("即將推出");
    expect(screen.queryByTestId("booking-complete-member-center")).toBeNull();
    expect(state.submitCalls[0]).toMatchObject({
      draft: DRAFT,
      guest: { phone: "0912-345-678", agreePolicy: true, turnstileToken: "TOKEN-1" },
    });

    // ⑦-3「用 LINE 登入加入會員」⇒ start(purpose:'join')後跳 LINE
    await user.click(screen.getByTestId("booking-complete-join-button"));
    await waitFor(() => expect(state.redirects).toEqual([state.joinUrl]));
  });

  it("店家沒啟用 LINE 登入 ⇒ ⑦-3 沒有加入會員區塊", async () => {
    state.page = makePage({ line_login_enabled: false });
    state.submitResults = [createdResult({ isGuest: true, phone: "0912345678" })];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await screen.findByTestId("customer-guest");
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    await screen.findByTestId("booking-complete");
    expect(screen.queryByTestId("booking-complete-join")).toBeNull();
  });

  it("slot_taken 回 ④ 再回來,電話與勾選都還在", async () => {
    state.submitResults = [{ kind: "rejected", state: "slot_taken" }];
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    await screen.findByTestId("public-booking-slot-taken");
    await user.click(await screen.findByTestId("public-booking-time-10:00"));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-guest-button"));
    expect(screen.getByLabelText(/電話/)).toHaveValue("0912-345-678");
    expect(screen.getByTestId("customer-guest-consent")).toHaveAttribute("aria-checked", "true");
  });

  it.each([
    ["too_many_open", "你目前已有 3 筆尚未完成的預約", true],
    ["contact_store", "這支電話需要店家協助處理，請直接聯絡店家。", true],
    ["bot_check_failed", "安全檢查沒有通過，請重新整理後再試一次。", true],
    ["rate_limited", "操作太頻繁，請稍後再試。", false],
  ])("失敗 %s ⇒ 中文說明(不顯示代碼)", async (code, text, contacts) => {
    state.submitResults = [{ kind: "rejected", state: code }];
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    const panel = await screen.findByTestId("customer-submit-error");
    expect(panel).toHaveTextContent(text);
    expect(Boolean(within(panel).queryByTestId("public-booking-contacts"))).toBe(contacts);
    expect(document.body.textContent).not.toContain(code);
  });

  it("guest_not_allowed ⇒「這家店目前不開放不登入預約」+ LINE 登入按鈕(回 ⑥-1)", async () => {
    state.submitResults = [{ kind: "rejected", state: "guest_not_allowed" }];
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    expect(await screen.findByTestId("customer-submit-error")).toHaveTextContent(
      "這家店目前不開放不登入預約。",
    );
    await user.click(screen.getByTestId("customer-submit-error-line-login"));
    expect(await screen.findByTestId("customer-line-login")).toBeInTheDocument();
  });

  it("Turnstile 需要勾選 ⇒ 顯示「請勾選，確認你不是機器人」", async () => {
    state.turnstile = "interactive";
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    expect(await screen.findByTestId("customer-guest-turnstile-hint")).toHaveTextContent(
      "請勾選，確認你不是機器人",
    );
    expect(state.submitCalls).toHaveLength(0);
  });

  it("Turnstile 沒通過 ⇒ 安全檢查說明、不送出;連續 3 次 ⇒ 改成「這個瀏覽器無法完成安全檢查」", async () => {
    state.turnstile = "fail";
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    await fillGuest(user);
    await user.click(screen.getByTestId("customer-guest-submit"));
    expect(await screen.findByTestId("customer-submit-error")).toHaveTextContent(
      "安全檢查沒有通過",
    );
    await user.click(screen.getByTestId("customer-guest-submit"));
    await waitFor(() => expect(state.turnstileExecutes).toBe(2));
    await user.click(screen.getByTestId("customer-guest-submit"));
    expect(await screen.findByTestId("customer-guest-unsupported")).toHaveTextContent(
      "這個瀏覽器無法完成安全檢查。請改用手機內建瀏覽器開啟，或用 LINE 登入預約。",
    );
    expect(screen.getByTestId("customer-guest-copy-url")).toBeInTheDocument();
    expect(screen.getByTestId("customer-guest-unsupported-line-login")).toBeInTheDocument();
    expect(state.submitCalls).toHaveLength(0);
  });

  it("不支援的瀏覽器(unsupported-callback)⇒ 直接顯示替代方案,沒有送出鈕", async () => {
    state.turnstile = "unsupported";
    const user = userEvent.setup();
    renderPage();
    await walkToGuest(user);
    expect(await screen.findByTestId("customer-guest-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("customer-guest-submit")).toBeNull();
  });
});

describe("C3-D06 完成頁上一頁 / C3-D07 加入會員", () => {
  it("完成頁按系統上一頁 ⇒ 回 ①(不能回確認畫面再送一次)", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [createdResult()];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    await screen.findByTestId("booking-complete");
    expect(screen.queryByRole("button", { name: "回上一步" })).toBeNull();
    await act(async () => {
      await navigateRef?.(-1);
    });
    expect(await screen.findByTestId("public-booking-start")).toBeInTheDocument();
    expect(screen.queryByTestId("customer-linked")).toBeNull();
    // 再按一次上一頁也不會回到確認畫面(選的內容已清空)
    await act(async () => {
      await navigateRef?.(-1);
    });
    expect(screen.queryByTestId("customer-linked")).toBeNull();
    expect(state.submitCalls).toHaveLength(1);
  });

  it("C4-B03:加入會員回來(沒有草稿)的標記留在預約頁 ⇒ 轉到會員中心 /me(標記留給會員中心拿)", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    putPendingDraft("cool-shop", { outcome: "logged_in", draft: null });
    renderPage();
    expect(await screen.findByTestId("member-center-probe")).toBeInTheDocument();
    expect(screen.queryByTestId("customer-profile")).toBeNull();
    expect(state.toasts).toEqual([]);
    // 標記沒有被預約頁拿走(會員中心要用它決定跳哪一句提示)
    expect(takePendingDraft("cool-shop")).toEqual({ outcome: "logged_in", draft: null });
  });

  it("C4-B03:在 LINE 按取消回來(沒有草稿)⇒ 停在 ①,不轉會員中心", async () => {
    putPendingDraft("cool-shop", { outcome: "cancelled", draft: null });
    renderPage();
    expect(await screen.findByTestId("public-booking-start")).toBeInTheDocument();
    expect(screen.queryByTestId("member-center-probe")).toBeNull();
  });

  it("C4-B04:完成頁「前往會員中心」⇒ /me", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    state.submitResults = [createdResult()];
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-linked-submit"));
    await user.click(await screen.findByTestId("booking-complete-member-center"));
    expect(await screen.findByTestId("member-center-probe")).toBeInTheDocument();
  });
});

describe("2026-10-09 使用者新增:步驟條 5 步、填資料頁下一步提示", () => {
  it("沒登入:⑤ 步驟 4／5、下一步「登入／電話」+ 提示句;⑥-1、⑥-4 都是步驟 5／5", async () => {
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent(
      /步驟 4／5\s*填資料\s*下一步：登入／電話/,
    );
    expect(screen.getByTestId("public-booking-next-step-hint")).toHaveTextContent(
      "下一步會請你用 LINE 登入或填寫電話。",
    );
    await user.click(screen.getByTestId("public-booking-submit"));
    await screen.findByTestId("customer-line-login");
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent(
      /步驟 5／5\s*登入／電話\s*最後一步/,
    );
    await user.click(screen.getByTestId("customer-guest-button"));
    await screen.findByTestId("customer-guest");
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent("步驟 5／5");
  });

  it("已登入且接上會員:⑤ 下一步「確認送出」、沒有提示句;確認畫面「步驟 5／5 確認送出」", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await waitFor(() =>
      expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent("下一步：確認送出"),
    );
    expect(screen.queryByTestId("public-booking-next-step-hint")).toBeNull();
    await user.click(screen.getByTestId("public-booking-submit"));
    await screen.findByTestId("customer-linked");
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent(
      /步驟 5／5\s*確認送出/,
    );
  });

  it("只有 LINE 登入 / 只允許不登入 / 兩個都沒開 ⇒ 各自的提示句", async () => {
    const cases: [Partial<PublicBookingPageOk["booking_settings"]>, string | null][] = [
      [{ allow_guest_booking: false }, "下一步會請你用 LINE 登入。"],
      [{ line_login_enabled: false }, "下一步會請你填寫電話。"],
      [{ line_login_enabled: false, allow_guest_booking: false }, null],
    ];
    for (const [settings, text] of cases) {
      state.page = makePage(settings);
      const user = userEvent.setup();
      renderPage();
      await walkToForm(user);
      const hint = screen.queryByTestId("public-booking-next-step-hint");
      if (text) expect(hint).toHaveTextContent(text);
      else expect(hint).toBeNull();
      cleanup();
    }
  });

  it("⑥-2 填電話:步驟 5／5(⑦-3 加入會員回來的 ⑥-2 改在會員中心,見 MemberCenterPage.test)", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    putPendingDraft("cool-shop", { outcome: "logged_in", draft: DRAFT });
    renderPage();
    await screen.findByTestId("customer-profile");
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent("步驟 5／5");
  });
});

describe("C4-E05 已登入會員預約時自動帶地址", () => {
  it("地址欄空白 ⇒ 帶入會員地址,可以改", async () => {
    state.session = {
      state: "linked",
      memberName: "王小明",
      memberPhone: "0912345678",
      memberAddress: "台北市信義區松仁路 58 號 12 樓",
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(await screen.findByTestId("public-booking-time-14:00"));
    await user.click(screen.getByTestId("public-booking-next"));
    const address = screen.getByLabelText(/服務地址/);
    await waitFor(() => expect(address).toHaveValue("台北市信義區松仁路 58 號 12 樓"));
    await user.clear(address);
    await user.type(address, "新北市板橋區");
    expect(address).toHaveValue("新北市板橋區");
  });

  it("沒登入 ⇒ 不帶", async () => {
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    expect(screen.getByLabelText(/服務地址/)).toHaveValue("台北市信義區松仁路 58 號");
  });
});
