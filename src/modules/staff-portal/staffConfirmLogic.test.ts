// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認 — 純函式測試。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第三節、第六節(vitest)。
import { describe, expect, it } from "vitest";

import type { MyBookingScheduleItem } from "./api";
import {
  canStaffConfirmBooking,
  countDayStatusBadges,
  countMyPendingConfirmations,
  PENDING_REMINDER_RANGE_DAYS,
} from "./staffConfirmLogic";

type Lite = Pick<MyBookingScheduleItem, "id" | "status" | "role_in_booking" | "start_at">;

function b(overrides: Partial<Lite> = {}): Lite {
  return {
    id: "b1",
    status: "pending_confirmation",
    role_in_booking: "primary",
    // 台北 2026-10-10 10:00
    start_at: "2026-10-10T02:00:00+00:00",
    ...overrides,
  };
}

describe("canStaffConfirmBooking:預約詳情「確認接單」按鈕顯示條件", () => {
  it("待確認 + 主要服務人員 ⇒ 顯示", () => {
    expect(canStaffConfirmBooking(b())).toBe(true);
  });

  it("協助人員 ⇒ 不顯示(主腦裁決 ①)", () => {
    expect(canStaffConfirmBooking(b({ role_in_booking: "assistant" }))).toBe(false);
  });

  it.each(["accepted", "completed", "cancelled", "pending_reply", "dispatching"])(
    "狀態 %s ⇒ 不顯示",
    (status) => {
      expect(canStaffConfirmBooking(b({ status }))).toBe(false);
    },
  );

  it("沒有選中的訂單 ⇒ 不顯示", () => {
    expect(canStaffConfirmBooking(null)).toBe(false);
    expect(canStaffConfirmBooking(undefined)).toBe(false);
  });
});

describe("countDayStatusBadges:月曆日期格兩色數量", () => {
  it("只算待確認、已確認;已完成、已取消不算(主腦裁決 ④)", () => {
    expect(
      countDayStatusBadges([
        b({ id: "1", status: "pending_confirmation" }),
        b({ id: "2", status: "pending_confirmation", role_in_booking: "assistant" }),
        b({ id: "3", status: "accepted" }),
        b({ id: "4", status: "completed" }),
        b({ id: "5", status: "cancelled" }),
      ]),
    ).toEqual({ pending: 2, accepted: 1 });
  });

  it("同一筆訂單只算一次", () => {
    expect(
      countDayStatusBadges([
        b({ id: "1", status: "accepted" }),
        b({ id: "1", status: "accepted" }),
      ]),
    ).toEqual({ pending: 0, accepted: 1 });
  });

  it("沒有資料 ⇒ 兩個都是 0", () => {
    expect(countDayStatusBadges(undefined)).toEqual({ pending: 0, accepted: 0 });
    expect(countDayStatusBadges([])).toEqual({ pending: 0, accepted: 0 });
  });
});

describe("countMyPendingConfirmations:鈴鐺「你有 N 筆訂單待確認」的 N", () => {
  const todayKey = "2026-10-10";

  it("只算主要服務人員 + 待確認 + 今天以後(含今天)", () => {
    expect(
      countMyPendingConfirmations(
        [
          b({ id: "today" }),
          b({ id: "future", start_at: "2026-11-01T02:00:00+00:00" }),
          b({ id: "assistant", role_in_booking: "assistant" }),
          b({ id: "accepted", status: "accepted" }),
          b({ id: "completed", status: "completed" }),
          b({ id: "yesterday", start_at: "2026-10-09T02:00:00+00:00" }),
        ],
        todayKey,
      ),
    ).toBe(2);
  });

  it("用台北日期判斷「今天」:台北 10/10 00:30(UTC 還是 10/9)算今天", () => {
    expect(
      countMyPendingConfirmations([b({ start_at: "2026-10-09T16:30:00+00:00" })], todayKey),
    ).toBe(1);
    // 台北 10/9 23:30 ⇒ 昨天,不算
    expect(
      countMyPendingConfirmations([b({ start_at: "2026-10-09T15:30:00+00:00" })], todayKey),
    ).toBe(0);
  });

  it("同一筆不重複計算;沒有資料是 0", () => {
    expect(countMyPendingConfirmations([b(), b()], todayKey)).toBe(1);
    expect(countMyPendingConfirmations(undefined, todayKey)).toBe(0);
  });

  it("查詢範圍不超過後端 get_my_booking_schedule 的 62 天上限", () => {
    expect(PENDING_REMINDER_RANGE_DAYS).toBeLessThanOrEqual(62);
  });
});
