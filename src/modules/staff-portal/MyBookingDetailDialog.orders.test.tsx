// SPECS-INDEX #977 第 7 批(2026-10-07):服務人員端預約詳情的「取消預約 / 編輯 / 標記完成」與已完成單的常駐 `!`(方案 A1)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const staffCancelBookingMock = vi.fn(async () => ({
  id: "booking-1",
  merchant_id: "m",
  status: "cancelled",
}));
const staffCompleteBookingMock = vi.fn(async () => ({
  id: "booking-1",
  merchant_id: "m",
  status: "completed",
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    staffCancelBooking: (...args: unknown[]) => staffCancelBookingMock(...(args as [])),
    staffCompleteBooking: (...args: unknown[]) => staffCompleteBookingMock(...(args as [])),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { MyBookingScheduleItem } from "./api";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";
import { AGENT_CANNOT_REVERSE_NOTE } from "@/modules/booking/completedBookingReversal";

function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  return {
    id: "booking-1",
    start_at: "2036-10-10T02:00:00+00:00",
    end_at: "2036-10-10T03:00:00+00:00",
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

function renderDialog(booking: MyBookingScheduleItem, canEditOrders: boolean, onEdit = vi.fn()) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MyBookingDetailDialog
        booking={booking}
        staffName="服務人員甲"
        showCustomerAddress={false}
        open
        onOpenChange={() => {}}
        canEditOrders={canEditOrders}
        onEdit={onEdit}
      />
    </QueryClientProvider>,
  );
  return { onEdit };
}

function footerCloseButtons() {
  return screen
    .getAllByRole("button")
    .filter((b) => b.textContent?.trim() === "關閉" && b.querySelector("svg") === null);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("服務人員端預約詳情(#977 第 7 批)", () => {
  it("開關生效 + 主要 + 待確認 ⇒ 取消預約 / 編輯 / 確認接單(沒有「關閉」鈕)", () => {
    const { onEdit } = renderDialog(makeBooking(), true);
    expect(screen.getByTestId("staff-cancel-booking-button")).toHaveTextContent("取消預約");
    expect(screen.getByTestId("staff-confirm-booking-button")).toBeInTheDocument();
    // 底部那顆文字就是「關閉」的按鈕(左上角 ✕ 的無障礙名稱也叫關閉,不算)。
    expect(footerCloseButtons()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("staff-edit-booking-button"));
    expect(onEdit).toHaveBeenCalledWith("booking-1");
  });

  it("已確認 ⇒ 取消預約 / 編輯 / 標記完成;按標記完成呼叫 staffCompleteBooking", async () => {
    renderDialog(makeBooking({ status: "accepted" }), true);
    expect(screen.queryByTestId("staff-confirm-booking-button")).toBeNull();
    fireEvent.click(screen.getByTestId("staff-complete-booking-button"));
    await waitFor(() => expect(staffCompleteBookingMock).toHaveBeenCalledWith("booking-1"));
  });

  it("取消預約 ⇒ 跟商家端同一個二次確認小卡窗,可填原因,確定後呼叫 staffCancelBooking", async () => {
    renderDialog(makeBooking({ status: "accepted" }), true);
    fireEvent.click(screen.getByTestId("staff-cancel-booking-button"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("確定要取消這筆預約嗎？")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText("取消原因(選填)"), {
      target: { value: "客人改期" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "確定取消" }));
    await waitFor(() =>
      expect(staffCancelBookingMock).toHaveBeenCalledWith("booking-1", "客人改期"),
    );
  });

  it("已完成 ⇒ 沒有按鈕,顯示跟客服同一句常駐說明(方案 A1)", () => {
    renderDialog(makeBooking({ status: "completed" }), true);
    expect(screen.getByTestId("staff-cannot-reverse-note")).toHaveTextContent(
      AGENT_CANNOT_REVERSE_NOTE,
    );
    expect(screen.queryByTestId("staff-cancel-booking-button")).toBeNull();
    expect(footerCloseButtons()).toHaveLength(1);
  });

  it("協助人員 / 開關沒生效 ⇒ 沒有新按鈕(維持第 4 批現況)", () => {
    renderDialog(makeBooking({ role_in_booking: "assistant", status: "accepted" }), true);
    expect(screen.queryByTestId("staff-cancel-booking-button")).toBeNull();
    expect(screen.queryByTestId("staff-edit-booking-button")).toBeNull();
    cleanup();
    renderDialog(makeBooking({ status: "accepted" }), false);
    expect(screen.queryByTestId("staff-cancel-booking-button")).toBeNull();
    expect(screen.queryByTestId("staff-complete-booking-button")).toBeNull();
  });
});
