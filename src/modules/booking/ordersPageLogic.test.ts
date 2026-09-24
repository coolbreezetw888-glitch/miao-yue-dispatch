// 建單與訂單管理介面優化 §7.6:訂單管理頁重新設計的純邏輯單元測試——分頁籤篩選、關鍵字搜尋
// 比對範圍、日期分組(依建單時間/依預約時間切換)、業績加總排除已取消訂單。

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adjustPageForPageSizeChange,
  bookingMatchesKeyword,
  clampOrdersPage,
  DEFAULT_ORDERS_PAGE_SIZE,
  formatCardDateTime,
  formatGroupDateHeading,
  groupBookingsByDateField,
  isOrdersPageSize,
  ORDER_STATUS_TABS,
  ORDERS_PAGE_SIZE_OPTIONS,
  ORDERS_PAGE_SIZE_STORAGE_KEY,
  readStoredOrdersPageSize,
  sliceBookingsForPage,
  sumBookingRevenue,
  tabToStatusFilter,
  writeStoredOrdersPageSize,
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
// 2026-09-24 使用者裁決:原本「只渲染最新 500 筆、更早的看不到」的硬性截斷(takeLatestBookings,
// 已移除)改成**真正的分頁**——資料層仍然撈全部(統計列的筆數/總業績跟關鍵字搜尋才正確),
// 畫面層一次只渲染一頁,翻頁就看得到更早的訂單。
//
// 這裡測分頁切片這條純函式的完整行為:邊界(剛好整除、最後一頁不滿、總數 0、總數小於每頁筆數)、
// 頁碼超出範圍、每頁筆數改變時頁碼怎麼調整、以及「分頁不會漏掉或重複任何一筆訂單」。
// ---------------------------------------------------------------------------

/** 產生 count 筆「由舊到新」的訂單(跟 fetchMerchantBookings 既有的 order by start_at
 * ascending 一致),start_at 依序遞增,created_at 刻意是**相反**方向(遞減),這樣才測得出
 * 「依建單時間」跟「依預約時間」兩種模式挑出來的頁面內容真的不同。 */
function makePagingBookings(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    // 2026-01-01 起每筆隔一天,不會超出月份天數上限的寫法:直接用毫秒加總。
    start_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    created_at: new Date(Date.UTC(2026, 0, 1) + (count - i) * 86400000).toISOString(),
  }));
}

describe("sliceBookingsForPage(分頁切片)", () => {
  it("剛好整除:100 筆 / 每頁 50 = 2 頁,每頁都滿", () => {
    const bookings = makePagingBookings(100);
    const first = sliceBookingsForPage(bookings, "start_at", 1, 50);
    expect(first.totalPages).toBe(2);
    expect(first.totalCount).toBe(100);
    expect(first.bookings).toHaveLength(50);
    expect(first.rangeStart).toBe(1);
    expect(first.rangeEnd).toBe(50);

    const second = sliceBookingsForPage(bookings, "start_at", 2, 50);
    expect(second.bookings).toHaveLength(50);
    expect(second.rangeStart).toBe(51);
    expect(second.rangeEnd).toBe(100);
  });

  it("最後一頁不滿:105 筆 / 每頁 50 = 3 頁,第 3 頁只有 5 筆", () => {
    const bookings = makePagingBookings(105);
    const last = sliceBookingsForPage(bookings, "start_at", 3, 50);
    expect(last.totalPages).toBe(3);
    expect(last.page).toBe(3);
    expect(last.bookings).toHaveLength(5);
    expect(last.rangeStart).toBe(101);
    expect(last.rangeEnd).toBe(105);
  });

  it("總數 0:總頁數仍是 1(顯示成「第 1 / 1 頁」),清單空的,起訖筆數都是 0", () => {
    const slice = sliceBookingsForPage([], "start_at", 1, 50);
    expect(slice.totalCount).toBe(0);
    expect(slice.totalPages).toBe(1);
    expect(slice.page).toBe(1);
    expect(slice.bookings).toEqual([]);
    expect(slice.rangeStart).toBe(0);
    expect(slice.rangeEnd).toBe(0);
  });

  it("總數小於每頁筆數:只有一頁,全部訂單都在第 1 頁(順序維持由舊到新)", () => {
    const bookings = makePagingBookings(7);
    const slice = sliceBookingsForPage(bookings, "start_at", 1, 50);
    expect(slice.totalPages).toBe(1);
    expect(slice.bookings.map((b) => b.id)).toEqual(bookings.map((b) => b.id));
    expect(slice.rangeStart).toBe(1);
    expect(slice.rangeEnd).toBe(7);
  });

  it("第 1 頁是「最新」的那一頁,往後翻是更早的訂單", () => {
    const bookings = makePagingBookings(10); // id-0(最舊) ... id-9(最新)
    const first = sliceBookingsForPage(bookings, "start_at", 1, 5);
    const second = sliceBookingsForPage(bookings, "start_at", 2, 5);
    // 每一頁內部還原成由舊到新,所以第 1 頁是 id-5 ~ id-9。
    expect(first.bookings.map((b) => b.id)).toEqual(["id-5", "id-6", "id-7", "id-8", "id-9"]);
    expect(second.bookings.map((b) => b.id)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
  });

  it("切換成「依建單時間」時,同一頁挑出來的是建單時間最新的那些(跟依預約時間不同)", () => {
    const bookings = makePagingBookings(10); // created_at 方向跟 start_at 相反
    const byStart = sliceBookingsForPage(bookings, "start_at", 1, 5);
    const byCreated = sliceBookingsForPage(bookings, "created_at", 1, 5);
    expect(byCreated.bookings.map((b) => b.id)).toEqual(["id-4", "id-3", "id-2", "id-1", "id-0"]);
    expect(byCreated.bookings.map((b) => b.id)).not.toEqual(byStart.bookings.map((b) => b.id));
  });

  it("分頁不會漏掉也不會重複任何一筆訂單(所有頁串起來剛好等於全部)", () => {
    const bookings = makePagingBookings(23);
    const collected: string[] = [];
    for (let page = 1; page <= 3; page++) {
      collected.push(
        ...sliceBookingsForPage(bookings, "start_at", page, 10).bookings.map((b) => b.id),
      );
    }
    expect(collected).toHaveLength(23);
    expect(new Set(collected).size).toBe(23);
    expect(collected.slice().sort()).toEqual(bookings.map((b) => b.id).sort());
  });

  it("頁碼超出範圍一律夾回合法範圍(不會出現空白的第 5 頁)", () => {
    const bookings = makePagingBookings(30); // 每頁 10 → 3 頁
    expect(sliceBookingsForPage(bookings, "start_at", 999, 10).page).toBe(3);
    expect(sliceBookingsForPage(bookings, "start_at", 999, 10).bookings).toHaveLength(10);
    expect(sliceBookingsForPage(bookings, "start_at", 0, 10).page).toBe(1);
    expect(sliceBookingsForPage(bookings, "start_at", -7, 10).page).toBe(1);
    expect(sliceBookingsForPage(bookings, "start_at", Number.NaN, 10).page).toBe(1);
  });

  it("每頁筆數不合法(0/負數/NaN)時退回預設值,不會回傳空清單", () => {
    const bookings = makePagingBookings(60);
    for (const bad of [0, -10, Number.NaN]) {
      const slice = sliceBookingsForPage(bookings, "start_at", 1, bad);
      expect(slice.pageSize).toBe(DEFAULT_ORDERS_PAGE_SIZE);
      expect(slice.bookings).toHaveLength(DEFAULT_ORDERS_PAGE_SIZE);
      expect(slice.totalPages).toBe(2);
    }
  });

  it("不會改動傳進來的原始陣列(統計列/總業績仍然要用完整清單加總)", () => {
    const bookings = makePagingBookings(5);
    const idsBefore = bookings.map((b) => b.id);
    sliceBookingsForPage(bookings, "created_at", 1, 2);
    expect(bookings.map((b) => b.id)).toEqual(idsBefore);
  });
});

describe("clampOrdersPage", () => {
  it("夾在 1 ~ totalPages 之間", () => {
    expect(clampOrdersPage(0, 5)).toBe(1);
    expect(clampOrdersPage(3, 5)).toBe(3);
    expect(clampOrdersPage(9, 5)).toBe(5);
  });

  it("totalPages 不合法時至少當成 1 頁", () => {
    expect(clampOrdersPage(3, 0)).toBe(1);
    expect(clampOrdersPage(3, Number.NaN)).toBe(1);
  });

  it("頁碼是 NaN 時回到第 1 頁", () => {
    expect(clampOrdersPage(Number.NaN, 5)).toBe(1);
  });
});

describe("adjustPageForPageSizeChange(每頁筆數改變時的頁碼調整)", () => {
  it("第 1 頁永遠還是第 1 頁", () => {
    expect(adjustPageForPageSizeChange(1, 50, 500)).toBe(1);
    expect(adjustPageForPageSizeChange(1, 500, 50)).toBe(1);
  });

  it("每頁筆數變大時,讓目前這一頁的第一筆仍然落在畫面上", () => {
    // 每頁 50 的第 3 頁 = 第 101 筆起;改成每頁 100 之後,第 101 筆落在第 2 頁。
    expect(adjustPageForPageSizeChange(3, 50, 100)).toBe(2);
    // 每頁 50 的第 2 頁 = 第 51 筆起;改成每頁 500 之後仍在第 1 頁。
    expect(adjustPageForPageSizeChange(2, 50, 500)).toBe(1);
  });

  it("每頁筆數變小時頁碼會往後推(同一筆訂單會落在更後面的頁)", () => {
    // 每頁 100 的第 2 頁 = 第 101 筆起;改成每頁 50 之後,第 101 筆落在第 3 頁。
    expect(adjustPageForPageSizeChange(2, 100, 50)).toBe(3);
  });

  it("輸入不合法時退回第 1 頁", () => {
    expect(adjustPageForPageSizeChange(Number.NaN, 50, 100)).toBe(1);
    expect(adjustPageForPageSizeChange(3, 0, 100)).toBe(1);
    expect(adjustPageForPageSizeChange(3, 50, 0)).toBe(1);
  });
});

describe("每頁筆數選項與 localStorage 記憶", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("選項含 50/100/200/500,預設值是最小的 50(手機為主,不預設載入太多)", () => {
    expect(ORDERS_PAGE_SIZE_OPTIONS).toEqual([50, 100, 200, 500]);
    expect(DEFAULT_ORDERS_PAGE_SIZE).toBe(50);
  });

  it("isOrdersPageSize 只認清單裡的數字", () => {
    expect(isOrdersPageSize(50)).toBe(true);
    expect(isOrdersPageSize(500)).toBe(true);
    expect(isOrdersPageSize(75)).toBe(false);
    expect(isOrdersPageSize("50")).toBe(false);
    expect(isOrdersPageSize(null)).toBe(false);
    expect(isOrdersPageSize(undefined)).toBe(false);
  });

  it("沒存過任何值時回傳預設值", () => {
    expect(readStoredOrdersPageSize()).toBe(DEFAULT_ORDERS_PAGE_SIZE);
  });

  it("寫入後讀得回同一個值", () => {
    writeStoredOrdersPageSize(200);
    expect(window.localStorage.getItem(ORDERS_PAGE_SIZE_STORAGE_KEY)).toBe("200");
    expect(readStoredOrdersPageSize()).toBe(200);
  });

  it("存著不合法的值(手動改過、舊版殘留)時退回預設值,不讓畫面壞掉", () => {
    window.localStorage.setItem(ORDERS_PAGE_SIZE_STORAGE_KEY, "9999");
    expect(readStoredOrdersPageSize()).toBe(DEFAULT_ORDERS_PAGE_SIZE);
    window.localStorage.setItem(ORDERS_PAGE_SIZE_STORAGE_KEY, "不是數字");
    expect(readStoredOrdersPageSize()).toBe(DEFAULT_ORDERS_PAGE_SIZE);
  });

  it("localStorage 整個不能用(無痕視窗/瀏覽器封鎖)時不丟錯,讀回預設值、寫入也不炸", () => {
    const getItem = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: localStorage is not available");
    });
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError: localStorage is not available");
    });
    try {
      expect(readStoredOrdersPageSize()).toBe(DEFAULT_ORDERS_PAGE_SIZE);
      expect(() => writeStoredOrdersPageSize(100)).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
