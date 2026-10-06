// SPECS-INDEX #984(規格書 .project/specs/商家端月曆兩色數字.md 三、測試 vitest):
// 商家端月曆兩色數字的計數函式 + 共用徽章元件。
//   ① 兩種狀態分開算(待確認 / 已確認);
//   ② 已完成、已取消、其他狀態不算;
//   ③ 協助人員不重複計算(同一張單主要與協助都在可見名單裡 ⇒ 只算一次;重複出現的同一張單也只算一次);
//   ④ 主要服務人員不在名單、但協助人員在 ⇒ 算;兩邊都不在 ⇒ 不算;
//   ⑤ 0 不顯示(兩顆都是 0 ⇒ 什麼都不畫;一顆是 0 ⇒ 只畫另一顆)。
//
// 【故障注入】(見回報)
//   a. 把 isCountedStatus 加上 completed ⇒「已完成不算」那條轉紅;
//   b. 把 seen 去重拿掉、改成主要可見 +1 再協助可見再 +1 ⇒「協助人員不重複計算」那條轉紅。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DayStatusCountBadges } from "./DayStatusCountBadges";
import {
  bookingIdsNeedingAssistantLookup,
  countMerchantDayStatusBadges,
} from "./merchantMonthBadges";
import { DEFAULT_BOOKING_STATUS_COLORS, type BookingStatus } from "./types";

afterEach(cleanup);

const A = "staff-a";
const B = "staff-b";
const GONE = "staff-gone"; // 已停用(不在時間軸欄位裡)
const visible = new Set([A, B]);

function bk(id: string, status: BookingStatus | string, staffId: string, startAt: string) {
  return { id, status: status as BookingStatus, staff_id: staffId, start_at: startAt };
}

// 台北 2026-10-07 10:00 = UTC 02:00
const D1 = "2026-10-07T02:00:00+00:00";
const D1_LATE = "2026-10-07T15:30:00+00:00"; // 台北 23:30,仍是 10/07
const D2 = "2026-10-07T16:30:00+00:00"; // 台北 10/08 00:30

describe("countMerchantDayStatusBadges", () => {
  it("待確認 / 已確認分開算,依台北日期分天", () => {
    const m = countMerchantDayStatusBadges(
      [
        bk("1", "pending_confirmation", A, D1),
        bk("2", "pending_confirmation", B, D1_LATE),
        bk("3", "accepted", A, D1),
        bk("4", "accepted", B, D2),
      ],
      visible,
    );
    expect(m.get("2026-10-07")).toEqual({ pending: 2, accepted: 1 });
    expect(m.get("2026-10-08")).toEqual({ pending: 0, accepted: 1 });
  });

  it("已完成、已取消、其他狀態不算;全部都不算的日期不出現", () => {
    const m = countMerchantDayStatusBadges(
      [
        bk("1", "completed", A, D1),
        bk("2", "cancelled", A, D1),
        bk("3", "some_future_status", A, D1),
        bk("4", "accepted", A, D2),
        bk("5", "completed", B, D2),
      ],
      visible,
    );
    expect(m.has("2026-10-07")).toBe(false);
    expect(m.get("2026-10-08")).toEqual({ pending: 0, accepted: 1 });
  });

  it("協助人員不重複計算:主要與協助都在可見名單 ⇒ 只算一次;同一張單重複出現也只算一次", () => {
    const assistants = new Map([["1", [B]]]);
    const m = countMerchantDayStatusBadges(
      [
        bk("1", "accepted", A, D1),
        bk("1", "accepted", A, D1),
        bk("2", "pending_confirmation", A, D1),
      ],
      visible,
      assistants,
    );
    expect(m.get("2026-10-07")).toEqual({ pending: 1, accepted: 1 });
  });

  it("主要服務人員不在名單、協助人員在 ⇒ 算一次;兩邊都不在 ⇒ 不算", () => {
    const assistants = new Map([
      ["x", [GONE, A, B]],
      ["y", [GONE]],
    ]);
    const m = countMerchantDayStatusBadges(
      [bk("x", "pending_confirmation", GONE, D1), bk("y", "accepted", GONE, D1)],
      visible,
      assistants,
    );
    expect(m.get("2026-10-07")).toEqual({ pending: 1, accepted: 0 });
  });

  it("只算可見服務人員的單;名單還沒載入(null)⇒ 什麼都不算", () => {
    const bookings = [bk("1", "accepted", GONE, D1)];
    expect(countMerchantDayStatusBadges(bookings, visible).size).toBe(0);
    expect(countMerchantDayStatusBadges([bk("1", "accepted", A, D1)], null).size).toBe(0);
    expect(countMerchantDayStatusBadges(undefined, visible).size).toBe(0);
  });
});

describe("bookingIdsNeedingAssistantLookup", () => {
  it("只挑「會被算的狀態 + 主要服務人員不在名單」的單,去重、排序;名單未載入回空", () => {
    const bookings = [
      bk("c", "accepted", GONE, D1),
      bk("a", "pending_confirmation", GONE, D1),
      bk("a", "pending_confirmation", GONE, D1),
      bk("b", "completed", GONE, D1),
      bk("d", "accepted", A, D1),
    ];
    expect(bookingIdsNeedingAssistantLookup(bookings, visible)).toEqual(["a", "c"]);
    expect(bookingIdsNeedingAssistantLookup(bookings, null)).toEqual([]);
  });
});

describe("DayStatusCountBadges", () => {
  it("兩顆都是 0 ⇒ 什麼都不畫", () => {
    const { container } = render(
      <DayStatusCountBadges
        pending={0}
        accepted={0}
        statusColors={DEFAULT_BOOKING_STATUS_COLORS}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("一顆是 0 ⇒ 只畫另一顆;顏色用商家自訂狀態色", () => {
    render(
      <DayStatusCountBadges
        pending={0}
        accepted={10}
        statusColors={{ ...DEFAULT_BOOKING_STATUS_COLORS, accepted: "#123456" }}
      />,
    );
    expect(screen.queryByTestId("day-pending-count")).toBeNull();
    const acc = screen.getByTestId("day-accepted-count");
    expect(acc.textContent).toBe("10");
    expect(acc.getAttribute("aria-label")).toBe("已確認 10 筆");
    expect(acc.style.backgroundColor).toBe("rgb(18, 52, 86)");
  });

  it("兩顆都有 ⇒ 待確認在前、已確認在後", () => {
    render(
      <DayStatusCountBadges
        pending={12}
        accepted={3}
        statusColors={{ ...DEFAULT_BOOKING_STATUS_COLORS, pendingConfirmation: "#ff0000" }}
      />,
    );
    const p = screen.getByTestId("day-pending-count");
    const a = screen.getByTestId("day-accepted-count");
    expect(p.textContent).toBe("12");
    expect(p.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(p.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
