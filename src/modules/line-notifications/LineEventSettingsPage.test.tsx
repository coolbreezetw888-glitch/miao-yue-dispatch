// 客戶端第 5 批 5-A(C5-K01):「LINE 通知事件」頁 —— 最上方是「通知客人」卡;5 張店家事件卡不再有「會員」勾選,
// 儲存時 notify_member 照原值送回(欄位保留,不影響既有資料)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ updates: [] as unknown[] }));

vi.mock("sonner", () => ({
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }),
}));

vi.mock("./RequireLineNotificationAccess", () => ({
  RequireLineNotificationAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./CustomerLineSettingsCard", () => ({
  CustomerLineSettingsCard: () => <div data-testid="customer-line-card">通知客人</div>,
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: {
      id: "m1",
      name: "涼風工匠",
      phone: null,
      booking_slug: "demo",
      industry_type: "on_site_dispatch",
    },
  }),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  const row = (event_type: string) => ({
    id: event_type,
    merchant_id: "m1",
    event_type,
    enabled: true,
    notify_admin: true,
    notify_agent: false,
    notify_staff: true,
    notify_member: true,
    message_template: "範本",
  });
  return {
    ...actual,
    useMerchantLineEventSettings: () => ({
      data: [
        "booking_created",
        "booking_confirmed",
        "booking_cancelled",
        "booking_completed",
        "staff_leave_created",
      ].map(row),
      isLoading: false,
    }),
    updateLineEventSetting: vi.fn(async (input: unknown) => {
      state.updates.push(input);
      return input;
    }),
  };
});

const { default: LineEventSettingsPage } = await import("./LineEventSettingsPage");

afterEach(() => cleanup());

describe("C5-K01 LINE 通知事件頁", () => {
  it("通知客人卡在最上方;店家事件區塊有指引;事件卡沒有「會員」勾選", async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <LineEventSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const customerCard = screen.getByTestId("customer-line-card");
    const firstEventCard = screen.getByTestId("line-event-card-booking_created");
    expect(
      customerCard.compareDocumentPosition(firstEventCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.body).toHaveTextContent("通知客人的設定在上方「通知客人」");
    for (const t of ["booking_created", "booking_confirmed", "staff_leave_created"]) {
      const card = screen.getByTestId(`line-event-card-${t}`);
      expect(within(card).queryByRole("button", { name: /會員/ })).toBeNull();
      expect(within(card).getByRole("button", { name: /商家管理員/ })).toBeInTheDocument();
    }

    await userEvent.click(
      within(screen.getByTestId("line-event-card-booking_created")).getByRole("button", {
        name: "儲存",
      }),
    );
    await waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0]).toMatchObject({ eventType: "booking_created", notifyMember: true });
  });
});
