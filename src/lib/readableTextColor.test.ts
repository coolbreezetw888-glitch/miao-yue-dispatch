// readableTextColor.ts 的單元測試(SPECS-INDEX #832 收尾批,2026-09-30 使用者裁決)。
//
// 這支函式的存在理由:訂單卡片的狀態膠囊改成「實心填入商家自訂的顏色」之後,文字顏色
// 不能寫死白字——商家挑淺黃色的話白字會完全看不見。所以這裡要釘住三件事:
//   ① 很深的底色 → 白字;很淺的底色 → 深墨色字;中間亮度 → 二選一但**結果必須是確定的**。
//   ② 商家設定頁的 4 個預設色各自挑到的那一邊,對比度真的比另一邊高(不是憑感覺)。
//   ③ 解析不出來的顏色格式不噴錯,退化成深墨色字。
//
// ⚠️ 不要把這些斷言改成「亮度 > 0.5 給黑字」那種門檻寫法——見 readableTextColor.ts 開頭
//    說明的飽和綠 #1ea25d 案例:門檻寫法會在中間亮度區挑到比較看不清楚的那一邊。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOOKING_STATUS_COLORS,
  DEFAULT_CALENDAR_STATE_STYLES,
} from "@/modules/booking/types";

import {
  contrastRatioFromLuminance,
  parseColorToRgb,
  READABLE_INK_DARK,
  READABLE_INK_LIGHT,
  readableTextColorOn,
  relativeLuminance,
  solidFillStyle,
} from "./readableTextColor";

/** 測試輔助:算「某個文字色」在「某個底色」上的對比度,用來驗證挑的那一邊真的比較清楚。 */
function contrast(foreground: string, background: string): number {
  const fg = parseColorToRgb(foreground);
  const bg = parseColorToRgb(background);
  if (!fg || !bg) throw new Error(`測試資料有誤,解析不出顏色:${foreground} / ${background}`);
  return contrastRatioFromLuminance(relativeLuminance(fg), relativeLuminance(bg));
}

describe("parseColorToRgb", () => {
  it("6 碼 hex(有沒有 # 都吃)", () => {
    expect(parseColorToRgb("#1c6fd2")).toEqual([28, 111, 210]);
    expect(parseColorToRgb("1C6FD2")).toEqual([28, 111, 210]);
  });

  it("3 碼 hex 展開成 6 碼", () => {
    expect(parseColorToRgb("#abc")).toEqual([170, 187, 204]);
  });

  it("前後有空白也吃", () => {
    expect(parseColorToRgb("  #ffffff  ")).toEqual([255, 255, 255]);
  });

  it("rgb() / rgba() 也吃(色碼欄位允許自由輸入,商家有可能自己貼這種)", () => {
    expect(parseColorToRgb("rgb(235, 170, 45)")).toEqual([235, 170, 45]);
    expect(parseColorToRgb("rgba(235, 170, 45, 0.5)")).toEqual([235, 170, 45]);
  });

  it("CSS 顏色名稱 / hsl() / 亂打的字串一律回傳 null(不噴錯)", () => {
    expect(parseColorToRgb("red")).toBeNull();
    expect(parseColorToRgb("hsl(210, 70%, 50%)")).toBeNull();
    expect(parseColorToRgb("#12345")).toBeNull();
    expect(parseColorToRgb("")).toBeNull();
    expect(parseColorToRgb("rgb(300, 0, 0)")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("黑是 0、白是 1", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });

  it("越亮的顏色亮度越高(綠 > 紅 > 藍,因為人眼對綠最敏感)", () => {
    const green = relativeLuminance([0, 255, 0]);
    const red = relativeLuminance([255, 0, 0]);
    const blue = relativeLuminance([0, 0, 255]);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe("readableTextColorOn:三個代表性的底色", () => {
  it("很深的藍 #0b2545 → 白字", () => {
    expect(readableTextColorOn("#0b2545")).toBe(READABLE_INK_LIGHT);
    // 而且白字真的比深墨色字清楚。
    expect(contrast(READABLE_INK_LIGHT, "#0b2545")).toBeGreaterThan(
      contrast(READABLE_INK_DARK, "#0b2545"),
    );
  });

  it("很淺的黃 #fff3b0 → 深墨色字(這就是使用者遇到的情境:白字會完全看不見)", () => {
    expect(readableTextColorOn("#fff3b0")).toBe(READABLE_INK_DARK);
    expect(contrast(READABLE_INK_DARK, "#fff3b0")).toBeGreaterThan(
      contrast(READABLE_INK_LIGHT, "#fff3b0"),
    );
    // 白字在淺黃上不到 1.3:1,完全讀不出來——這條就是「不可以寫死白字」的證據。
    expect(contrast(READABLE_INK_LIGHT, "#fff3b0")).toBeLessThan(1.4);
  });

  it("中間灰 #808080 → 二選一都可以,但結果必須是確定的(同樣輸入永遠同樣輸出)", () => {
    const first = readableTextColorOn("#808080");
    expect([READABLE_INK_DARK, READABLE_INK_LIGHT]).toContain(first);
    for (let i = 0; i < 5; i += 1) {
      expect(readableTextColorOn("#808080")).toBe(first);
    }
    // 大小寫、有沒有 #、前後空白都不可以改變結果。
    expect(readableTextColorOn("808080")).toBe(first);
    expect(readableTextColorOn(" #808080 ")).toBe(first);
    expect(readableTextColorOn("#808080".toUpperCase())).toBe(first);
    expect(readableTextColorOn("rgb(128, 128, 128)")).toBe(first);
  });

  it("純黑 → 白字、純白 → 深墨色字(兩個極端)", () => {
    expect(readableTextColorOn("#000000")).toBe(READABLE_INK_LIGHT);
    expect(readableTextColorOn("#ffffff")).toBe(READABLE_INK_DARK);
  });

  it("解析不出來的顏色格式退化成深墨色字,不噴錯", () => {
    expect(readableTextColorOn("red")).toBe(READABLE_INK_DARK);
    expect(readableTextColorOn("")).toBe(READABLE_INK_DARK);
  });
});

describe("readableTextColorOn:永遠挑對比度比較高的那一邊", () => {
  // 掃一整片色域(每個分量 0/51/102/153/204/255 = 216 種顏色),逐一驗證挑到的那一邊
  // 對比度 >= 另一邊。這條是整支函式最核心的不變量,比單挑幾個顏色可靠。
  it("216 種顏色全部成立", () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const picked = readableTextColorOn(hex);
          const other = picked === READABLE_INK_LIGHT ? READABLE_INK_DARK : READABLE_INK_LIGHT;
          expect(
            contrast(picked, hex),
            `${hex} 挑了 ${picked},但 ${other} 的對比度更高`,
          ).toBeGreaterThanOrEqual(contrast(other, hex));
        }
      }
    }
  });
});

describe("readableTextColorOn:商家設定頁的預設色", () => {
  it("待確認 #ebaa2d(黃橘)→ 深墨色字", () => {
    // 這就是使用者反映的那個顏色:淺黃橘色,白字幾乎看不見(只有 2.0:1)。
    expect(readableTextColorOn(DEFAULT_BOOKING_STATUS_COLORS.pendingConfirmation)).toBe(
      READABLE_INK_DARK,
    );
  });

  it("已確認 #1c6fd2(藍)→ 白字", () => {
    expect(readableTextColorOn(DEFAULT_BOOKING_STATUS_COLORS.accepted)).toBe(READABLE_INK_LIGHT);
  });

  it("已完成 #1ea25d(綠)→ 深墨色字(白字只有 3.3:1,達不到 AA)", () => {
    expect(readableTextColorOn(DEFAULT_BOOKING_STATUS_COLORS.completed)).toBe(READABLE_INK_DARK);
    // 🔴 這個顏色就是 READABLE_INK_DARK 不能調淡的原因:白字 3.29:1 達不到 AA,
    //    深墨色字必須夠深才補得上來(#111827 是 5.39:1)。
    expect(contrast(READABLE_INK_LIGHT, DEFAULT_BOOKING_STATUS_COLORS.completed)).toBeLessThan(3.4);
  });

  it("已取消 #606d7f(灰藍)→ 白字", () => {
    expect(readableTextColorOn(DEFAULT_BOOKING_STATUS_COLORS.cancelled)).toBe(READABLE_INK_LIGHT);
  });

  it("4 個預設色挑出來的文字顏色都達到 WCAG AA 的 4.5:1", () => {
    for (const [key, color] of Object.entries(DEFAULT_BOOKING_STATUS_COLORS)) {
      const ink = readableTextColorOn(color);
      expect(contrast(ink, color), `${key}(${color})用 ${ink} 的對比度不足`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("行事曆排程狀態的 3 個預設色也都達到 4.5:1(之後如果也改成實心就直接可用)", () => {
    for (const [key, color] of Object.entries(DEFAULT_CALENDAR_STATE_STYLES)) {
      const ink = readableTextColorOn(color);
      expect(contrast(ink, color), `${key}(${color})用 ${ink} 的對比度不足`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe("solidFillStyle", () => {
  it("底色原樣、文字自動挑、邊框是文字色的 25% 透明度", () => {
    expect(solidFillStyle("#1c6fd2")).toEqual({
      backgroundColor: "#1c6fd2",
      color: READABLE_INK_LIGHT,
      borderColor: "rgba(255, 255, 255, 0.25)",
    });
    expect(solidFillStyle("#ebaa2d")).toEqual({
      backgroundColor: "#ebaa2d",
      color: READABLE_INK_DARK,
      borderColor: "rgba(17, 24, 39, 0.25)",
    });
  });

  it("接近白色的底色也要有看得到的邊框(否則白底卡片上膠囊會整個消失)", () => {
    const style = solidFillStyle("#fffdf5");
    expect(style.color).toBe(READABLE_INK_DARK);
    expect(style.borderColor).toBe("rgba(17, 24, 39, 0.25)");
  });
});
