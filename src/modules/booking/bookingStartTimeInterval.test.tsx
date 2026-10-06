// SPECS-INDEX #980 追加:營業時間設定頁的「建單時間間隔」卡片。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock, setMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  setMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("./api", () => ({
  BOOKING_START_TIME_INTERVAL_OPTIONS: [5, 10, 15, 30],
  fetchBookingStartTimeInterval: fetchMock,
  setBookingStartTimeInterval: setMock,
  upsertMerchantBusinessHours: vi.fn(),
  STRICT_CONFLICT_CHECK_FEATURE_KEY: "strict_conflict_check",
}));
vi.mock("@/modules/merchant/api", () => ({ getFeatureFlag: vi.fn(), setFeatureFlag: vi.fn() }));
vi.mock("@/modules/merchant/context", () => ({ useCurrentMerchant: () => ({ merchant: null }) }));
vi.mock("./context", () => ({ useMerchantBusinessHours: () => ({ data: [] }) }));
vi.mock("./RequireBusinessHoursAccess", () => ({
  RequireBusinessHoursAccess: ({ children }: { children: React.ReactNode }) => children,
}));

import { BookingStartTimeIntervalSetting } from "./BusinessHoursPage";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookingStartTimeIntervalSetting merchantId={MERCHANT_ID} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("建單時間間隔設定(#980 追加)", () => {
  it("沒有設定 ⇒ 顯示 30 分鐘;四個選項 5 / 10 / 15 / 30;說明用全形標點", async () => {
    fetchMock.mockResolvedValue(30);
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "30 分鐘" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    for (const m of [5, 10, 15]) {
      expect(screen.getByRole("radio", { name: `${m} 分鐘` })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
    expect(
      screen.getByText("建單時，時間選單每隔幾分鐘列一個可選的開始時間。"),
    ).toBeInTheDocument();
  });

  it("改成 5 分鐘 ⇒ 寫入 5", async () => {
    fetchMock.mockResolvedValue(30);
    setMock.mockResolvedValue(undefined);
    renderCard();
    const five = await screen.findByRole("radio", { name: "5 分鐘" });
    await act(async () => {
      fireEvent.click(five);
    });
    expect(setMock).toHaveBeenCalledWith(MERCHANT_ID, 5);
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("改成 15 分鐘 ⇒ 寫入 15;寫入失敗 ⇒ 錯誤 toast", async () => {
    fetchMock.mockResolvedValue(30);
    setMock.mockRejectedValue(new Error("沒有權限"));
    renderCard();
    const fifteen = await screen.findByRole("radio", { name: "15 分鐘" });
    await act(async () => {
      fireEvent.click(fifteen);
    });
    expect(setMock).toHaveBeenCalledWith(MERCHANT_ID, 15);
    expect(toastMock.error).toHaveBeenCalled();
  });
});
