// SPECS-INDEX #977 第 3 批(2026-10-06,使用者裁決 H-13):「服務人員是否顯示會員資料」關閉時,服務人員端預約詳情
// 只看得到客戶姓名,電話、地址都看不到。
//
// 後端:get_my_booking_schedule 關閉時 customer_phone / customer_address 直接回 null(pgTAP req977_02 驗)。
// 這支驗畫面:拿到 null 時**整列不顯示**(不是空白欄位、不是顯示「null」),客戶姓名照常顯示;
// 開啟時(後端有給值)照舊顯示可點的電話列與地址列。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { MyBookingScheduleItem } from "./api";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";

function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  return {
    id: "booking-1",
    start_at: "2026-10-06T02:00:00+00:00",
    end_at: "2026-10-06T03:00:00+00:00",
    status: "accepted",
    role_in_booking: "primary",
    customer_name: "陳先生",
    customer_phone: "0912345678",
    customer_address: "台北市信義區測試路 1 號",
    notes: null,
    customer_notes: null,
    service_item_names: ["冷氣清洗"],
    final_amount_snapshot: 1200,
    is_member: true,
    member_name: "陳大文",
    member_points_balance: 30,
    ...overrides,
  };
}

function renderDialog(booking: MyBookingScheduleItem) {
  render(
    <MyBookingDetailDialog
      booking={booking}
      staffName="服務人員甲"
      showCustomerAddress={true}
      open={true}
      onOpenChange={() => {}}
    />,
  );
}

afterEach(() => cleanup());

describe("服務人員端預約詳情:客戶聯絡資料依「服務人員是否顯示會員資料」顯示(#977)", () => {
  it("開啟(後端有回傳):姓名、可撥打的電話列、可導航的地址列、會員資料都顯示", () => {
    renderDialog(makeBooking());

    expect(screen.getByText("陳先生")).toBeTruthy();
    const phoneLink = document.querySelector('a[href^="tel:"]');
    expect(phoneLink?.getAttribute("href")).toBe("tel:0912345678");
    expect(screen.getByText("0912345678")).toBeTruthy();
    expect(screen.getByText("台北市信義區測試路 1 號")).toBeTruthy();
    expect(screen.getByText(/陳大文/)).toBeTruthy();
  });

  it("關閉(後端回 null):只看得到客戶姓名,電話列、地址列整列不顯示,也不會出現空白或「null」", () => {
    renderDialog(
      makeBooking({
        customer_phone: null,
        customer_address: null,
        is_member: null,
        member_name: null,
        member_points_balance: null,
      }),
    );

    // 前提:真的有把詳情畫出來(不是整個元件 return null 造成的假通過)。
    expect(screen.getByText("預約詳情")).toBeTruthy();
    expect(screen.getByText("陳先生")).toBeTruthy();

    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText("0912345678")).toBeNull();
    expect(screen.queryByText("台北市信義區測試路 1 號")).toBeNull();
    expect(screen.queryByText("會員")).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("null");
  });
});
