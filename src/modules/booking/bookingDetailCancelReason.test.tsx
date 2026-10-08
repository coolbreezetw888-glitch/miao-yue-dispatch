// 客戶端第 4 批(C4-D07):後台訂單詳細(訂單管理 / 行事曆共用 BookingDetailDialog)對已取消的單顯示「取消原因：〇〇」。
// mock 寫法沿用 bookingDetailCommission.test.tsx。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  fetchBookingCommissionSummary: vi.fn(),
  recalculateBookingCommission: vi.fn(),
  role: { current: "admin" as string | null | undefined },
  perms: { current: {} as Record<string, boolean | null | undefined> },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("./api", () => ({
  getBooking: mocks.getBooking,
  getBookingPointsLedger: vi.fn(async () => null),
  fetchCompletedBookingReversalPreview: vi.fn(),
  revertCompletedBooking: vi.fn(),
  cancelCompletedBooking: vi.fn(),
  cancelBooking: vi.fn(),
  completeBooking: vi.fn(),
  confirmBooking: vi.fn(),
  removeBookingAssistant: vi.fn(),
  getCustomerRelatedBookings: vi.fn(async () => []),
}));

vi.mock("@/modules/payroll/api", () => ({
  fetchBookingCommissionSummary: mocks.fetchBookingCommissionSummary,
  recalculateBookingCommission: mocks.recalculateBookingCommission,
}));

vi.mock("./context", () => ({
  useBookingStatusChangeLogs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: "merchant-1", name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: mocks.role.current, isLoading: false }),
  useAgentPermission: (key: string) => ({ data: mocks.perms.current[key] }),
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
  usePendingLineNotificationPreview: () => ({ refetch: vi.fn() }),
}));

vi.mock("@/modules/line-notifications/ConfirmBookingLineDialog", () => ({
  ConfirmBookingLineDialog: () => null,
}));

import { BookingDetailDialog } from "./BookingDetailDialog";
import { cancelReasonText } from "./cancelReasonDisplay";

const BOOKING_ID = "booking-1";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    merchant_id: "merchant-1",
    staff_id: "staff-1",
    status: "completed",
    start_at: "2026-09-30T06:00:00Z",
    end_at: "2026-09-30T07:00:00Z",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    assistants: [],
    createdByName: "客服甲",
    lastModifiedByName: null,
    last_modified_at: null,
    created_at: "2026-09-29T06:00:00Z",
    serviceItems: [{ id: "i-1", name: "清洗", quantity: 1, lineTotal: 12000 }],
    subtotal_amount_snapshot: 12000,
    custom_total_amount_enabled: false,
    discount_enabled: false,
    tax_enabled: false,
    final_amount_snapshot: 12000,
    payment_method_name_snapshot: "現金",
    materialCosts: [{ materialCostItemId: "mc-1", name: "冷媒", quantity: 1, amountSnapshot: 500 }],
    customer_name: "王小美",
    customer_phone: "0912345678",
    customer_address: null,
    customer_notes: null,
    notes: null,
    hide_notes_from_staff: false,
    member_id: null,
    member_name_snapshot: null,
    points_planned: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderDialog() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BookingDetailDialog
          bookingId={BOOKING_ID}
          staffNameById={new Map([["staff-1", "服務人員甲"]])}
          open
          onOpenChange={vi.fn()}
          onChanged={vi.fn()}
          onEdit={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.role.current = "admin";
  mocks.perms.current = {};
  mocks.fetchBookingCommissionSummary.mockResolvedValue({ has_record: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("C4-D07 取消原因(純函式)", () => {
  it("只有已取消且有填原因才顯示", () => {
    expect(cancelReasonText({ status: "cancelled", cancelled_reason: "客人線上取消" })).toBe(
      "取消原因：客人線上取消",
    );
    expect(cancelReasonText({ status: "cancelled", cancelled_reason: "  " })).toBeNull();
    expect(cancelReasonText({ status: "cancelled", cancelled_reason: null })).toBeNull();
    expect(cancelReasonText({ status: "accepted", cancelled_reason: "舊原因" })).toBeNull();
  });
});

describe("C4-D07 預約詳情", () => {
  it("已取消 + 客人線上取消 ⇒ 顯示「取消原因：客人線上取消」", async () => {
    mocks.getBooking.mockResolvedValue(
      booking({ status: "cancelled", cancelled_reason: "客人線上取消" }),
    );
    renderDialog();
    expect(await screen.findByTestId("booking-cancel-reason")).toHaveTextContent(
      "取消原因：客人線上取消",
    );
  });

  it("店家填的原因是純文字(不解析 HTML),保留換行", async () => {
    mocks.getBooking.mockResolvedValue(
      booking({ status: "cancelled", cancelled_reason: "<b>客人改期</b>\n下週再約" }),
    );
    renderDialog();
    const row = await screen.findByTestId("booking-cancel-reason");
    expect(row.textContent).toBe("取消原因：<b>客人改期</b>\n下週再約");
    expect(row.querySelector("b")).toBeNull();
    expect(row.className).toContain("whitespace-pre-line");
  });

  it("沒有原因 / 不是已取消 ⇒ 不顯示", async () => {
    mocks.getBooking.mockResolvedValue(booking({ status: "cancelled", cancelled_reason: null }));
    renderDialog();
    await screen.findByText("王小美");
    expect(screen.queryByTestId("booking-cancel-reason")).toBeNull();
    cleanup();
    mocks.getBooking.mockResolvedValue(
      booking({ status: "completed", cancelled_reason: "舊原因" }),
    );
    renderDialog();
    await screen.findByText("王小美");
    expect(screen.queryByTestId("booking-cancel-reason")).toBeNull();
  });
});
