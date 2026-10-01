// SPECS-INDEX #946:點數異動紀錄同一時間寫入的多筆,先後順序要固定、而且要是真實寫入順序。
// 情境就是 QA 觀察到的那個:取消已完成訂單,同一個交易裡先寫「退回折抵」、再寫「收回入帳」,
// 兩筆 created_at 一模一樣。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { fetchMemberPointHistory } from "./api";
import { stabilizePointHistoryOrder, type PointHistoryOrderable } from "./memberPointHistoryOrder";

const T_OLD = "2026-10-01T02:00:00.123456+00:00";
const T_SAME = "2026-10-01T03:00:00.654321+00:00";
const T_NEW = "2026-10-01T04:00:00+00:00";

function row(id: string, pointsDelta: number, balanceAfter: number, createdAt: string) {
  return { id, pointsDelta, balanceAfter, createdAt };
}

// 會員原本 100 點(earn),同一交易:退回折抵 +20 → 120,再收回入帳 −50 → 70。
// id 刻意取成「依 id 排會排反」:收回入帳那筆 id 比較小。
const earn = row("ffff-earn", 100, 100, T_OLD);
const refund = row("bbbb-refund", 20, 120, T_SAME);
const reversal = row("aaaa-reversal", -50, 70, T_SAME);
const later = row("cccc-later", 5, 75, T_NEW);

function ids(rows: PointHistoryOrderable[]) {
  return rows.map((r) => r.id);
}

describe("stabilizePointHistoryOrder(#946)", () => {
  it("同一時間的兩筆:不論資料庫回傳先後,都排成「後寫入的在上面」", () => {
    const expected = ["cccc-later", "aaaa-reversal", "bbbb-refund", "ffff-earn"];
    expect(ids(stabilizePointHistoryOrder([later, refund, reversal, earn]))).toEqual(expected);
    expect(ids(stabilizePointHistoryOrder([later, reversal, refund, earn]))).toEqual(expected);
  });

  it("排好之後,每一筆「做之前的餘額」都等於下一筆(較舊)的 balance_after(餘額欄不會倒著跳)", () => {
    const out = stabilizePointHistoryOrder([later, refund, reversal, earn]);
    for (let i = 0; i < out.length - 1; i += 1) {
      expect(out[i]!.balanceAfter - out[i]!.pointsDelta).toBe(out[i + 1]!.balanceAfter);
    }
  });

  it("同一時間的那一撮是最舊的(下面沒有更舊的紀錄):一樣靠接龍排出真實順序", () => {
    expect(ids(stabilizePointHistoryOrder([refund, reversal]))).toEqual([
      "aaaa-reversal",
      "bbbb-refund",
    ]);
    expect(ids(stabilizePointHistoryOrder([reversal, refund]))).toEqual([
      "aaaa-reversal",
      "bbbb-refund",
    ]);
  });

  it("三筆同一時間也能接起來", () => {
    const a = row("3", 10, 110, T_SAME); // 100 → 110
    const b = row("1", -30, 80, T_SAME); // 110 → 80
    const c = row("2", 5, 85, T_SAME); // 80 → 85
    const base = row("0", 100, 100, T_OLD);
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      expect(ids(stabilizePointHistoryOrder([...order, base]))).toEqual(["2", "1", "3", "0"]);
    }
  });

  it("接不起來(理論上不會發生)⇒ 退回依 id 排,結果仍然固定", () => {
    const x = row("b", 10, 999, T_SAME);
    const y = row("a", 10, 555, T_SAME);
    const base = row("0", 100, 100, T_OLD);
    expect(ids(stabilizePointHistoryOrder([x, y, base]))).toEqual(["b", "a", "0"]);
    expect(ids(stabilizePointHistoryOrder([y, x, base]))).toEqual(["b", "a", "0"]);
  });

  it("不同時間的紀錄完全照原本順序,不重排;也不改動傳入的陣列", () => {
    const input = [later, refund, reversal, earn];
    const snapshot = [...input];
    stabilizePointHistoryOrder(input);
    expect(input).toEqual(snapshot);
    const distinct = [row("z", 1, 3, T_NEW), row("a", 1, 2, T_SAME), row("m", 2, 1, T_OLD)];
    expect(ids(stabilizePointHistoryOrder(distinct))).toEqual(["z", "a", "m"]);
  });
});

// ---------------------------------------------------------------------------------------------
// QA 打回(#946 第 2 輪):相鄰的「同一時間多筆」撮,錨點要用「已排好的較舊那撮」的最新一筆。
// ---------------------------------------------------------------------------------------------

/** 全排列(撮內最多 8 筆以內才用,這裡只用在 2~3 筆)。 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, idx) => {
    const rest = [...items.slice(0, idx), ...items.slice(idx + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

/** 把「新 → 舊」的撮(每撮是真實寫入的新 → 舊)攤平成所有可能的資料庫回傳順序(撮內任意排列)。 */
function allDbOrders<T>(groupsNewestFirst: readonly (readonly T[])[]): T[][] {
  let acc: T[][] = [[]];
  for (const g of groupsNewestFirst) {
    const next: T[][] = [];
    for (const prefix of acc) for (const p of permutations(g)) next.push([...prefix, ...p]);
    acc = next;
  }
  return acc;
}

const T1 = "2026-10-01T01:00:00+00:00";
const T2 = "2026-10-01T02:00:00.5+00:00";
const T3 = "2026-10-01T03:00:00.25+00:00";
const T4 = "2026-10-01T04:00:00+00:00";
const T5 = "2026-10-01T05:00:00+00:00";

describe("相鄰的同一時間撮(#946 QA 打回)", () => {
  // QA 的重現例子:earn +100 → 100;T2 撮 +20 → 120、−30 → 90;T3 撮 +30 → 120、−100 → 20。
  // id 刻意取成「依 id 排會排錯」。
  const base = row("z-earn", 100, 100, T1);
  const t2a = row("y-t2-plus20", 20, 120, T2);
  const t2b = row("a-t2-minus30", -30, 90, T2);
  const t3a = row("x-t3-plus30", 30, 120, T3);
  const t3b = row("b-t3-minus100", -100, 20, T3);
  const truthNewestFirst = [t3b, t3a, t2b, t2a, base];

  it("兩撮相鄰 × 各撮內部所有回傳順序:輸出完全相同,而且是真實寫入順序", () => {
    const orders = allDbOrders([[t3b, t3a], [t2b, t2a], [base]]);
    expect(orders).toHaveLength(4);
    for (const order of orders) {
      expect(ids(stabilizePointHistoryOrder(order))).toEqual(ids(truthNewestFirst));
    }
  });

  it("三撮相鄰(其中一撮 3 筆)× 所有回傳順序", () => {
    // 100 → T2:+20=120、−30=90 → T3:+30=120、−100=20 → T4:+7=27、+40=67、−60=7
    const t4a = row("q-t4-plus7", 7, 27, T4);
    const t4b = row("c-t4-plus40", 40, 67, T4);
    const t4c = row("m-t4-minus60", -60, 7, T4);
    const truth = [t4c, t4b, t4a, t3b, t3a, t2b, t2a, base];
    const orders = allDbOrders([[t4c, t4b, t4a], [t3b, t3a], [t2b, t2a], [base]]);
    expect(orders).toHaveLength(6 * 2 * 2);
    for (const order of orders) {
      expect(ids(stabilizePointHistoryOrder(order))).toEqual(ids(truth));
    }
  });

  it("同一時間撮夾在不同時間的單筆紀錄之間", () => {
    // 100 → T2 撮(+20=120、−30=90)→ T3 單筆 +10=100 → T4 撮(+30=130、−100=30)→ T5 單筆 +1=31
    const mid = row("k-t3-single", 10, 100, T3);
    const t4a = row("w-t4-plus30", 30, 130, T4);
    const t4b = row("d-t4-minus100", -100, 30, T4);
    const top = row("n-t5-single", 1, 31, T5);
    const truth = [top, t4b, t4a, mid, t2b, t2a, base];
    for (const order of allDbOrders([[top], [t4b, t4a], [mid], [t2b, t2a], [base]])) {
      expect(ids(stabilizePointHistoryOrder(order))).toEqual(ids(truth));
    }
  });

  it("最舊那撮就是同一時間多筆(沒有錨點)、上面再接一撮:所有回傳順序結果都一樣", () => {
    const outs = new Set(
      allDbOrders([
        [t3b, t3a],
        [t2b, t2a],
      ]).map((o) => ids(stabilizePointHistoryOrder(o)).join(",")),
    );
    expect([...outs]).toEqual([ids([t3b, t3a, t2b, t2a]).join(",")]);
  });
});

// ---------------------------------------------------------------------------------------------
// 隨機壓力測試(固定亂數種子,每次跑結果一樣、失敗可重現)
// ---------------------------------------------------------------------------------------------

/** mulberry32:簡單、可重現的亂數。 */
function makeRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 產生「真實寫入順序」(新 → 舊)的資料,約 total 筆,每撮 1~8 筆,最舊一筆是單獨時間的起始入帳。
 * uniqueDeltas = true:同一撮內的點數是 ±2^k 且 k 互不相同 ⇒ 任兩個不同子集合的總和必不相同,
 *   接龍只有唯一解,所以「必須還原成真實順序」是可以要求的。
 * uniqueDeltas = false:點數完全隨機(可能有多種合法接法),只能要求「結果固定 + 是合法接龍」。
 */
function generateHistory(seed: number, total: number, uniqueDeltas: boolean) {
  const rand = makeRandom(seed);
  let balance = 5_000_000;
  let idSeq = 0;
  const randomId = () => `${Math.floor(rand() * 1e9).toString(36)}-${(idSeq += 1)}`;
  const groupsOldestFirst: PointHistoryOrderable[][] = [
    [row(randomId(), balance, balance, "2026-01-01T00:00:00+00:00")],
  ];
  let count = 1;
  let second = 0;
  while (count < total) {
    second += 1;
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const size = Math.min(1 + Math.floor(rand() * 8), total - count);
    const ks = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rand);
    const group: PointHistoryOrderable[] = [];
    for (let n = 0; n < size; n += 1) {
      const sign = rand() < 0.5 ? -1 : 1;
      const magnitude = uniqueDeltas ? 2 ** ks[n]! : 1 + Math.floor(rand() * 5);
      balance += sign * magnitude;
      group.push(row(randomId(), sign * magnitude, balance, createdAt));
    }
    groupsOldestFirst.push(group);
    count += size;
  }
  const truthNewestFirst = groupsOldestFirst
    .slice()
    .reverse()
    .flatMap((g) => g.slice().reverse());
  const shuffledDb = (r: () => number) =>
    groupsOldestFirst
      .slice()
      .reverse()
      .flatMap((g) => shuffle(g, r));
  return { truthNewestFirst, shuffledDb, groupCount: groupsOldestFirst.length };
}

describe("隨機壓力測試(#946 QA 打回)", () => {
  it("1000 筆、每撮 1~8 筆、點數不會有多種接法:撮內打亂 20 次,每次都還原成真實順序", () => {
    const { truthNewestFirst, shuffledDb, groupCount } = generateHistory(946, 1000, true);
    expect(truthNewestFirst).toHaveLength(1000);
    expect(groupCount).toBeGreaterThan(100);
    const rand = makeRandom(20261001);
    const expected = ids(truthNewestFirst);
    for (let round = 0; round < 20; round += 1) {
      expect(ids(stabilizePointHistoryOrder(shuffledDb(rand)))).toEqual(expected);
    }
  });

  it("1000 筆、點數完全隨機(可能有多種接法):撮內打亂 20 次結果完全相同,而且每一筆都接得上", () => {
    const { shuffledDb } = generateHistory(844, 1000, false);
    const rand = makeRandom(7);
    const first = stabilizePointHistoryOrder(shuffledDb(rand));
    for (let i = 0; i < first.length - 1; i += 1) {
      expect(first[i]!.balanceAfter - first[i]!.pointsDelta).toBe(first[i + 1]!.balanceAfter);
    }
    for (let round = 0; round < 20; round += 1) {
      expect(ids(stabilizePointHistoryOrder(shuffledDb(rand)))).toEqual(ids(first));
    }
  });
});

describe("fetchMemberPointHistory 有套用固定排序(#946 接線)", () => {
  beforeEach(() => rpcMock.mockReset());

  it("RPC 把同一時間的兩筆順序回反了,畫面拿到的仍是真實寫入順序", async () => {
    const raw = (id: string, delta: number, after: number, at: string, type: string) => ({
      id,
      transaction_type: type,
      points_delta: delta,
      balance_after: after,
      note: null,
      booking_id: null,
      booking_start_at: null,
      related_member_id: null,
      related_member_name: null,
      created_by_user_id: null,
      created_at: at,
    });
    rpcMock.mockResolvedValue({
      data: [
        raw("bbbb-refund", 20, 120, T_SAME, "redeem_booking_refund"),
        raw("aaaa-reversal", -50, 70, T_SAME, "earn_booking_reversal"),
        raw("ffff-earn", 100, 100, T_OLD, "earn_booking"),
      ],
      error: null,
    });
    const out = await fetchMemberPointHistory("member-1");
    expect(rpcMock).toHaveBeenCalledWith("get_member_point_history", { p_member_id: "member-1" });
    expect(out.map((e) => e.transactionType)).toEqual([
      "earn_booking_reversal",
      "redeem_booking_refund",
      "earn_booking",
    ]);
  });
});
