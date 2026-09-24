import { describe, expect, it, vi } from "vitest";

import { guardPhantomEmptyChange } from "./radixSelectGuard";

describe("guardPhantomEmptyChange", () => {
  describe("不傳 isValid(動態清單:服務人員 id / 付款方式 id / 分類 id)", () => {
    it("傳入空字串時不呼叫底層 setter(擋掉 Radix 的幽靈空值事件)", () => {
      const setter = vi.fn();
      guardPhantomEmptyChange(setter)("");
      expect(setter).not.toHaveBeenCalled();
    });

    it("傳入合法值時會呼叫底層 setter,而且原封不動把值傳進去", () => {
      const setter = vi.fn();
      guardPhantomEmptyChange(setter)("11111111-2222-3333-4444-555555555555");
      expect(setter).toHaveBeenCalledTimes(1);
      expect(setter).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
    });

    it("sentinel 值(例如 __unset__ / __uncategorized__)不是空字串,一樣放行", () => {
      const setter = vi.fn();
      guardPhantomEmptyChange(setter)("__unset__");
      expect(setter).toHaveBeenCalledWith("__unset__");
    });
  });

  describe("傳入 isValid(固定常數白名單:折扣模式 / 稅金模式 / 抽成模式)", () => {
    const isValid = (v: string) => ["fixed", "percentage"].includes(v);

    it("空字串一律先被擋下,不會進到 isValid", () => {
      const setter = vi.fn();
      const isValidSpy = vi.fn(isValid);
      guardPhantomEmptyChange(setter, isValidSpy)("");
      expect(setter).not.toHaveBeenCalled();
      expect(isValidSpy).not.toHaveBeenCalled();
    });

    it("不在白名單內的值不呼叫底層 setter", () => {
      const setter = vi.fn();
      guardPhantomEmptyChange(setter, isValid)("something-else");
      expect(setter).not.toHaveBeenCalled();
    });

    it("在白名單內的值會呼叫底層 setter", () => {
      const setter = vi.fn();
      guardPhantomEmptyChange(setter, isValid)("percentage");
      expect(setter).toHaveBeenCalledTimes(1);
      expect(setter).toHaveBeenCalledWith("percentage");
    });
  });

  it("每次呼叫都回傳一個可重複使用的函式,不會因為呼叫過一次就失效", () => {
    const setter = vi.fn();
    const handler = guardPhantomEmptyChange(setter);
    handler("a");
    handler("");
    handler("b");
    expect(setter.mock.calls).toEqual([["a"], ["b"]]);
  });
});
