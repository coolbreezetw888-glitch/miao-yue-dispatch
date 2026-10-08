// 客戶端第 3 批(C3-E01 / C3-F05):服務人員端預約詳情的「線上預約」「訪客預約」標示與提示。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));

import type { MyBookingScheduleItem } from "./api";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";

function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  return {
    id: "booking-1",
    start_at: "2026-10-13T02:00:00+00:00",
    end_at: "2026-10-13T03:00:00+00:00",
    status: "pending_confirmation",
    role_in_booking: "primary",
    customer_name: "<script>alert(1)</script>",
    customer_phone: "0912345678",
    customer_address: null,
    notes: null,
    customer_notes: null,
    service_item_names: ["室內機清洗"],
    final_amount_snapshot: 2500,
    is_member: false,
    member_name: null,
    member_points_balance: null,
    ...overrides,
  };
}

function renderDialog(booking: MyBookingScheduleItem) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MyBookingDetailDialog
        booking={booking}
        staffName="阿明"
        showCustomerAddress={false}
        open={true}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("服務人員端 × 客人線上預約(C3-E01)", () => {
  it("會員線上預約 ⇒「線上預約」標籤,沒有訪客提示", () => {
    renderDialog(makeBooking({ source: "customer", is_guest_booking: false }));
    expect(screen.getByTestId("booking-source-tag-online")).toHaveTextContent("線上預約");
    expect(screen.queryByTestId("guest-booking-hint")).toBeNull();
  });

  it("訪客 + 看得到電話 ⇒「訪客預約」+ 請自行電話確認;姓名純文字(C3-F05)", () => {
    renderDialog(makeBooking({ source: "customer", is_guest_booking: true }));
    expect(screen.getByTestId("booking-source-tag-guest")).toHaveTextContent("訪客預約");
    expect(screen.getByTestId("guest-booking-hint")).toHaveTextContent(
      "客人沒有登入，電話未經驗證，請自行與客戶電話確認。",
    );
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });

  it("訪客 + 關了顯示會員資料(看不到電話)⇒ 改「請與店家確認客人聯絡方式」", () => {
    renderDialog(makeBooking({ source: "customer", is_guest_booking: true, customer_phone: null }));
    expect(screen.getByTestId("guest-booking-hint")).toHaveTextContent(
      "客人沒有登入，請與店家確認客人聯絡方式。",
    );
  });

  it("一般訂單(舊版函式沒有 source)⇒ 不顯示任何標示", () => {
    renderDialog(makeBooking());
    expect(screen.queryByTestId("booking-source-tag-online")).toBeNull();
    expect(screen.queryByTestId("booking-source-tag-guest")).toBeNull();
  });
});
