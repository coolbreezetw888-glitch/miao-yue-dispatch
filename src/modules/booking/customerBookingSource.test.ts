// 客戶端第 3 批(C3-E01):「線上預約」「訪客預約」標示與建單人文字。
import { describe, expect, it } from "vitest";

import {
  customerBookingCreatorLabel,
  customerBookingSourceKind,
  GUEST_BOOKING_BACKEND_HINT,
  GUEST_BOOKING_STAFF_HIDDEN_PHONE_HINT,
  guestBookingStaffHint,
} from "./customerBookingSource";

describe("C3-E01 標籤判斷", () => {
  it("只有 source=customer 才標;訪客看 is_guest_booking", () => {
    expect(customerBookingSourceKind({ source: "customer", is_guest_booking: false })).toBe(
      "online",
    );
    expect(customerBookingSourceKind({ source: "customer", is_guest_booking: true })).toBe("guest");
    for (const source of ["manual", "smart", "import", null, undefined]) {
      expect(customerBookingSourceKind({ source, is_guest_booking: true })).toBeNull();
    }
  });

  it("建單人:客人送出的單不顯示「(已移除的人員)」", () => {
    expect(customerBookingCreatorLabel({ source: "customer", is_guest_booking: false })).toBe(
      "客人（線上預約）",
    );
    expect(customerBookingCreatorLabel({ source: "customer", is_guest_booking: true })).toBe(
      "訪客（線上預約）",
    );
    expect(customerBookingCreatorLabel({ source: "manual" })).toBeNull();
  });

  it("提示句(第七章原文 / 服務人員看不到電話的版本)", () => {
    expect(GUEST_BOOKING_BACKEND_HINT).toBe("客人沒有登入，電話未經驗證，請自行與客戶電話確認。");
    expect(guestBookingStaffHint(true)).toBe(GUEST_BOOKING_BACKEND_HINT);
    expect(guestBookingStaffHint(false)).toBe(GUEST_BOOKING_STAFF_HIDDEN_PHONE_HINT);
    expect(GUEST_BOOKING_STAFF_HIDDEN_PHONE_HINT).toBe("客人沒有登入，請與店家確認客人聯絡方式。");
  });
});
