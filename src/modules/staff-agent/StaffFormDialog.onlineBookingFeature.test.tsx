// SPECS-INDEX #1025 功能開關 ⚠️6(FG1-U06 第 5 點 / FG1-T03):編輯服務人員 × 「客戶線上預約」功能開關。
//
//   1. 沒開通 ⇒ 只跟線上預約有關的 4 個欄位(最少要提前幾天預約、最遠可以預約到幾天後、
//      客戶預約無時段限制、客戶預約自動接受)不顯示;其他權限開關照常
//   2. 沒開通時存檔 ⇒ 這 4 個值照原值送回,不會被洗掉(做法:原值送回)
//   3. 開通 ⇒ 4 個欄位照常顯示

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantStaff } from "./types";

const m = vi.hoisted(() => ({
  updateMerchantStaff: vi.fn(),
  addMerchantStaff: vi.fn(),
  fetchStaffServiceItemIds: vi.fn(),
}));
const f = vi.hoisted(() => ({ onlineBooking: false as boolean | undefined }));

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
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => (key === "online_booking" ? f.onlineBooking : true),
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
  StaffLineBindingSection: () => null,
}));
vi.mock("@/modules/push-notifications/StaffPushSubscriptionSummary", () => ({
  StaffPushSubscriptionSummary: () => null,
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

const HIDDEN_FIELD_IDS = [
  "staff-advance_booking_days",
  "staff-booking_window_max_days",
  "staff-switch-no_time_slot_limit",
  "staff-switch-auto_accept_booking",
];

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.updateMerchantStaff.mockResolvedValue(undefined);
  m.fetchStaffServiceItemIds.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  f.onlineBooking = false;
});

describe("編輯服務人員 × 客戶線上預約功能開關(#1025 ⚠️6)", () => {
  it("沒開通 ⇒ 4 個線上預約欄位不顯示,其他權限開關照常", async () => {
    f.onlineBooking = false;
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    for (const id of HIDDEN_FIELD_IDS) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(document.getElementById("staff-switch-unlimited_backend_edit")).not.toBeNull();
    expect(document.getElementById("staff-switch-can_create_edit_orders")).not.toBeNull();
  });

  it("沒開通時存檔 ⇒ 4 個值照原值送回,不會被洗掉", async () => {
    f.onlineBooking = false;
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "儲存" }));
    await waitFor(() => expect(m.updateMerchantStaff).toHaveBeenCalled());
    expect(m.updateMerchantStaff.mock.calls[0]![1]).toMatchObject({
      advanceBookingDays: 3,
      bookingWindowMaxDays: 60,
      noTimeSlotLimit: true,
      autoAcceptBooking: true,
    });
  });

  it("讀取中(還不知道)⇒ 也先不顯示", async () => {
    f.onlineBooking = undefined;
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    for (const id of HIDDEN_FIELD_IDS) {
      expect(document.getElementById(id), id).toBeNull();
    }
  });

  it("開通 ⇒ 4 個欄位照常顯示", async () => {
    f.onlineBooking = true;
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    for (const id of HIDDEN_FIELD_IDS) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});
