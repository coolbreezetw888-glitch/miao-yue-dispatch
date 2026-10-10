// SPECS-INDEX #1052 H2-03:編輯服務人員 > 權限功能,還沒上線的兩個開關(Google 日曆同步、施工圖片上傳)
// 先不顯示;資料庫原值保留,存檔照樣原值送回。

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

// 兩個還沒上線的開關刻意設成 true(不是預設值),才看得出存檔有沒有把它們洗掉。
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
  google_calendar_sync_enabled: true,
  can_create_edit_orders: false,
  can_upload_construction_photos: true,
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

const ON = {
  online_booking: true,
  staff_portal: true,
  staff_order_editing: true,
  line_notifications: true,
  push_notifications: true,
};

describe("編輯服務人員 × 還沒上線的權限開關(#1052 H2-03)", () => {
  it("Google 日曆同步、施工圖片上傳不顯示,也沒有「即將推出」", async () => {
    f.features = { ...ON };
    renderDialog();
    await screen.findByRole("button", { name: "儲存" });
    expect(screen.queryByRole("switch", { name: /服務人員Google日曆同步/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /服務人員施工圖片上傳/ })).toBeNull();
    expect(screen.queryByText("即將推出")).toBeNull();
    // 其他已上線的開關照常顯示
    expect(screen.getByRole("switch", { name: /商家後台編輯無時段限制/ })).toBeInTheDocument();
  });

  it("存檔時兩個隱藏開關的原值照樣送回(不被洗成 false)", async () => {
    f.features = { ...ON };
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "儲存" }));
    await waitFor(() => expect(m.updateMerchantStaff).toHaveBeenCalled());
    expect(m.updateMerchantStaff.mock.calls[0]![1]).toMatchObject({
      googleCalendarSyncEnabled: true,
      canUploadConstructionPhotos: true,
    });
  });
});
