// SPECS-INDEX #1025 功能開關 FG1-T03 / FG1-U06 第 5 點:商家設定 × 「客戶線上預約」功能開關。
//
//   1. 沒開通 ⇒「預約網址」區塊整個不顯示(其他欄位照常)
//   2. 讀取中(還不知道)⇒ 先不顯示
//   3. 開通 ⇒ 照常顯示預約網址代碼

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ onlineBooking: false as boolean | undefined }));

const MERCHANT = {
  id: "merchant-1",
  name: "測試店",
  industry_type: "in_store_beauty",
  address: null,
  phone: null,
  contact_email: null,
  intro: null,
  theme_preset: null,
  theme_custom_color: null,
  announcement_enabled: false,
  announcement_content: null,
  line_friend_url: null,
  booking_slug: "test-shop-slug",
  logo_url: null,
  status: "active",
};

vi.mock("./context", () => ({
  useCurrentMerchant: () => ({ merchant: MERCHANT, isLoading: false }),
  useRefetchAccessibleMerchants: () => vi.fn(),
}));
vi.mock("./features", () => ({
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
vi.mock("@/modules/staff-agent/RequireMerchantAdmin", () => ({
  RequireMerchantAdmin: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/booking/api", () => ({
  fetchOnlineBookingSettings: vi.fn(async () => null),
  saveOnlineBookingSettings: vi.fn(),
}));
vi.mock("@/modules/booking/context", () => ({
  useMerchantBookingStatusColors: () => ({ data: undefined, isLoading: true }),
  updateMerchantBookingStatusColors: vi.fn(),
  useMerchantCalendarStateStyles: () => ({ data: undefined, isLoading: true }),
  updateMerchantCalendarStateStyles: vi.fn(),
}));
vi.mock("@/modules/line-notifications/lineLoginApi", () => ({
  useMerchantLineLoginStatus: () => ({ data: undefined }),
}));
vi.mock("./MerchantAdminList", () => ({ MerchantAdminList: () => null }));
vi.mock("./LogoUploader", () => ({ LogoUploader: () => null }));
vi.mock("./ThemePresetPicker", () => ({ ThemePresetPicker: () => null }));

const { default: MerchantSettingsPage } = await import("./MerchantSettingsPage");

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/settings"]}>
        <MerchantSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  f.onlineBooking = false;
});

describe("商家設定 × 客戶線上預約功能開關(#1025 FG1-U06 第 5 點)", () => {
  it("沒開通 ⇒ 沒有「預約網址」區塊,其他欄位照常", async () => {
    f.onlineBooking = false;
    renderPage();
    expect(await screen.findByText("基本資料")).toBeInTheDocument();
    expect(screen.queryByText("預約網址")).not.toBeInTheDocument();
    expect(screen.queryByText("test-shop-slug")).not.toBeInTheDocument();
  });

  it("讀取中(還不知道)⇒ 先不顯示", async () => {
    f.onlineBooking = undefined;
    renderPage();
    expect(await screen.findByText("基本資料")).toBeInTheDocument();
    expect(screen.queryByText("test-shop-slug")).not.toBeInTheDocument();
  });

  it("開通 ⇒ 照常顯示預約網址代碼", async () => {
    f.onlineBooking = true;
    renderPage();
    expect(await screen.findByText("預約網址")).toBeInTheDocument();
    expect(screen.getByText("test-shop-slug")).toBeInTheDocument();
  });
});
