// parseAmountInput 的守門測試 —— 對應 2026-09-30 QA 抓到的「金額欄位從 type=number 換成
// type=text 之後,原生 min / step 約束消失」那個回歸。
//
// 🔴 這份測試的重點不是「數字算得對不對」,而是「`Number()` 吃得下、原生 number 欄位會擋掉的那些
// 字串,有沒有被擋下來」。下面每一條被拒絕的輸入都對應一種真的會被 `Number()` 放行的寫法。

import { describe, expect, it } from "vitest";

import { parseAmountInput } from "./parseAmountInput";

describe("parseAmountInput 接受的寫法", () => {
  it("接受整數", () => {
    expect(parseAmountInput("1200")).toEqual({ ok: true, value: 1200 });
  });

  it("接受小數(預設模式)", () => {
    expect(parseAmountInput("0.01")).toEqual({ ok: true, value: 0.01 });
  });

  it("接受 0", () => {
    expect(parseAmountInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("接受前後空白", () => {
    expect(parseAmountInput("  350  ")).toEqual({ ok: true, value: 350 });
  });

  it("接受明確的正號", () => {
    expect(parseAmountInput("+350")).toEqual({ ok: true, value: 350 });
  });
});

describe("parseAmountInput 拒絕的寫法(Number() 會放行、原生 number 欄位會擋)", () => {
  // 每一條都先驗證「Number() 確實吃得下」,證明這個測試擋的是真的存在的漏洞,不是假想敵。
  it.each([
    ["科學記號 1e3", "1e3", 1000],
    ["科學記號 1E3", "1E3", 1000],
    ["十六進位 0x10", "0x10", 16],
    ["二進位 0b11", "0b11", 3],
    ["八進位 0o17", "0o17", 15],
    ["Infinity", "Infinity", Number.POSITIVE_INFINITY],
    ["只有空白", "   ", 0],
  ])("%s 會被擋下來", (_label, raw, numberResult) => {
    expect(Number(raw)).toBe(numberResult);
    const result = parseAmountInput(raw);
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(typeof (result as { error: string }).error).toBe("string");
  });

  it.each([
    ["空字串", ""],
    ["千分位逗號", "1,000"],
    ["全形數字", "１２３"],
    ["小數點結尾 12.", "12."],
    ["小數點開頭 .5", ".5"],
    ["兩個小數點", "1.2.3"],
    ["中文", "一千"],
    ["帶單位", "1200元"],
    ["帶錢字號", "$1200"],
    ["NaN 字面字串", "NaN"],
  ])("%s 會被擋下來", (_label, raw) => {
    const result = parseAmountInput(raw);
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
  });

  it("負數會被擋下來,訊息是白話的", () => {
    const result = parseAmountInput("-1");
    expect(result).toEqual({ ok: false, value: null, error: "金額不能是負數" });
  });

  it("空字串的訊息是白話的", () => {
    expect(parseAmountInput("")).toEqual({ ok: false, value: null, error: "請輸入金額" });
  });

  it("不是數字的訊息是白話的,不含技術名詞", () => {
    const result = parseAmountInput("1e3");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe("請輸入數字金額,只能填數字和小數點");
  });
});

describe('integerOnly(原本 step="1" 的欄位:每天扣固定金額、月薪)', () => {
  it("整數照過", () => {
    expect(parseAmountInput("30000", { integerOnly: true })).toEqual({ ok: true, value: 30000 });
  });

  it("小數會被擋下來,訊息講清楚只能填整數", () => {
    expect(parseAmountInput("30000.5", { integerOnly: true })).toEqual({
      ok: false,
      value: null,
      error: "這個欄位只能填整數,不能有小數點",
    });
  });

  it("連 .0 結尾也擋(使用者看到的是小數點,規則要一致好解釋)", () => {
    expect(parseAmountInput("100.0", { integerOnly: true }).ok).toBe(false);
  });

  it("integerOnly 之外的規則照樣生效", () => {
    expect(parseAmountInput("1e3", { integerOnly: true }).ok).toBe(false);
    expect(parseAmountInput("-5", { integerOnly: true }).ok).toBe(false);
  });
});

describe("min / max", () => {
  it("預設 min 是 0", () => {
    expect(parseAmountInput("-0.01").ok).toBe(false);
  });

  it("可以指定 max", () => {
    expect(parseAmountInput("101", { max: 100 })).toEqual({
      ok: false,
      value: null,
      error: "不能大於 100",
    });
    expect(parseAmountInput("100", { max: 100 })).toEqual({ ok: true, value: 100 });
  });

  it("可以指定非 0 的 min", () => {
    expect(parseAmountInput("5", { min: 10 })).toEqual({
      ok: false,
      value: null,
      error: "不能小於 10",
    });
  });
});
