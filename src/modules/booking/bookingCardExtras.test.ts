// 2026-09-24 深夜巡檢問題 2:fetchBookingCardExtras 裡查 booking_service_items 的那支查詢原本是
// 「整批 booking id 一次 .in() 查完」的單次查詢,沒有分頁。PostgREST 有 db.max_rows 上限(這個
// 專案設定 1000,見 supabase/config.toml),訂單管理頁一次載入約 400 筆以上訂單、平均每筆 3 個
// 服務項目(400×3 = 1200 > 1000)時,結果會被靜靜截斷在 1000 列,後面那些訂單的卡片第一行就變成
// 「(無服務項目資料)」——但它們其實是有服務項目的。
//
// 這裡用假的 supabase client 重現「單次查詢最多只回 1000 列」這個限制,驗證修正後的分批 + 分頁
// 迴圈真的把每一筆訂單的服務項目名稱都拿回來了。刻意測這一層(而不是只測純函式),因為這個 bug
// 的成因就在「怎麼呼叫 supabase」本身,不在資料轉換邏輯。

import { beforeEach, describe, expect, it, vi } from "vitest";

/** PostgREST 單次查詢的回傳上限(supabase/config.toml 的 db.max_rows)。 */
const MAX_ROWS = 1000;

interface ServiceItemRow {
  booking_id: string;
  id: string;
  service_items: { name: string } | null;
}

/** 這次測試情境裡「資料庫實際擁有」的 booking_service_items 資料。 */
let tableRows: ServiceItemRow[] = [];
/** 每一次 .range() 查詢實際被要求的 booking id 數量與範圍,用來驗證分批/分頁真的有發生。 */
let rangeCalls: { idCount: number; from: number; to: number }[] = [];

const rpcMock = vi.fn();

function makeQueryBuilder() {
  let requestedIds: string[] = [];
  const builder = {
    select: () => builder,
    in: (_column: string, ids: string[]) => {
      requestedIds = ids;
      return builder;
    },
    order: () => builder,
    range: (from: number, to: number) => {
      rangeCalls.push({ idCount: requestedIds.length, from, to });
      const idSet = new Set(requestedIds);
      const matched = tableRows
        .filter((row) => idSet.has(row.booking_id))
        .sort((a, b) =>
          a.booking_id === b.booking_id
            ? a.id.localeCompare(b.id)
            : a.booking_id.localeCompare(b.booking_id),
        );
      // 關鍵:模擬 PostgREST 的 db.max_rows——即使要求的範圍更大,單次也最多只回 1000 列。
      const size = Math.min(to - from + 1, MAX_ROWS);
      return Promise.resolve({ data: matched.slice(from, from + size), error: null });
    },
  };
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => makeQueryBuilder(),
    rpc: (...args: unknown[]) => rpcMock(...args),
    functions: { invoke: vi.fn() },
  },
}));

async function importFetchBookingCardExtras() {
  const mod = await import("./api");
  return mod.fetchBookingCardExtras;
}

function buildFixture(bookingCount: number, itemsPerBooking: number) {
  const bookings = Array.from({ length: bookingCount }, (_, i) => ({
    id: `booking-${String(i).padStart(4, "0")}`,
    created_by_user_id: null as string | null,
  }));
  const rows: ServiceItemRow[] = [];
  for (const b of bookings) {
    for (let n = 0; n < itemsPerBooking; n += 1) {
      rows.push({
        booking_id: b.id,
        id: `${b.id}-item-${n}`,
        service_items: { name: `服務${n}` },
      });
    }
  }
  return { bookings, rows };
}

describe("fetchBookingCardExtras(問題 2:服務項目名稱在訂單量大時被截斷)", () => {
  beforeEach(() => {
    tableRows = [];
    rangeCalls = [];
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: [], error: null });
  });

  it("400 筆訂單 × 每筆 3 個服務項目(1200 列 > 1000)時,每一筆訂單都還是拿得到服務項目名稱", async () => {
    const fetchBookingCardExtras = await importFetchBookingCardExtras();
    const { bookings, rows } = buildFixture(400, 3);
    tableRows = rows;

    const result = await fetchBookingCardExtras("merchant-1", bookings);

    expect(result.size).toBe(400);
    const missing = bookings.filter((b) => (result.get(b.id)?.serviceItemNames.length ?? 0) === 0);
    // 修正前這裡會有大約 66 筆訂單掉進「(無服務項目資料)」。
    expect(missing).toHaveLength(0);
    expect(result.get("booking-0399")?.serviceItemNames).toEqual(["服務0", "服務1", "服務2"]);
  });

  it("每批最多 200 個 booking id,400 筆訂單會分成 2 批查", async () => {
    const fetchBookingCardExtras = await importFetchBookingCardExtras();
    const { bookings, rows } = buildFixture(400, 3);
    tableRows = rows;

    await fetchBookingCardExtras("merchant-1", bookings);

    expect(rangeCalls).toHaveLength(2);
    expect(rangeCalls.every((call) => call.idCount <= 200)).toBe(true);
  });

  it("單一批次本身就超過 1000 列時(每筆訂單服務項目特別多),批次內會繼續往下翻頁,不漏資料", async () => {
    const fetchBookingCardExtras = await importFetchBookingCardExtras();
    // 200 筆訂單 × 6 個服務項目 = 1200 列,剛好落在同一批裡面、又超過單次查詢上限。
    const { bookings, rows } = buildFixture(200, 6);
    tableRows = rows;

    const result = await fetchBookingCardExtras("merchant-1", bookings);

    // 同一批查了兩次(第一次滿 1000 列 → 繼續翻下一頁)。
    expect(rangeCalls).toHaveLength(2);
    expect(rangeCalls[0]!.from).toBe(0);
    expect(rangeCalls[1]!.from).toBe(MAX_ROWS);
    expect(result.get("booking-0199")?.serviceItemNames).toHaveLength(6);
  });

  it("沒有訂單時不查資料庫,直接回傳空 Map", async () => {
    const fetchBookingCardExtras = await importFetchBookingCardExtras();
    const result = await fetchBookingCardExtras("merchant-1", []);
    expect(result.size).toBe(0);
    expect(rangeCalls).toHaveLength(0);
  });

  it("建單客服姓名仍然照既有邏輯一次查完(去重後只呼叫一次 RPC)", async () => {
    const fetchBookingCardExtras = await importFetchBookingCardExtras();
    tableRows = [];
    rpcMock.mockResolvedValue({
      data: [{ user_id: "user-1", display_name: "小美" }],
      error: null,
    });

    const result = await fetchBookingCardExtras("merchant-1", [
      { id: "booking-a", created_by_user_id: "user-1" },
      { id: "booking-b", created_by_user_id: "user-1" },
      { id: "booking-c", created_by_user_id: null },
    ]);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("get_booking_actor_names", {
      p_merchant_id: "merchant-1",
      p_user_ids: ["user-1"],
    });
    expect(result.get("booking-a")?.createdByName).toBe("小美");
    expect(result.get("booking-c")?.createdByName).toBe("(已移除的人員)");
    // 查無服務項目時維持既有行為(空陣列,畫面顯示「(無服務項目資料)」)。
    expect(result.get("booking-a")?.serviceItemNames).toEqual([]);
  });
});
