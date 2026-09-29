// 抽成制服務人員黃卡守門條件的測試 —— 對應 2026-09-30 QA 抓到的「整份名單永久全黃」。
//
// 這份測試的核心命題只有一句:**沒在用逐項抽成的商家,一張黃卡都不該有。**

import { describe, expect, it } from "vitest";

import {
  merchantUsesPieceRateCommission,
  shouldFlagCommissionAttention,
} from "./commissionAttention";

describe("merchantUsesPieceRateCommission", () => {
  it("一項都沒設定過 → 這家沒在用逐項抽成", () => {
    expect(
      merchantUsesPieceRateCommission([
        { total: 5, configured: 0 },
        { total: 3, configured: 0 },
        { total: 0, configured: 0 },
      ]),
    ).toBe(false);
  });

  it("只要有任何一位設定過任何一項 → 這家有在用", () => {
    expect(
      merchantUsesPieceRateCommission([
        { total: 5, configured: 0 },
        { total: 3, configured: 1 },
      ]),
    ).toBe(true);
  });

  it("名單是空的 → 沒在用", () => {
    expect(merchantUsesPieceRateCommission([])).toBe(false);
  });
});

describe("shouldFlagCommissionAttention:沒在用逐項抽成的商家不標黃", () => {
  it("有項目但一項都沒設 → 不標黃(這是永久狀態,是屬性不是待辦)", () => {
    expect(shouldFlagCommissionAttention({ total: 5, configured: 0 }, false)).toBe(false);
  });

  it("連可接服務都沒設 → 也不標黃", () => {
    expect(shouldFlagCommissionAttention({ total: 0, configured: 0 }, false)).toBe(false);
  });

  it("🔴 整份名單都沒設定時,每一張卡都不黃(不會出現「永久全黃」)", () => {
    const list = [
      { total: 5, configured: 0 },
      { total: 4, configured: 0 },
      { total: 0, configured: 0 },
      { total: 12, configured: 0 },
      { total: 1, configured: 0 },
    ];
    const usesCommission = merchantUsesPieceRateCommission(list);
    expect(usesCommission).toBe(false);
    expect(list.map((c) => shouldFlagCommissionAttention(c, usesCommission))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("shouldFlagCommissionAttention:有在用逐項抽成的商家照舊標黃", () => {
  it("還有項目沒設抽成 → 標黃", () => {
    expect(shouldFlagCommissionAttention({ total: 5, configured: 2 }, true)).toBe(true);
  });

  it("全部項目都設好了 → 不標黃", () => {
    expect(shouldFlagCommissionAttention({ total: 5, configured: 5 }, true)).toBe(false);
  });

  it("沒有任何可接服務 → 標黃(這家在用抽成,這個人卻接不到任何服務,抽成一定是 0)", () => {
    expect(shouldFlagCommissionAttention({ total: 0, configured: 0 }, true)).toBe(true);
  });

  it("🔴 有人設好、有人沒設時,黃色才真的指出「哪張要處理」", () => {
    const list = [
      { total: 3, configured: 3 },
      { total: 3, configured: 1 },
      { total: 4, configured: 0 },
    ];
    const usesCommission = merchantUsesPieceRateCommission(list);
    expect(usesCommission).toBe(true);
    expect(list.map((c) => shouldFlagCommissionAttention(c, usesCommission))).toEqual([
      false,
      true,
      true,
    ]);
  });
});
