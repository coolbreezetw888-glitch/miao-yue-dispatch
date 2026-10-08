// 客戶端第 2 批(C2-E02~E04、E06、E07、零之二):公開預約頁 ⑥ 系列畫面的元件測試。
// 資料庫函式與 Edge Function 都用假資料頂著(api / customerAuthApi 整支換掉);真的接口在 e2e-local 驗。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicAvailableSlots, PublicBookingPage, PublicBookingPageOk } from "./types";

const state = vi.hoisted(() => ({
  page: null as unknown,
  slots: null as unknown,
  session: { state: "anonymous" } as unknown,
  startUrl: "https://access.line.me/oauth2/v2.1/authorize?client_id=1",
  startError: null as unknown,
  startCalls: [] as unknown[],
  redirects: [] as string[],
  profileResult: { kind: "linked", created: true, existing: false } as unknown,
  profileError: null as unknown,
  profileCalls: [] as unknown[],
  signOutCalls: 0,
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
    startLineLogin: vi.fn(async (slug: string, draft: unknown) => {
      state.startCalls.push({ slug, draft });
      if (state.startError) throw state.startError;
      return state.startUrl;
    }),
    redirectToAuthorizeUrl: vi.fn((url: string) => {
      state.redirects.push(url);
    }),
    completeCustomerProfile: vi.fn(async (params: unknown) => {
      state.profileCalls.push(params);
      if (state.profileError) throw state.profileError;
      return state.profileResult;
    }),
    signOutCustomer: vi.fn(async () => {
      state.signOutCalls += 1;
      state.session = { state: "anonymous" };
    }),
  };
});

// 客戶端第 3 批:⑥-2 完成會員資料後會自動送出預約 ⇒ 送出也換成假的(預設回 too_many_open,畫面停在確認頁)。
vi.mock("./bookingSubmitApi", async () => {
  const actual = await vi.importActual<typeof import("./bookingSubmitApi")>("./bookingSubmitApi");
  return {
    ...actual,
    submitCustomerBooking: vi.fn(async () => ({ kind: "rejected", state: "too_many_open" })),
  };
});
// Turnstile 腳本不載真的:render 回一個 id,execute 直接給 token。
vi.mock("./turnstile", async () => {
  const actual = await vi.importActual<typeof import("./turnstile")>("./turnstile");
  return {
    ...actual,
    loadTurnstile: vi.fn(async () => ({
      render: (_el: HTMLElement, opts: Record<string, unknown>) => {
        (globalThis as Record<string, unknown>)["__tsOpts"] = opts;
        return "w1";
      },
      execute: () => {
        const opts = (globalThis as Record<string, unknown>)["__tsOpts"] as {
          callback: (t: string) => void;
        };
        setTimeout(() => opts.callback("TOKEN"), 0);
      },
      reset: () => undefined,
      remove: () => undefined,
    })),
  };
});

const { default: PublicBookingPageView } = await import("./PublicBookingPage");
const { CustomerAuthError, CompleteProfileError } = await import("./customerAuthApi");
const { putPendingDraft, takePendingDraft } = await import("./customerLoginLogic");
const { taipeiToday, addDays } = await import("./publicBookingLogic");

const DAY = addDays(taipeiToday(), 2);

function makePage(
  settings: Partial<PublicBookingPageOk["booking_settings"]> = {},
  extra: Partial<PublicBookingPageOk> = {},
): PublicBookingPage {
  return {
    status: "ok",
    merchant: {
      name: "涼風工匠",
      industry_type: "in_store_beauty",
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
      is_on_site: false,
      line_login_enabled: true,
      customer_cancel_deadline_hours: 24,
      ...settings,
    },
    member_policy: { enabled: true, content: "會員點數一年內有效。" },
    categories: [],
    service_items: [
      {
        id: "nail",
        category_id: null,
        name: "單色凝膠",
        description: null,
        price: 1200,
        duration_minutes: 60,
        item_type: "primary",
      },
    ],
    staff: [
      {
        id: "s-amy",
        display_name: "Amy",
        avatar_url: null,
        intro: null,
        primary_service_item_ids: null,
      },
    ],
    ...extra,
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

function renderPage(path = "/booking/cool-shop") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/booking/:slug" element={<PublicBookingPageView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function walkToForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("public-booking-start"));
  await user.click(screen.getByRole("checkbox", { name: /單色凝膠/ }));
  await user.click(screen.getByTestId("public-booking-next"));
  await user.click(screen.getByTestId("public-booking-next")); // ③ 不指定
  await user.click(await screen.findByTestId("public-booking-time-14:00"));
  await user.click(screen.getByTestId("public-booking-next"));
}

beforeEach(() => {
  state.page = makePage();
  state.slots = makeSlots();
  state.session = { state: "anonymous" };
  state.startUrl = "https://access.line.me/oauth2/v2.1/authorize?client_id=1";
  state.startError = null;
  state.startCalls = [];
  state.redirects = [];
  state.profileResult = { kind: "linked", created: true, existing: false };
  state.profileError = null;
  state.profileCalls = [];
  state.signOutCalls = 0;
  takePendingDraft("cool-shop");
});
afterEach(() => cleanup());

describe("C2-E02 ⑤「確定預約」依商家設定", () => {
  it("有 LINE 登入 + 允許不登入 ⇒ 姓名沒填擋下;填好進 ⑥-1(LINE 登入 + 不登入，直接預約)", async () => {
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    const submit = screen.getByTestId("public-booking-submit");
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent("確定預約");
    await user.click(submit);
    expect(screen.getByText("請填寫姓名。")).toBeInTheDocument();
    expect(screen.queryByTestId("customer-line-login")).toBeNull();

    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    const login = await screen.findByTestId("customer-line-login");
    expect(login).toHaveTextContent("最後一步：登入會員");
    expect(login).toHaveTextContent("第一次登入會自動成為「涼風工匠」的會員");
    expect(screen.getByTestId("customer-line-login-button")).toHaveTextContent("用 LINE 登入");
    expect(screen.getByTestId("customer-guest-button")).toHaveTextContent("不登入，直接預約");

    // 系統上一頁 = 回 ⑤,姓名還在
    await user.click(screen.getByRole("button", { name: "回上一步" }));
    expect(screen.getByLabelText(/姓名/)).toHaveValue("王小明");
  });

  it("有 LINE 登入 + 不允許不登入 ⇒ ⑥-1 只有 LINE 登入", async () => {
    state.page = makePage({ allow_guest_booking: false });
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    await screen.findByTestId("customer-line-login");
    expect(screen.queryByTestId("customer-guest-button")).toBeNull();
  });

  it("C3-D01 沒有 LINE 登入 + 允許不登入 ⇒「確定預約」直接到 ⑥-4", async () => {
    state.page = makePage({ line_login_enabled: false, allow_guest_booking: true });
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    const submit = screen.getByTestId("public-booking-submit");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByTestId("customer-guest")).toBeInTheDocument();
    expect(screen.queryByTestId("customer-line-login")).toBeNull();
    // 系統上一頁 = 回 ⑤
    await user.click(screen.getByRole("button", { name: "回上一步" }));
    expect(screen.getByLabelText(/姓名/)).toHaveValue("王小明");
  });

  it("C3-D01 沒有 LINE 登入 + 不允許不登入 ⇒ 停用按鈕 + 常駐原因 + 聯絡方式", async () => {
    state.page = makePage({ line_login_enabled: false, allow_guest_booking: false });
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    const submit = screen.getByTestId("public-booking-submit");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("確定預約");
    expect(screen.getByTestId("public-booking-not-open")).toHaveTextContent(
      "這家店目前不開放線上預約，請透過下方方式聯絡店家。",
    );
    expect(screen.getByTestId("public-booking-contacts")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("即將開放");
  });
});

describe("C2-E03 ⑥-1 用 LINE 登入", () => {
  it("按下 ⇒ 帶草稿呼叫 start,跳到 LINE 授權頁;等待中按鈕停用", async () => {
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), " 王小明 ");
    await user.type(screen.getByLabelText(/備註/), "門口有狗");
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-line-login-button"));
    await waitFor(() => expect(state.redirects).toHaveLength(1));
    expect(state.redirects[0]).toBe(state.startUrl);
    expect(state.startCalls).toEqual([
      {
        slug: "cool-shop",
        draft: {
          items: [{ service_item_id: "nail", quantity: 1 }],
          staff_id: null,
          date: DAY,
          time: "14:00",
          name: "王小明",
          address: "",
          note: "門口有狗",
        },
      },
    ]);
    expect(screen.getByTestId("customer-line-login-button")).toBeDisabled();
  });

  it("C2-F04:伺服器回了別的網站 ⇒ 不跳,顯示錯誤", async () => {
    state.startUrl = "https://evil.example/phish";
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-line-login-button"));
    expect(await screen.findByTestId("customer-line-login-error")).toHaveTextContent(
      "目前無法連到 LINE，請稍後再試。",
    );
    expect(state.redirects).toEqual([]);
  });

  it("這間店沒啟用 LINE 登入(伺服器說)⇒ 固定中文,不顯示代碼", async () => {
    state.startError = new CustomerAuthError("line_login_unavailable");
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-line-login-button"));
    expect(await screen.findByTestId("customer-line-login-error")).toHaveTextContent(
      "這間店目前無法使用 LINE 登入，請直接聯絡店家。",
    );
    expect(document.body.textContent).not.toContain("line_login_unavailable");
  });
});

describe("C2-E06 / C3-D04 ⑥-4 不登入預約", () => {
  it("摘要、電話(收市話)、同意框、藍色說明;沒勾同意 / 電話錯 ⇒ 停用 + 常駐原因", async () => {
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    await user.click(await screen.findByTestId("customer-guest-button"));
    const guest = await screen.findByTestId("customer-guest");
    expect(within(guest).getByTestId("public-booking-summary")).toHaveTextContent("王小明");
    expect(guest).toHaveTextContent("店家會用這支電話跟你聯絡服務細節（公司可填市話）。");
    expect(screen.getByTestId("customer-guest-note")).toHaveTextContent(
      "不登入的預約都要等店家確認。之後想加入會員，隨時可以用 LINE 登入，下次預約不用再填電話。",
    );
    // 2026-10-09:不承諾第 4、5 批才有的事(查看預約、收到通知)
    expect(screen.getByTestId("customer-guest-note")).not.toHaveTextContent("通知");
    expect(screen.getByTestId("customer-guest-submit")).toBeDisabled();
    expect(screen.getByTestId("customer-guest-submit")).toHaveTextContent("送出預約");
    expect(screen.getByTestId("customer-guest-submit-reason")).toHaveTextContent(
      "請先勾選同意會員政策與隱私權政策，才能送出預約。",
    );
    await user.click(screen.getByTestId("customer-guest-consent"));
    expect(screen.getByTestId("customer-guest-submit-reason")).toHaveTextContent(
      "請先填寫電話，才能送出預約。",
    );
    // 市話可以
    const phone = screen.getByLabelText(/電話/);
    await user.type(phone, "(02) 1234-5678");
    await user.tab();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.clear(phone);
    await user.type(phone, "1234");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("請填 0 開頭的電話");
  });
});

describe("C2-E04 ⑥-2 登入回來填電話(零之二)", () => {
  function restoreLoggedIn() {
    putPendingDraft("cool-shop", {
      outcome: "logged_in",
      draft: {
        items: [{ service_item_id: "nail", quantity: 1 }],
        staff_id: null,
        date: DAY,
        time: "14:00",
        name: "王小明",
        address: "",
        note: "門口有狗",
      },
    });
  }

  it("草稿救回來、LINE 名稱純文字顯示、沒勾同意不能按;phone_taken ⇒ 提示 + 聯絡 + 不登入", async () => {
    state.session = {
      state: "needs_profile",
      lineDisplayName: "<script>alert(1)</script>",
      linePictureUrl: null,
    };
    state.profileResult = { kind: "phone_taken" };
    restoreLoggedIn();
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId("customer-profile")).toBeInTheDocument();
    expect(screen.getByTestId("customer-line-name")).toHaveTextContent("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    const submit = screen.getByTestId("customer-profile-submit");
    expect(submit).toHaveTextContent("送出預約");
    expect(submit).toBeDisabled();
    expect(screen.getByTestId("customer-profile-blocked")).toHaveTextContent(
      "請先勾選同意會員政策與隱私權政策，才能送出預約。",
    );

    await user.type(screen.getByLabelText(/電話/), "0912-345-678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    expect(screen.queryByTestId("customer-profile-blocked")).toBeNull();
    await user.click(screen.getByTestId("customer-profile-submit"));
    const taken = await screen.findByTestId("customer-phone-taken");
    expect(taken).toHaveTextContent("這支電話已經是會員，請改用其他電話，或聯繫店家。");
    expect(within(taken).getByTestId("public-booking-contacts")).toBeInTheDocument();
    expect(state.profileCalls).toEqual([
      { slug: "cool-shop", phone: "0912-345-678", name: "王小明", agreePolicy: true },
    ]);
    // 改了電話,提示消失
    await user.type(screen.getByLabelText(/電話/), "9");
    expect(screen.queryByTestId("customer-phone-taken")).toBeNull();
    await user.clear(screen.getByLabelText(/電話/));
    await user.type(screen.getByLabelText(/電話/), "0912-345-678");
    await user.click(screen.getByTestId("customer-profile-submit"));
    await user.click(await screen.findByTestId("customer-phone-taken-guest"));
    expect(await screen.findByTestId("customer-guest")).toBeInTheDocument();
  });

  it("4-B(C4-H04):電話已經是別人的會員 ⇒ 申請已送出畫面 +「不登入，直接預約」(允許訪客的店)", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小李", linePictureUrl: null };
    state.profileResult = { kind: "join_pending" };
    restoreLoggedIn();
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText(/電話/), "0912-345-678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    state.session = { state: "join_pending", lineDisplayName: "小李", linePictureUrl: null };
    await user.click(screen.getByTestId("customer-profile-submit"));
    const pending = await screen.findByTestId("customer-join-pending");
    expect(pending).toHaveTextContent("同意後你就能使用會員中心");
    await user.click(within(pending).getByTestId("customer-join-pending-guest"));
    expect(await screen.findByTestId("customer-guest")).toBeInTheDocument();
  });

  it("接上既有會員 ⇒ 自動送出;送出沒成功(too_many_open)⇒ 確認畫面 +「已幫你接上原本的資料」;登出 ⇒ 回 ⑥-1", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    state.profileResult = { kind: "linked", created: false, existing: true };
    restoreLoggedIn();
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText(/電話/), "02-2345-6789");
    await user.click(screen.getByTestId("customer-profile-consent"));
    state.session = { state: "linked", memberName: "王大明", memberPhone: "0223456789" };
    await user.click(screen.getByTestId("customer-profile-submit"));
    expect(await screen.findByTestId("customer-linked-existing")).toHaveTextContent(
      "這支電話已經是「涼風工匠」的會員，已幫你接上原本的資料。",
    );
    expect(screen.getByTestId("customer-linked-name")).toHaveTextContent("王大明");
    expect(screen.getByTestId("customer-submit-error-message")).toHaveTextContent(
      "你目前已有 3 筆尚未完成的預約",
    );
    expect(screen.getByTestId("customer-linked-submit")).toBeEnabled();
    expect(screen.getByTestId("public-booking-summary")).toHaveTextContent("單色凝膠 ×1");

    await user.click(screen.getByTestId("customer-logout"));
    expect(await screen.findByTestId("customer-line-login")).toBeInTheDocument();
    expect(state.signOutCalls).toBe(1);
  });

  it("登入狀態失效(channel_mismatch)⇒ 登出並回 ⑥-1 顯示原因", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    state.profileError = new CompleteProfileError("channel_mismatch");
    restoreLoggedIn();
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText(/電話/), "0912345678");
    await user.click(screen.getByTestId("customer-profile-consent"));
    await user.click(screen.getByTestId("customer-profile-submit"));
    expect(await screen.findByTestId("customer-line-login-error")).toHaveTextContent(
      "登入狀態已失效，請重新用 LINE 登入。",
    );
  });

  it("商家沒開會員政策 ⇒ 勾選框只有隱私權政策;有開 ⇒ 點「會員政策」看到內容", async () => {
    state.session = { state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null };
    restoreLoggedIn();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("customer-profile");
    await user.click(screen.getByTestId("customer-profile-consent-member-policy"));
    expect(await screen.findByTestId("member-policy-dialog")).toHaveTextContent(
      "會員點數一年內有效。",
    );
    cleanup();

    state.page = makePage({}, { member_policy: { enabled: false, content: "x" } });
    restoreLoggedIn();
    renderPage();
    await screen.findByTestId("customer-profile");
    expect(screen.queryByTestId("customer-profile-consent-member-policy")).toBeNull();
    expect(screen.getByRole("link", { name: "隱私權政策" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByTestId("customer-profile-blocked")).toHaveTextContent(
      "請先勾選同意隱私權政策，才能送出預約。",
    );
  });
});

describe("C2-E07 / B04 登入回來與取消", () => {
  it("在 LINE 按取消 ⇒ 回到 ⑤,資料都在 + 提示", async () => {
    putPendingDraft("cool-shop", {
      outcome: "cancelled",
      draft: {
        items: [{ service_item_id: "nail", quantity: 1 }],
        staff_id: null,
        date: DAY,
        time: "14:00",
        name: "王小明",
        address: "",
        note: "門口有狗",
      },
    });
    renderPage();
    expect(await screen.findByTestId("public-booking-line-cancelled")).toHaveTextContent(
      "你取消了 LINE 登入",
    );
    expect(screen.getByLabelText(/姓名/)).toHaveValue("王小明");
    expect(screen.getByLabelText(/備註/)).toHaveValue("門口有狗");
  });

  it("沒有草稿(重新整理)⇒ 回到 ①;已登入的人按確定預約直接到已登入確認畫面", async () => {
    state.session = { state: "linked", memberName: "王小明", memberPhone: "0912345678" };
    const user = userEvent.setup();
    renderPage();
    await walkToForm(user);
    await user.type(screen.getByLabelText(/姓名/), "王小明");
    await user.click(screen.getByTestId("public-booking-submit"));
    expect(await screen.findByTestId("customer-linked")).toHaveTextContent(
      "已用 LINE 登入：王小明（不是你？登出）",
    );
    expect(screen.queryByTestId("customer-linked-existing")).toBeNull();
  });
});
