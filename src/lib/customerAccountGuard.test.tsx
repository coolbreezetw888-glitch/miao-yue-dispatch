// 客戶端第 2 批(C2-H01):後台拿到客人帳號 ⇒ 顯示原因、只登出後台 client。
// 判斷函式 + PlatformAdminGuard 的元件測試(AppLayout 依賴太多,改由 e2e-local c2-customer-account-guard 驗)。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as unknown,
  signOutCalls: [] as unknown[],
  platformAdminCalls: 0,
  authListeners: [] as ((event: string, session: unknown) => void)[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signOut: vi.fn(async (opts: unknown) => {
        state.signOutCalls.push(opts);
        for (const l of state.authListeners) l("SIGNED_OUT", null);
        return { error: null };
      }),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        state.authListeners.push(cb);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      }),
    },
  },
}));

vi.mock("@/lib/auth-guard", () => ({
  getVerifiedUser: vi.fn(async () => state.user),
}));

vi.mock("@/modules/platform-admin/api", () => ({
  amIPlatformAdmin: vi.fn(async () => {
    state.platformAdminCalls += 1;
    return true;
  }),
}));

const { isCustomerAccountUser, CUSTOMER_ACCOUNT_BLOCKED_MESSAGE } =
  await import("./customerAccountGuard");
const { PlatformAdminGuard } = await import("@/modules/platform-admin/PlatformAdminGuard");

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/platform-admin"]}>
      <Routes>
        <Route
          path="/platform-admin"
          element={
            <PlatformAdminGuard>
              <p>超管畫面</p>
            </PlatformAdminGuard>
          }
        />
        <Route path="/signin" element={<p>登入頁</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.user = null;
  state.signOutCalls = [];
  state.platformAdminCalls = 0;
  state.authListeners = [];
});
afterEach(() => cleanup());

describe("isCustomerAccountUser", () => {
  it("只看 app_metadata.account_type(user_metadata 客人改得到,不算)", () => {
    expect(isCustomerAccountUser({ app_metadata: { account_type: "customer" } })).toBe(true);
    expect(isCustomerAccountUser({ app_metadata: {} })).toBe(false);
    expect(
      isCustomerAccountUser({
        app_metadata: { provider: "email" },
        user_metadata: { account_type: "customer" },
      } as never),
    ).toBe(false);
    expect(isCustomerAccountUser(null)).toBe(false);
  });
});

describe("PlatformAdminGuard × 客人帳號", () => {
  it("客人帳號 ⇒ 顯示原因、只登出後台 client(scope local)、不導去登入頁、不查超管身分", async () => {
    state.user = { id: "c1", app_metadata: { account_type: "customer" } };
    renderGuard();
    expect(await screen.findByTestId("customer-account-blocked")).toHaveTextContent(
      CUSTOMER_ACCOUNT_BLOCKED_MESSAGE,
    );
    await waitFor(() => expect(state.signOutCalls).toEqual([{ scope: "local" }]));
    expect(screen.queryByText("登入頁")).toBeNull();
    expect(screen.queryByText("超管畫面")).toBeNull();
    expect(state.platformAdminCalls).toBe(0);
  });

  it("一般帳號 ⇒ 照舊(超管畫面),不登出", async () => {
    state.user = { id: "a1", app_metadata: { provider: "email" } };
    renderGuard();
    expect(await screen.findByText("超管畫面")).toBeInTheDocument();
    expect(state.signOutCalls).toEqual([]);
  });
});
