// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員端預約詳情「確認接單」按鈕 + 狀態標籤用商家自訂顏色。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第三節第 1、2 點。
//
//   ・待確認 + 主要服務人員 ⇒ 底部出現「確認接單」;協助人員、已確認、已完成、已取消都不出現
//   ・按下 ⇒ 呼叫 staffConfirmBooking(後端 staff_confirm_booking)⇒ 成功提示 ⇒ 立刻 invalidate 行事曆查詢
//     (my-booking-schedule / my-day-schedule-state),不只等即時同步
//   ・#1008(第 14 批):成功 ⇒ 自動關掉詳情(onOpenChange(false));失敗 ⇒ 不關
//   ・失敗 ⇒ 顯示後端的中文原因
//   ・標題列狀態標籤吃商家自訂顏色(跟列表卡片同一份)
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const staffConfirmBookingMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    staffConfirmBooking: (...args: unknown[]) => staffConfirmBookingMock(...args),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import type { MyBookingScheduleItem } from "./api";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";

function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  return {
    id: "booking-1",
    start_at: "2026-10-10T02:00:00+00:00",
    end_at: "2026-10-10T03:00:00+00:00",
    status: "pending_confirmation",
    role_in_booking: "primary",
    customer_name: "陳先生",
    customer_phone: null,
    customer_address: null,
    notes: null,
    customer_notes: null,
    service_item_names: ["冷氣清洗"],
    final_amount_snapshot: 1200,
    is_member: null,
    member_name: null,
    member_points_balance: null,
    ...overrides,
  };
}

const STATUS_COLORS = {
  pendingConfirmation: "#662deb",
  accepted: "#ff42dc",
  completed: "#07cf68",
  cancelled: "#ffaa33",
};

let queryClient: QueryClient;
let onOpenChangeMock: ReturnType<typeof vi.fn>;

function renderDialog(booking: MyBookingScheduleItem) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MyBookingDetailDialog
        booking={booking}
        staffName="服務人員甲"
        showCustomerAddress={false}
        statusColors={STATUS_COLORS}
        open={true}
        onOpenChange={onOpenChangeMock}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  staffConfirmBookingMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  onOpenChangeMock = vi.fn();
});

afterEach(() => cleanup());

describe("服務人員端預約詳情:確認接單按鈕(#977 第 4 批)", () => {
  it("待確認 + 主要服務人員 ⇒ 出現「確認接單」", () => {
    renderDialog(makeBooking());
    expect(screen.getByTestId("staff-confirm-booking-button").textContent).toBe("確認接單");
  });

  it.each([
    ["協助人員", { role_in_booking: "assistant" as const }],
    ["已確認", { status: "accepted" }],
    ["已完成", { status: "completed" }],
    ["已取消", { status: "cancelled" }],
  ])("%s ⇒ 不出現按鈕(詳情照常顯示)", (_label, overrides) => {
    renderDialog(makeBooking(overrides));
    expect(screen.getByText("預約詳情")).toBeTruthy();
    expect(screen.queryByTestId("staff-confirm-booking-button")).toBeNull();
    expect(screen.queryByText("確認接單")).toBeNull();
  });

  it("按下 ⇒ 呼叫後端、成功提示、立刻重查行事曆", async () => {
    staffConfirmBookingMock.mockResolvedValue(undefined);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderDialog(makeBooking());

    fireEvent.click(screen.getByTestId("staff-confirm-booking-button"));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("已確認接單"));
    expect(staffConfirmBookingMock).toHaveBeenCalledTimes(1);
    expect(staffConfirmBookingMock.mock.calls[0]?.[0]).toBe("booking-1");
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["staff-portal-module", "my-booking-schedule"]));
    expect(keys).toContain(JSON.stringify(["staff-portal-module", "my-day-schedule-state"]));
    // #1008(第 14 批,#977 使用者裁決):成功後自動關掉詳情,回到行事曆卡片列表。
    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });

  it("後端擋下 ⇒ 顯示後端的中文原因,不顯示成功", async () => {
    staffConfirmBookingMock.mockRejectedValue(new Error("這筆訂單已經不是待確認狀態，請重新整理"));
    renderDialog(makeBooking());

    fireEvent.click(screen.getByTestId("staff-confirm-booking-button"));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe("確認接單失敗");
    expect(JSON.stringify(toastErrorMock.mock.calls[0]?.[1])).toContain(
      "這筆訂單已經不是待確認狀態",
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // #1008:失敗時維持停在詳情,不關。
    expect(onOpenChangeMock).not.toHaveBeenCalled();
  });
});

describe("服務人員端預約詳情:狀態標籤用商家自訂顏色(#977 第 4 批順手修)", () => {
  it.each([
    ["pending_confirmation", "待確認", "rgb(102, 45, 235)"],
    ["accepted", "已確認", "rgb(255, 66, 220)"],
  ])("%s ⇒ 標籤底色是商家設定的顏色", (status, label, rgb) => {
    renderDialog(makeBooking({ status }));
    const tag = screen.getByText(label);
    const styled = tag.closest("[style]") as HTMLElement | null;
    expect(styled?.style.backgroundColor).toBe(rgb);
  });
});
