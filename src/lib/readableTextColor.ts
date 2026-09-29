/**
 * 「這個底色上該放黑字還是白字」——依相對亮度自動決定,不要寫死白字。
 *
 * 為什麼需要這支函式(2026-09-30 使用者裁決,SPECS-INDEX #832 收尾批):
 *   訂單卡片的狀態膠囊改成「實心填入商家自訂的那個顏色」。商家可以在
 *   商家設定 > 訂單狀態顏色設定裡把顏色改成任何色碼,包含很淺的黃色——
 *   這時候寫死白字會完全看不見。所以文字顏色必須跟著底色算出來。
 *
 * 演算法(刻意不用「亮度 > 0.5 就給黑字」這種單一門檻):
 *   1. 把色碼轉成 sRGB 三個分量,照 WCAG 2.x 的公式做 gamma 解碼(linearize)。
 *   2. 算相對亮度 L = 0.2126R + 0.7152G + 0.0722B。
 *   3. 分別算「白字 vs 這個底色」跟「深墨色字 vs 這個底色」的對比度
 *      (L1 + 0.05) / (L2 + 0.05),**挑對比度比較高的那一個**。
 *
 * 為什麼是「比對比度」而不是「比亮度門檻」:
 *   單一門檻在中間亮度區會挑出「剛好兩邊都不夠清楚」的那一邊(例如飽和綠 #1ea25d
 *   亮度低於門檻 ⇒ 給白字,但白字在它上面只有 3.3:1,12px 的小字達不到 WCAG AA 的
 *   4.5:1;改用深墨色字是 4.5:1)。直接比對比度永遠會挑到「這兩個選項中比較看得清楚」
 *   的那一個,而且結果是確定的、不會在門檻附近抖動。
 *
 * ⚠️ 這是純函式、沒有 React 依賴,所以放在 src/lib 而不是 components/patterns——
 *    patterns/Tags.tsx(全站標籤)跟 modules/merchant(設定頁的即時預覽)都要用它,
 *    元件層不該去 import 某個功能模組的檔案。
 */

/**
 * 深墨色字。刻意不是純黑 #000(純黑在彩色底上會顯得很硬),是帶一點藍的深灰。
 *
 * 🔴 這個值不要調淡。實測:預設的「已完成」綠 #1ea25d 對白字只有 3.29:1(達不到 WCAG AA 的
 * 4.5:1),對 #1f2933 是 4.48:1 —— 還是差一點;換成現在這個 #111827 才是 5.39:1。
 * 一整排 12px 的小字膠囊差這 0.9 就是「看得清楚」跟「瞇著眼看」的差別。
 */
export const READABLE_INK_DARK = "#111827";

/** 白字。 */
export const READABLE_INK_LIGHT = "#ffffff";

/**
 * 把顏色字串解析成 0-255 的 RGB 三元組;解析不出來回傳 null。
 *
 * 支援的格式:`#rgb` / `#rrggbb`(商家設定頁的 <input type="color"> 永遠給這一種)、
 * `rgb(r, g, b)` / `rgba(r, g, b, a)`(色碼文字輸入框允許自由輸入,商家有可能自己貼這種)。
 * CSS 顏色名稱(`red`、`navy`)跟 `hsl()` 這類需要完整 CSS 解析器才認得的格式一律回傳 null,
 * 由呼叫端決定退路——這跟同專案既有的 `hexToRgba`(見 modules/booking/types.ts)同一個立場:
 * 顏色格式超出能安全計算的範圍時就退化,不噴錯、不阻擋操作。
 */
export function parseColorToRgb(color: string): [number, number, number] | null {
  const value = color.trim();

  const hex6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex6) {
    return [parseInt(hex6[1]!, 16), parseInt(hex6[2]!, 16), parseInt(hex6[3]!, 16)];
  }

  const hex3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (hex3) {
    // #abc 等於 #aabbcc
    return [
      parseInt(hex3[1]! + hex3[1]!, 16),
      parseInt(hex3[2]! + hex3[2]!, 16),
      parseInt(hex3[3]! + hex3[3]!, 16),
    ];
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/][\s\d.%]+)?\)$/i.exec(
    value,
  );
  if (rgb) {
    const parts = [rgb[1]!, rgb[2]!, rgb[3]!].map((n) => Number(n));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return [parts[0]!, parts[1]!, parts[2]!];
  }

  return null;
}

/** WCAG 2.x 的 gamma 解碼:把 0-255 的 sRGB 分量轉成線性值。 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x 相對亮度,0(黑)到 1(白)。 */
export function relativeLuminance(rgb: [number, number, number]): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

/** WCAG 2.x 對比度,1(完全看不出來)到 21(黑白)。參數順序不影響結果。 */
export function contrastRatioFromLuminance(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 這個底色上該用哪一種文字顏色。回傳 READABLE_INK_DARK 或 READABLE_INK_LIGHT。
 *
 * 解析不出來的顏色格式(CSS 顏色名稱、hsl() 等)一律回傳深墨色字:商家設定頁的
 * 色碼欄位旁邊就是 <input type="color">,實際上一定是 6 碼 hex,這條路只是防呆;
 * 深墨色字在「大多數人手動貼進來的顏色」上比白字安全(深底色的人通常是從色彩
 * 選擇器挑的,會是 hex)。
 */
export function readableTextColorOn(background: string): string {
  const rgb = parseColorToRgb(background);
  if (!rgb) return READABLE_INK_DARK;

  const bg = relativeLuminance(rgb);
  const onLight = contrastRatioFromLuminance(bg, relativeLuminance([17, 24, 39])); // #111827
  const onWhite = contrastRatioFromLuminance(bg, 1);

  // 平手時給深墨色字(結果要是確定的,不能依賴浮點數比較的方向)。
  return onWhite > onLight ? READABLE_INK_LIGHT : READABLE_INK_DARK;
}

/**
 * 實心膠囊 / 實心色塊的完整 inline style:底色 = 商家自訂色,文字 = 自動挑的黑或白,
 * 邊框 = 文字色的 25% 透明度。
 *
 * 為什麼要那條邊框:商家如果挑了接近白色的顏色,白底卡片上的實心膠囊會整個融進背景、
 * 只剩文字浮在那裡(「膠囊感」消失,就是這次改版要解決的問題本身)。用文字色去推邊框
 * 而不是用底色,才能保證不管底色多淺多深,膠囊的輪廓永遠看得到。
 */
export function solidFillStyle(background: string): {
  backgroundColor: string;
  color: string;
  borderColor: string;
} {
  const color = readableTextColorOn(background);
  return {
    backgroundColor: background,
    color,
    borderColor:
      color === READABLE_INK_LIGHT ? "rgba(255, 255, 255, 0.25)" : "rgba(17, 24, 39, 0.25)",
  };
}
