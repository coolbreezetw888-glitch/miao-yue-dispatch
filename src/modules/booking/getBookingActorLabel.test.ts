// 客戶端第 4 批(主腦 2026-10-09 裁決):後台訂單詳細「最後修改」遇到客人帳號 ⇒「客人」,
// 真的被移除的人員仍是「(已移除的人員)」。判斷依據 = 這張單的操作紀錄有同一個帳號的 actor_role_snapshot='customer'。

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bookingActorLabel,
  CUSTOMER_ACTOR_LABEL,
  REMOVED_ACTOR_LABEL,
} from "./customerBookingSource";

describe("bookingActorLabel(純函式)", () => {
  const names = new Map([["staff-user", "客服甲"]]);
  it("查得到員工名字 ⇒ 名字(就算也在客人清單裡)", () => {
    expect(bookingActorLabel("staff-user", names, new Set(["staff-user"]))).toBe("客服甲");
  });
  it("操作紀錄證明是客人 ⇒「客人」", () => {
    expect(bookingActorLabel("cust-user", names, new Set(["cust-user"]))).toBe(
      CUSTOMER_ACTOR_LABEL,
    );
    expect(CUSTOMER_ACTOR_LABEL).toBe("客人");
  });
  it("名單找不到、也不是客人 ⇒「(已移除的人員)」(不能只靠找不到就判成客人)", () => {
    expect(bookingActorLabel("gone-user", names, new Set())).toBe(REMOVED_ACTOR_LABEL);
    // 資料庫函式查不到時回的就是「(已移除的人員)」字樣 ⇒ 一樣當查不到,客人紀錄優先
    const withPlaceholder = new Map([["cust-user", REMOVED_ACTOR_LABEL]]);
    expect(bookingActorLabel("cust-user", withPlaceholder, new Set(["cust-user"]))).toBe("客人");
    expect(bookingActorLabel("cust-user", withPlaceholder, new Set())).toBe(REMOVED_ACTOR_LABEL);
    expect(REMOVED_ACTOR_LABEL).toBe("(已移除的人員)");
  });
});

// ─── getBooking 整合:用假的 supabase client ───

const db = vi.hoisted(() => ({
  booking: null as Record<string, unknown> | null,
  actorNames: [] as { user_id: string; display_name: string }[],
  customerLogs: [] as { actor_user_id: string }[],
  logQueries: [] as { filters: [string, unknown][] }[],
}));

vi.mock("@/integrations/supabase/client", () => {
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const result = () => {
      if (table === "booking_status_change_logs") {
        db.logQueries.push({ filters });
        return { data: db.customerLogs, error: null };
      }
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      in: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: db.booking, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve(result()),
    };
    return b;
  }
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: vi.fn(async () => ({ data: db.actorNames, error: null })),
      functions: { invoke: vi.fn() },
    },
  };
});

const { getBooking } = await import("./api");

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    merchant_id: "m1",
    status: "cancelled",
    source: "manual",
    is_guest_booking: false,
    created_by_user_id: "staff-user",
    last_modified_by_user_id: "cust-user",
    ...overrides,
  };
}

beforeEach(() => {
  db.booking = bookingRow();
  // 照實際 get_booking_actor_names:查不到的帳號也會回一列「(已移除的人員)」
  db.actorNames = [
    { user_id: "staff-user", display_name: "客服甲" },
    { user_id: "cust-user", display_name: "(已移除的人員)" },
    { user_id: "gone-user", display_name: "(已移除的人員)" },
  ];
  db.customerLogs = [];
  db.logQueries = [];
});

describe("getBooking 的「最後修改」", () => {
  it("店家建的單、客人在會員中心取消 ⇒ 最後修改「客人」;建單人照舊是客服名字", async () => {
    db.customerLogs = [{ actor_user_id: "cust-user" }];
    const b = await getBooking("b1");
    expect(b?.lastModifiedByName).toBe("客人");
    expect(b?.createdByName).toBe("客服甲");
    // 只查這張單、只查 customer 紀錄、只查名字找不到的帳號
    expect(db.logQueries[0]?.filters).toEqual([
      ["booking_id", "b1"],
      ["actor_role_snapshot", "customer"],
      ["actor_user_id", ["cust-user"]],
    ]);
  });

  it("最後修改的人被移除了(操作紀錄裡沒有客人紀錄)⇒ 仍是「(已移除的人員)」", async () => {
    db.booking = bookingRow({ last_modified_by_user_id: "gone-user" });
    const b = await getBooking("b1");
    expect(b?.lastModifiedByName).toBe("(已移除的人員)");
  });

  it("名字都查得到 ⇒ 不多查操作紀錄", async () => {
    db.booking = bookingRow({ last_modified_by_user_id: "staff-user" });
    const b = await getBooking("b1");
    expect(b?.lastModifiedByName).toBe("客服甲");
    expect(db.logQueries).toHaveLength(0);
  });

  it("第 3 批客人自己送出的單:建單人「客人（線上預約）」、最後修改「客人」", async () => {
    db.booking = bookingRow({
      source: "customer",
      created_by_user_id: "cust-user",
      last_modified_by_user_id: "cust-user",
    });
    db.actorNames = [{ user_id: "cust-user", display_name: "(已移除的人員)" }];
    db.customerLogs = [{ actor_user_id: "cust-user" }];
    const b = await getBooking("b1");
    expect(b?.createdByName).toBe("客人（線上預約）");
    expect(b?.lastModifiedByName).toBe("客人");
  });
});
