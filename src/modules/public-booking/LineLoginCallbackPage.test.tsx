// 客戶端第 2 批(C2-B02):/auth/line/callback 頁面的元件測試(Edge Function 與 verifyOtp 用假的頂著)。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  completeCalls: [] as unknown[],
  completeResult: null as unknown,
  completeError: null as unknown,
  sessions: [] as unknown[],
}));

vi.mock("./customerAuthApi", async () => {
  const actual = await vi.importActual<typeof import("./customerAuthApi")>("./customerAuthApi");
  return {
    ...actual,
    completeLineLogin: vi.fn(async (params: unknown) => {
      state.completeCalls.push(params);
      if (state.completeError) throw state.completeError;
      return state.completeResult;
    }),
    establishCustomerSession: vi.fn(async (slug: string, tokenHash: string) => {
      state.sessions.push({ slug, tokenHash });
    }),
  };
});

const { default: LineLoginCallbackPage } = await import("./LineLoginCallbackPage");
const { CustomerAuthError } = await import("./customerAuthApi");
const { takePendingDraft, LINE_LOGIN_SLUG_STORAGE_KEY, rememberLoginOrigin } =
  await import("./customerLoginLogic");

function BookingProbe() {
  const location = useLocation();
  return <p data-testid="booking-probe">{location.pathname}</p>;
}

function renderAt(url: string) {
  window.history.replaceState(null, "", url);
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/auth/line/callback" element={<LineLoginCallbackPage />} />
        <Route path="/booking/:slug" element={<BookingProbe />} />
        <Route path="/booking/:slug/me" element={<BookingProbe />} />
      </Routes>
    </BrowserRouter>,
  );
}

const DRAFT = {
  items: [{ service_item_id: "a", quantity: 1 }],
  staff_id: null,
  date: "2026-10-12",
  time: "10:00",
  name: "王小明",
  address: "",
  note: "",
};

beforeEach(() => {
  state.completeCalls = [];
  state.completeResult = null;
  state.completeError = null;
  state.sessions = [];
  window.sessionStorage.clear();
  takePendingDraft("cool-shop");
});
afterEach(() => cleanup());

describe("C2-B02 callback 頁", () => {
  it("一進來就把網址上的 code / state 清掉;成功 ⇒ 建立登入狀態、交草稿、回預約頁", async () => {
    let resolve: (v: unknown) => void = () => {};
    state.completeResult = new Promise((r) => {
      resolve = r;
    });
    renderAt("/auth/line/callback?code=CODE123&state=STATE456&friendship_status_changed=true");
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/auth/line/callback");
    expect(screen.getByTestId("line-callback-working")).toHaveTextContent("正在完成 LINE 登入…");
    resolve({ status: "ok", slug: "cool-shop", draft: DRAFT, tokenHash: "hash" });
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop");
    expect(state.completeCalls).toEqual([{ state: "STATE456", code: "CODE123", error: null }]);
    expect(state.sessions).toEqual([{ slug: "cool-shop", tokenHash: "hash" }]);
    expect(takePendingDraft("cool-shop")).toEqual({ outcome: "logged_in", draft: DRAFT });
  });

  it("客人在 LINE 按取消 ⇒ 不建立登入狀態,草稿交回(cancelled)", async () => {
    state.completeResult = { status: "cancelled", slug: "cool-shop", draft: DRAFT };
    renderAt("/auth/line/callback?error=ACCESS_DENIED&state=S2");
    expect(await screen.findByTestId("booking-probe")).toBeInTheDocument();
    expect(state.completeCalls).toEqual([{ state: "S2", code: null, error: "ACCESS_DENIED" }]);
    expect(state.sessions).toEqual([]);
    expect(takePendingDraft("cool-shop")).toEqual({ outcome: "cancelled", draft: DRAFT });
  });

  it("逾時 ⇒ 中文訊息 + 回店家首頁(代碼取自出發前記的)", async () => {
    window.sessionStorage.setItem(LINE_LOGIN_SLUG_STORAGE_KEY, "cool-shop");
    state.completeError = new CustomerAuthError("login_expired");
    renderAt("/auth/line/callback?code=C&state=S3");
    const failed = await screen.findByTestId("line-callback-failed");
    expect(failed).toHaveTextContent("登入逾時，請回到預約頁重新操作。");
    expect(document.body.textContent).not.toContain("login_expired");
    await userEvent.setup().click(screen.getByRole("button", { name: "回店家首頁" }));
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop");
  });

  it("網址上沒有 state ⇒ 不呼叫伺服器,顯示逾時;沒有記錄代碼 ⇒ 沒有回店家首頁", async () => {
    renderAt("/auth/line/callback");
    expect(await screen.findByTestId("line-callback-failed")).toHaveTextContent("登入逾時");
    expect(state.completeCalls).toEqual([]);
    expect(screen.queryByRole("button", { name: "回店家首頁" })).toBeNull();
    expect(screen.getByTestId("line-callback-no-shop")).toHaveTextContent(
      "請回到店家給你的預約連結重新操作。",
    );
  });

  it("逾時但伺服器帶回 slug(紀錄還在)⇒「回店家首頁」用伺服器給的店,不靠瀏覽器記的", async () => {
    window.sessionStorage.setItem(LINE_LOGIN_SLUG_STORAGE_KEY, "other-shop");
    state.completeError = new CustomerAuthError("login_expired", "cool-shop");
    renderAt("/auth/line/callback?code=C&state=S5");
    expect(await screen.findByTestId("line-callback-failed")).toHaveTextContent("登入逾時");
    expect(screen.queryByTestId("line-callback-no-shop")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "回店家首頁" }));
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop");
  });

  it("偽造的 state(伺服器沒有 slug、瀏覽器也沒記)⇒ 沒有按鈕,但有下一步說明", async () => {
    state.completeError = new CustomerAuthError("login_expired");
    renderAt("/auth/line/callback?code=C&state=FORGED");
    expect(await screen.findByTestId("line-callback-failed")).toHaveTextContent(
      "登入逾時，請回到預約頁重新操作。",
    );
    expect(screen.queryByRole("button", { name: "回店家首頁" })).toBeNull();
    expect(screen.getByTestId("line-callback-no-shop")).toHaveTextContent(
      "請回到店家給你的預約連結重新操作。",
    );
  });

  it("LINE 那邊沒成功(line_error)但有草稿 ⇒ 直接回預約頁並把草稿交回(failed)", async () => {
    state.completeError = new CustomerAuthError("line_error", "cool-shop", DRAFT);
    renderAt("/auth/line/callback?code=C&state=S4");
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop");
    expect(takePendingDraft("cool-shop")).toEqual({ outcome: "failed", draft: DRAFT });
  });

  it("C4-B03:沒有草稿(加入會員 / 會員中心登入)登入成功 ⇒ 到會員中心 /me,標記交給會員中心", async () => {
    state.completeResult = { status: "ok", slug: "cool-shop", draft: null, tokenHash: "h" };
    renderAt("/auth/line/callback?code=C&state=JOIN1");
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop/me");
    expect(takePendingDraft("cool-shop")).toEqual({ outcome: "logged_in", draft: null });
  });

  it("C4-B03:沒有草稿、在 LINE 按取消 ⇒ 從會員中心出發的回 /me,其他回 ①", async () => {
    state.completeResult = { status: "cancelled", slug: "cool-shop", draft: null };
    rememberLoginOrigin("member_center");
    renderAt("/auth/line/callback?error=ACCESS_DENIED&state=JOIN2");
    expect(await screen.findByTestId("booking-probe")).toHaveTextContent("/booking/cool-shop/me");
    cleanup();
    takePendingDraft("cool-shop");
    renderAt("/auth/line/callback?error=ACCESS_DENIED&state=JOIN3");
    await waitFor(() =>
      expect(screen.getByTestId("booking-probe").textContent).toBe("/booking/cool-shop"),
    );
  });

  it("同一個 state 只送一次", async () => {
    state.completeError = new CustomerAuthError("line_error", "cool-shop");
    renderAt("/auth/line/callback?code=C&state=ONCE");
    await screen.findByTestId("line-callback-failed");
    cleanup();
    renderAt("/auth/line/callback?code=C&state=ONCE");
    await waitFor(() => expect(state.completeCalls).toHaveLength(1));
  });
});
