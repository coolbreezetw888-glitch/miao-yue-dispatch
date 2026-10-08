// 第 11 批 J(#995):視窗上方空白條 / 放棄確認的純邏輯與常數(拆出 .tsx 是為了 react-refresh 規則:
// 元件檔只 export 元件)。🔴 只給三個殼用,頁面不要 import。

/** 全頁層(電腦)空白條上限:面板上緣 56px。
 *  第 21 批 #1020(使用者裁決):只有全頁層有空白條;小卡窗 / 確認窗的空白條(原本上限 48px)已拿掉。 */
export const FULL_PAGE_STRIP_MAX_HEIGHT = 56;
/** 上方剩不到這麼多就不畫。 */
export const STRIP_MIN_HEIGHT = 16;

export interface StripRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function sameRect(a: StripRect | null, b: StripRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** 依視窗本體的位置算出空白條的位置;上方不夠 STRIP_MIN_HEIGHT ⇒ null(不畫)。 */
export function computeStripRect(
  target: { top: number; left: number; width: number },
  maxHeight: number,
): StripRect | null {
  const height = Math.min(maxHeight, target.top);
  if (!(height >= STRIP_MIN_HEIGHT) || !(target.width > 0)) return null;
  // 空白條的下緣緊貼視窗上緣(小卡窗置中時上緣常是 .5px,不取整數,免得中間露出 1px 的遮罩)。
  return { top: target.top - height, left: target.left, width: target.width, height };
}

/** 產生一個「假的 Esc 按鍵事件」,讓空白條走跟 Esc 同一條路(頁面的 onEscapeKeyDown 可以 preventDefault 攔下)。 */
export function createDismissEscapeEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: false });
}

export const DISCARD_CHANGES_COPY = {
  title: "確定放棄這次輸入？",
  body: "剛剛填的內容還沒儲存，關掉就會不見。",
  keepEditing: "繼續編輯",
  discard: "放棄",
} as const;
