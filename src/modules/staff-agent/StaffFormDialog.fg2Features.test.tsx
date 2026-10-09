// SPECS-INDEX #1025 功能開關 第 2 批(QA M1):編輯服務人員 × LINE 通知 / 手機推播通知。
//
//   1. 全開 ⇒「LINE 綁定」區塊、「推播裝置」摘要都顯示(照舊)
//   2. LINE 通知關 ⇒ 不顯示 LINE 綁定區塊;推播照常
//   3. 手機推播關 ⇒ 不顯示推播裝置摘要;LINE 照常
//   4. 讀取中(還不知道)⇒ 兩個都先不顯示

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantStaff } from "./types";

const m = vi.hoisted(() => ({
  updateMerchantStaff: vi.fn(),
  addMerchantStaff: vi.fn(),
  fetchStaffServiceItemIds: vi.fn(),
}));
const f = vi.hoisted(() => ({ features: {} as Record<string, boolean | undefined> }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./api", () => ({
  updateMerchantStaff: m.updateMerchantStaff,
  addMerchantStaff: m.addMerchantStaff,
  fetchStaffServiceItemIds: m.fetchStaffServiceItemIds,
  addStaffServiceItem: vi.fn(),
  removeStaffServiceItem: vi.fn(),
  uploadStaffAvatar: vi.fn(),
}));
vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    onlineBooking: "online_booking",
    dataImport: "data_import",
    reportExport: "report_export",
    staffPortal: "staff_portal",
    staffOrderEditing: "staff_order_editing",
    lineNotifications: "line_notifications",
    lineMarketing: "line_marketing",
    pushNotifications: "push_notifications",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => f.features[key],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/modules/service-items/context", () => ({
  getServiceItem: vi.fn(async () => null),
  useMerchantServiceItems: () => ({ data: [], isLoading: false }),
  useMerchantServiceCategories: () => ({ data: [] }),
}));
vi.mock("@/modules/booking/context", () => ({
  useStaffAvailabilityWindows: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/modules/line-notifications/StaffLineBindingSection", () => ({
  StaffLineBindingSection: () => <div data-testid="staff-line-binding-section" />,
}));
vi.mock("@/modules/push-notifications/StaffPushSubscriptionSummary", () => ({
  StaffPushSubscriptionSummary: () => <div data-testid="staff-push-summary" />,
}));

const { StaffFormDialog } = await import("./StaffListPage");

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto["hasPointerCapture"] ??= () => false;
  proto["releasePointerCapture"] ??= () => undefined;
  proto["scrollIntoView"] ??= () => undefined;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// 這 4 個欄位刻意設成「不是預設值」,才看得出存檔有沒有把它們洗掉。
const STAFF = {
  id: "staff-1",
  merchant_id: "merchant-1",
  name: "服務人員甲",
  phone: "0912345678",
  compensation_type: "piece_rate",
  is_listed: true,
  status: "active",
  advance_booking_days: 3,
  booking_window_max_days: 60,
  no_time_slot_limit: true,
  auto_accept_booking: true,
  unlimited_backend_edit: false,
  direct_accept_after_merchant_confirm: false,
  show_member_info: false,
  google_calendar_sync_enabled: false,
  can_create_edit_orders: false,
  can_upload_construction_photos: false,
} as unknown as MerchantStaff;

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StaffFormDialog
          merchantId="merchant-1"
          staff={STAFF}
          open
          onOpenChange={() => undefined}
          onSaved={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.updateMerchantStaff.mockResolvedValue(undefined);
  m.fetchStaffServiceItemIds.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  f.features = {};
});

const ON = { online_booking: true, staff_portal: true, staff_order_editing: true };

describe("編輯服務人員 × LINE / 推播功能開關(#1025 FG2,QA M1)", () => {
  it("全開 ⇒ LINE 綁定區塊、推播裝置摘要都顯示", async () => {
    f.features = { ...ON, line_notifications: true, push_notifications: true };
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    expect(screen.getByTestId("staff-line-binding-section")).toBeInTheDocument();
    expect(screen.getByTestId("staff-push-summary")).toBeInTheDocument();
  });

  it("LINE 通知關 ⇒ 不顯示 LINE 綁定區塊;推播照常", async () => {
    f.features = { ...ON, line_notifications: false, push_notifications: true };
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    expect(screen.queryByTestId("staff-line-binding-section")).not.toBeInTheDocument();
    expect(screen.getByTestId("staff-push-summary")).toBeInTheDocument();
  });

  it("手機推播關 ⇒ 不顯示推播裝置摘要;LINE 照常", async () => {
    f.features = { ...ON, line_notifications: true, push_notifications: false };
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    expect(screen.queryByTestId("staff-push-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("staff-line-binding-section")).toBeInTheDocument();
  });

  it("讀取中(還不知道)⇒ 兩個都先不顯示", async () => {
    f.features = { ...ON };
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    expect(screen.queryByTestId("staff-line-binding-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("staff-push-summary")).not.toBeInTheDocument();
  });
});
