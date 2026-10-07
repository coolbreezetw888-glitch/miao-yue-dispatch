// 第 11 批 J(#995 J-13):「填過資料」判斷的純函式與 hook。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isFormDirty, useFormDirty } from "./formDirty";

describe("isFormDirty", () => {
  it("字串先去頭尾空白", () => {
    expect(isFormDirty({ name: " 王小明 " }, { name: "王小明" })).toBe(false);
    expect(isFormDirty({ name: "王小明a" }, { name: "王小明" })).toBe(true);
  });

  it('"" / null / undefined 視為相同(物件少一個 key = undefined)', () => {
    expect(isFormDirty({ a: "" }, { a: null })).toBe(false);
    expect(isFormDirty({ a: undefined }, { a: "" })).toBe(false);
    expect(isFormDirty({ a: "   " }, {})).toBe(false);
    expect(isFormDirty({ a: "x" }, {})).toBe(true);
  });

  it("巢狀物件深比較", () => {
    const base = { prices: { s1: "100", s2: "200" }, flags: { on: false } };
    expect(isFormDirty({ prices: { s1: "100", s2: "200" }, flags: { on: false } }, base)).toBe(
      false,
    );
    expect(isFormDirty({ prices: { s1: "100", s2: "201" }, flags: { on: false } }, base)).toBe(
      true,
    );
    expect(isFormDirty({ prices: { s1: "100", s2: "200" }, flags: { on: true } }, base)).toBe(true);
  });

  it("陣列照順序比", () => {
    expect(isFormDirty(["a", "b"], ["a", "b"])).toBe(false);
    expect(isFormDirty(["b", "a"], ["a", "b"])).toBe(true);
    expect(isFormDirty(["a"], ["a", "b"])).toBe(true);
  });

  it("數字 / 布林照值比", () => {
    expect(isFormDirty({ n: 1, b: false }, { n: 1, b: false })).toBe(false);
    expect(isFormDirty({ n: 2 }, { n: 1 })).toBe(true);
    expect(isFormDirty({ b: true }, { b: false })).toBe(true);
  });
});

describe("useFormDirty", () => {
  it("markClean 前一律 false;markClean 後改值 true;改回原值 false", () => {
    const { result, rerender } = renderHook(({ value }) => useFormDirty(value), {
      initialProps: { value: { name: "" } },
    });
    expect(result.current.dirty).toBe(false);
    rerender({ value: { name: "亂打的" } });
    // 還沒 markClean(例如編輯表單資料還沒載入)⇒ 不算填過。
    expect(result.current.dirty).toBe(false);

    act(() => result.current.markClean({ name: "王小明" }));
    rerender({ value: { name: "王小明" } });
    expect(result.current.dirty).toBe(false);
    rerender({ value: { name: "王小明2" } });
    expect(result.current.dirty).toBe(true);
    rerender({ value: { name: "王小明" } });
    expect(result.current.dirty).toBe(false);
  });

  it("markClean 是穩定的函式(可以放進 useEffect 依賴)", () => {
    const { result, rerender } = renderHook(({ value }) => useFormDirty(value), {
      initialProps: { value: "a" },
    });
    const first = result.current.markClean;
    rerender({ value: "b" });
    expect(result.current.markClean).toBe(first);
  });
});
