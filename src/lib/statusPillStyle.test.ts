// statusPillStyle.ts 的單元測試(2026-09-30 使用者裁決,SPECS-INDEX #832 實機巡檢批)。
//
// 這支測試要釘住的是「使用者裁決」本身,不是可讀性:
//   ① **一律白字**,不管底色多淺多深都一樣 —— 掃一整片色域驗證,不是只挑幾個顏色。
//   ② 底色**原樣輸出**,不做任何加深/調整(使用者原話「顏色完全不動」)。
//   ③ 描邊固定是深色半透明 —— 這條是「白底卡片 + 白邊 + 白字整顆消失」的保命線,
//      **不可以**跟著文字色走。
//
// 🔴 這裡的斷言如果哪天開始失敗,先確認是不是有人把「依底色亮度自動挑黑白」加回來了。
//    那個做法 2026-09-30 已經被使用者當面推翻(代價已明確告知),要改回去必須是使用者
//    自己再裁決一次,不是因為對比度數字不好看就動手。詳見 statusPillStyle.ts 檔頭。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOOKING_STATUS_COLORS,
  DEFAULT_CALENDAR_STATE_STYLES,
} from "@/modules/booking/types";

import { solidFillStyle, STATUS_PILL_BORDER, STATUS_PILL_INK } from "./statusPillStyle";

describe("solidFillStyle", () => {
  it("底色原樣、文字白色、描邊深色半透明", () => {
    expect(solidFillStyle("#1c6fd2")).toEqual({
      backgroundColor: "#1c6fd2",
      color: "#ffffff",
      borderColor: "rgba(17, 24, 39, 0.25)",
    });
  });

  it("🔴 不管底色多淺都是白字(使用者裁決:一律白字,代價已告知)", () => {
    // 接近白色的底色 —— 舊版(自動挑色)在這裡會給深墨色字。
    expect(solidFillStyle("#fffdf5").color).toBe(STATUS_PILL_INK);
    expect(solidFillStyle("#ffffff").color).toBe(STATUS_PILL_INK);
  });

  it("🔴 淺底色也一定有看得到的描邊(否則白底卡片上會變成白底+白邊+白字整顆消失)", () => {
    // 描邊固定深色,**不可以**是 rgba(255,255,255,…) —— 那就是整顆消失的那個 bug。
    expect(solidFillStyle("#ffffff").borderColor).toBe(STATUS_PILL_BORDER);
    expect(STATUS_PILL_BORDER.startsWith("rgba(17, 24, 39,")).toBe(true);
  });

  it("底色字串原樣輸出,不加深、不正規化(使用者原話:顏色完全不動)", () => {
    for (const raw of ["#ABC", "  #ffaa33  ", "rgb(7, 207, 104)", "hsl(210, 70%, 50%)", "red"]) {
      expect(solidFillStyle(raw).backgroundColor).toBe(raw);
    }
  });

  it("216 種顏色掃過去,文字色與描邊色永遠是同一組固定值", () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const style = solidFillStyle(hex);
          expect(style.color, `${hex} 的文字色不是白字`).toBe(STATUS_PILL_INK);
          expect(style.borderColor, `${hex} 的描邊色被改掉了`).toBe(STATUS_PILL_BORDER);
          expect(style.backgroundColor).toBe(hex);
        }
      }
    }
  });

  it("商家設定頁 4 個預設色 + 行事曆 3 個排程狀態色,一律白字", () => {
    // #1050:DEFAULT_CALENDAR_STATE_STYLES 多了 opacity(透明度物件,不是色碼)⇒ 只取色碼欄位。
    const calendarColors = Object.fromEntries(
      Object.entries(DEFAULT_CALENDAR_STATE_STYLES).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    for (const [key, color] of Object.entries({
      ...DEFAULT_BOOKING_STATUS_COLORS,
      ...calendarColors,
    })) {
      expect(solidFillStyle(color).color, `${key}(${color})不是白字`).toBe(STATUS_PILL_INK);
    }
  });
});
