// 建單與訂單管理介面優化 §7.6:訂單管理頁重新設計的純邏輯單元測試——分頁籤篩選、關鍵字搜尋
// 比對範圍、日期分組(依建單時間/依預約時間切換)、業績加總排除已取消訂單。

import { describe, expect, it } from "vitest";

import {
  bookingMatchesKeyword,
  formatCardDateTime,
  formatGroupDateHeading,
  groupBookingsByDateField,
  ORDER_STATUS_TABS,
  ORDERS_RENDER_LIMIT,
  sumBookingRevenue,
  tabToStatusFilter,
  takeLatestBookings,
  type KeywordMatchableBooking,
} from "./ordersPageLogic";

describe("tabToStatusFilter", () => {
  it("「全部」分頁籤回傳 undefined,代表不限狀態", () => {
    expect(tabToStatusFilter("all")).toBeUndefined();
  });

  it("其他分頁籤回傳只含該狀態的陣列", () => {
    expect(tabToStatusFilter("pending_confirmation")).toEqual(["pending_confirmation"]);
    expect(tabToStatusFilter("accepted")).toEqual(["accepted"]);
    expect(tabToStatusFilter("completed")).toEqual(["completed"]);
    expect(tabToStatusFilter("cancelled")).toEqual(["cancelled"]);
  });

  it("分頁籤清單依序為全部/待確認/已確認/已完成/已取消", () => {
    expect(ORDER_STATUS_TABS.map((t) => t.key)).toEqual([
      "all",
      "pending_confirmation",
      "accepted",
      "completed",
      "cancelled",
    ]);
    expect(ORDER_STATUS_TABS.map((t) => t.label)).toEqual([
      "全部",
      "待確認",
      "已確認",
      "已完成",
      "已取消",
    ]);
  });
});

function makeBooking(overrides: Partial<KeywordMatchableBooking> = {}): KeywordMatchableBooking {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    customer_name: "王小明",
    customer_phone: "0912345678",
    customer_address: "台北市中山區南京東路 100 號",
    notes: "內部備註內容",
    customer_notes: "客戶備註內容",
    ...overrides,
  };
}

describe("bookingMatchesKeyword", () => {
  it("空關鍵字視為全部符合", () => {
    expect(bookingMatchesKeyword(makeBooking(), "")).toBe(true);
    expect(bookingMatchesKeyword(makeBooking(), "   ")).toBe(true);
  });

  it("比對客戶姓名", () => {
    expect(bookingMatchesKeyword(makeBooking(), "小明")).toBe(true);
    expect(bookingMatchesKeyword(makeBooking(), "小華")).toBe(false);
  });

  it("比對客戶電話", () => {
    expect(bookingMatchesKeyword(makeBooking(), "912345")).toBe(true);
  });

  it("比對客戶地址", () => {
    expect(bookingMatchesKeyword(makeBooking(), "南京東路")).toBe(true);
  });

  it("比對預約 id(單號)", () => {
    expect(bookingMatchesKeyword(makeBooking(), "2222-3333")).toBe(true);
  });

  it("比對內部備註", () => {
    expect(bookingMatchesKeyword(makeBooking(), "內部備註內容")).toBe(true);
  });

  it("比對客戶備註", () => {
    expect(bookingMatchesKeyword(makeBooking(), "客戶備註內容")).toBe(true);
  });

  it("customer_address/notes/customer_notes 是 null 時不會噴錯,視為不符合該欄位", () => {
    const booking = makeBooking({ customer_address: null, notes: null, customer_notes: null });
    expect(bookingMatchesKeyword(booking, "南京東路")).toBe(false);
    expect(bookingMatchesKeyword(booking, "小明")).toBe(true); // 其他欄位仍然比對得到
  });

  it("不分大小寫", () => {
    const booking = makeBooking({ customer_name: "John Doe" });
    expect(bookingMatchesKeyword(booking, "john")).toBe(true);
  });
});

describe("sumBookingRevenue", () => {
  it("排除已取消訂單的金額,其餘照加", () => {
    const bookings = [
      { status: "accepted" as const, final_amount_snapshot: 1000 },
      { status: "completed" as const, final_amount_snapshot: 500 },
      { status: "cancelled" as const, final_amount_snapshot: 9999 },
    ];
    expect(sumBookingRevenue(bookings)).toBe(1500);
  });

  it("空陣列回傳 0", () => {
    expect(sumBookingRevenue([])).toBe(0);
  });

  it("全部都是已取消時回傳 0", () => {
    expect(
      sumBookingRevenue([
        { status: "cancelled" as const, final_amount_snapshot: 100 },
        { status: "cancelled" as const, final_amount_snapshot: 200 },
      ]),
    ).toBe(0);
  });
});

describe("groupBookingsByDateField", () => {
  const bookings = [
    { id: "a", start_at: "2026-09-09T02:00:00+00:00", created_at: "2026-09-08T10:00:00+00:00" },
    { id: "b", start_at: "2026-09-10T02:00:00+00:00", created_at: "2026-09-08T11:00:00+00:00" },
    { id: "c", start_at: "2026-09-09T05:00:00+00:00", created_at: "2026-09-09T01:00:00+00:00" },
  ];

  it("依「依預約時間」(start_at)分組,日期新到舊排序", () => {
    const groups = groupBookingsByDateField(bookings, "start_at");
    // start_at 換算台北時間:a/c 都是 9/9 白天,b 是 9/10 白天(+8 小時)
    expect(groups.map((g) => g.dateKey)).toEqual(["2026-09-10", "2026-09-09"]);
    expect(groups[1]!.bookings.map((b) => b.id).sort()).toEqual(["a", "c"]);
    expect(groups[0]!.bookings.map((b) => b.id)).toEqual(["b"]);
  });

  it("依「依建單時間」(created_at)分組,結果跟依預約時間分組不同", () => {
    const groups = groupBookingsByDateField(bookings, "created_at");
    expect(groups.map((g) => g.dateKey)).toEqual(["2026-09-09", "2026-09-08"]);
    expect(groups[0]!.bookings.map((b) => b.id)).toEqual(["c"]);
    expect(groups[1]!.bookings.map((b) => b.id).sort()).toEqual(["a", "b"]);
  });

  it("空陣列回傳空分組", () => {
    expect(groupBookingsByDateField([], "start_at")).toEqual([]);
  });
});

describe("formatGroupDateHeading / formatCardDateTime", () => {
  it("格式為 M/D(週幾)", () => {
    expect(formatGroupDateHeading("2026-09-09")).toBe("9/9(三)");
  });

  it("formatCardDateTime 附加 HH:mm", () => {
    // 2026-09-09T02:00:00+00:00 換算台北時間是 9/9 10:00
    expect(formatCardDateTime("2026-09-09T02:00:00+00:00")).toBe("9/9(三) 10:00");
  });
});

// ---------------------------------------------------------------------------
// 2026-09-24 深夜巡檢問題 1:訂單管理頁改成 unpaged 撈取全部訂單(統計列的筆數/總業績跟關鍵字
// 搜尋才會正確),渲染則設上限避免一次畫出上萬張卡片。這裡測「挑出最新的 N 筆」這條純邏輯。
// ---------------------------------------------------------------------------
describe("takeLatestBookings(問題 1:撈全部、只渲染最新的 N 筆)", () => {
  function makeBooking(id: string, startAt: string, createdAt: string) {
    return { id, start_at: startAt, created_at: createdAt };
  }

  // 由舊到新,跟 fetchMerchantBookings 既有的 order by start_at ascending 一致。
  const bookings = [
    makeBooking("a", "2026-09-01T02:00:00+00:00", "2026-09-03T02:00:00+00:00"),
    makeBooking("b", "2026-09-02T02:00:00+00:00", "2026-09-02T02:00:00+00:00"),
    makeBooking("c", "2026-09-03T02:00:00+00:00", "2026-09-01T02:00:00+00:00"),
  ];

  it("總筆數沒超過上限時原封不動回傳(含順序),畫面跟改版前完全一致", () => {
    expect(takeLatestBookings(bookings, "start_at", 10)).toBe(bookings);
    expect(takeLatestBookings(bookings, "start_at", 3)).toBe(bookings);
  });

  it("超過上限時留下「依預約時間」最新的那幾筆,而且順序還原成由舊到新", () => {
    expect(takeLatestBookings(bookings, "start_at", 2).map((b) => b.id)).toEqual(["b", "c"]);
  });

  it("切換成「依建單時間」時,挑的是建單時間最新的那幾筆(跟依預約時間的結果不同)", () => {
    expect(takeLatestBookings(bookings, "created_at", 2).map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("不會改動傳進來的原始陣列(統計列仍然要用完整清單加總)", () => {
    const input = bookings.slice();
    takeLatestBookings(input, "start_at", 1);
    expect(input.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("上限 <= 0 時回傳空陣列,不會炸掉", () => {
    expect(takeLatestBookings(bookings, "start_at", 0)).toEqual([]);
  });

  it("預設上限就是 ORDERS_RENDER_LIMIT,超過的部分不渲染但仍可被統計", () => {
    const many = Array.from({ length: ORDERS_RENDER_LIMIT + 20 }, (_, i) =>
      makeBooking(
        `id-${i}`,
        `2026-09-09T${String(i % 24).padStart(2, "0")}:00:00+00:00`,
        "2026-09-09T02:00:00+00:00",
      ),
    );
    expect(takeLatestBookings(many, "start_at")).toHaveLength(ORDERS_RENDER_LIMIT);
    // 統計列用的是完整清單,不受渲染上限影響。
    expect(many).toHaveLength(ORDERS_RENDER_LIMIT + 20);
  });
});
