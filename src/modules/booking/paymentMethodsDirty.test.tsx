// 第 11 批 J(#995 J-14):小卡窗代表 —— 付款方式新增 / 編輯的「填過資料」接線。
// 打開不改 ⇒ Esc 直接關;改一個字 ⇒ Esc 先問「確定放棄這次輸入？」。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetchMerchantPaymentMethodsAll: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));
vi.mock("./RequirePaymentMethodsAccess", () => ({
  RequirePaymentMethodsAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./context", () => ({
  useMerchantTaxSettings: () => ({
    data: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./api", () => ({
  addPaymentMethod: vi.fn(),
  fetchMerchantPaymentMethodsAll: m.fetchMerchantPaymentMethodsAll,
  reactivatePaymentMethod: vi.fn(),
  removePaymentMethod: vi.fn(),
  updatePaymentMethod: vi.fn(),
  upsertMerchantTaxSettings: vi.fn(),
}));

import PaymentMethodsPage from "./PaymentMethodsPage";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PaymentMethodsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.fetchMerchantPaymentMethodsAll.mockResolvedValue([
    {
      id: "pm1",
      merchant_id: "m1",
      name: "現金",
      description: null,
      status: "active",
      sort_order: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("付款方式小卡窗 × 填過資料才問放棄(第 11 批 J)", () => {
  it("新增:不填 ⇒ Esc 直接關;填名稱 ⇒ Esc 先問", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新增付款方式" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("確定放棄這次輸入？")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "新增付款方式" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(document.getElementById("payment-method-name") as HTMLElement, {
      target: { value: "轉帳" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(document.getElementById("payment-method-name")).toHaveValue("轉帳");
  });

  it("編輯:打開不改 ⇒ Esc 直接關;改一個字 ⇒ Esc 先問", async () => {
    renderPage();
    const row = (await screen.findByText("現金")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "編輯" }));
    let dialog = await screen.findByRole("dialog");
    expect(document.getElementById("payment-method-name")).toHaveValue("現金");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const row2 = (await screen.findByText("現金")).closest("li") as HTMLElement;
    fireEvent.click(within(row2).getByRole("button", { name: "編輯" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(document.getElementById("payment-method-name") as HTMLElement, {
      target: { value: "現金2" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
  });
});
