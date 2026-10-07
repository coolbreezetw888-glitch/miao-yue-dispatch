// 第 15 批 #1009:電腦版小卡窗對齊頁面內容欄的純邏輯。
// jsdom 沒有版面引擎,真實寬度 / 位置在 e2e-local/b15-card-dialog-column-align.spec.ts 驗。

import { afterEach, describe, expect, it } from "vitest";

import {
  CARD_COLUMN_MIN_WIDTH,
  columnAlignAttrs,
  computeCardColumnAlign,
  findPageColumnElement,
  measureCardColumnAlign,
  sameColumnAlign,
} from "./cardDialogColumnAlign";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("computeCardColumnAlign", () => {
  it("內容欄在畫面內 ⇒ 原樣回傳中心點與寬度", () => {
    // 1280 寬、max-w-4xl(896)+ px-5 ⇒ 內容欄 212 ~ 1068。
    expect(computeCardColumnAlign({ left: 212, right: 1068 }, 1280)).toEqual({
      center: 640,
      width: 856,
    });
  });

  it("欄位超出畫面 ⇒ 夾進左右各 16px", () => {
    expect(computeCardColumnAlign({ left: 0, right: 1000 }, 1000)).toEqual({
      center: 500,
      width: 968,
    });
  });

  it("太窄(或量到 0)⇒ null,退回原規則", () => {
    expect(
      computeCardColumnAlign({ left: 100, right: 100 + CARD_COLUMN_MIN_WIDTH - 1 }, 1280),
    ).toBe(null);
    expect(computeCardColumnAlign({ left: 0, right: 0 }, 1280)).toBe(null);
    expect(computeCardColumnAlign({ left: Number.NaN, right: 500 }, 1280)).toBe(null);
  });

  it("sameColumnAlign", () => {
    expect(sameColumnAlign(null, null)).toBe(true);
    expect(sameColumnAlign({ center: 1, width: 2 }, null)).toBe(false);
    expect(sameColumnAlign({ center: 1, width: 2 }, { center: 1, width: 2 })).toBe(true);
    expect(sameColumnAlign({ center: 1, width: 2 }, { center: 1, width: 3 })).toBe(false);
  });
});

describe("找不到內容欄 ⇒ null(小卡窗走第 12 批規則)", () => {
  it("頁面沒有 data-app-content-root", () => {
    const card = document.createElement("div");
    document.body.append(card);
    expect(measureCardColumnAlign(card)).toBe(null);
  });

  it("root 底下沒有看得到的子元素(jsdom 寬度都是 0)", () => {
    const root = document.createElement("main");
    root.setAttribute("data-app-content-root", "");
    root.append(document.createElement("div"));
    document.body.append(root);
    expect(findPageColumnElement(root)).toBe(null);
  });
});

describe("columnAlignAttrs(第 16 批 #1010:小卡窗 / 全頁層共用)", () => {
  it("量不到 ⇒ 不掛屬性、style 原樣", () => {
    const style = { color: "red" };
    expect(columnAlignAttrs(null, style)).toEqual({ "data-card-col-align": undefined, style });
  });

  it("量到 ⇒ 掛屬性 + CSS 變數,保留原本 style", () => {
    expect(columnAlignAttrs({ center: 640, width: 728 }, { color: "red" })).toEqual({
      "data-card-col-align": "",
      style: { color: "red", "--card-col-center": "640px", "--card-col-width": "728px" },
    });
  });
});
