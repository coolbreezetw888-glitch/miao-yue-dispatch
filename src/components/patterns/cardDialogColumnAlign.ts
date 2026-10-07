// 第 15 批 #1009:電腦版小卡窗(CardDialog)的左右邊界對齊「底下那頁的主要內容欄」。
// 🔴 只給 CardDialog 殼用,頁面不要 import;也不要逐頁硬寫寬度。
//
// 使用者原話(2026-10-07,料錢成本管理 → 編輯品項截圖):「這個寬度應該要同紅框的寬度,現在反而過寬。」
// 紅框 = 頁面標題下方那塊主要內容卡片的左右邊界 = 頁面容器(`mx-auto max-w-* px-5`)扣掉左右內距的那一欄。
//
// 做法:
//   1. App 殼層的主要內容容器標 `data-app-content-root`(AppLayout / PlatformAdminShell 的 <main>)。
//   2. 小卡窗打開時往下找「真正的頁面容器」:從 root 開始,遇到有左右內距、或比 root 窄的元素就是它;
//      否則往唯一 / 第一個看得到的子元素走(最多幾層)。量它扣掉邊框與內距後的左右邊界。
//   3. 底下有全頁層(FullPageLayer)開著 ⇒ 改對齊全頁層面板的左右邊界(規格書 #1009)。
//   4. 都找不到(或量出來太窄)⇒ 回傳 null,小卡窗退回第 12 批規則(左右 16px、最寬 1152px)。
//   量測用 offsetWidth(不受 zoom 動畫的 transform 影響)+ getBoundingClientRect 的中心點
//   (scale 以中心為原點,中心不會動),所以全頁層還在進場動畫時量到的也是最終位置。

import * as React from "react";

/** App 殼層主要內容容器的標記(值給空字串)。 */
export const APP_CONTENT_ROOT_ATTR = "data-app-content-root";

/** 畫面左右至少留這麼多(與第 12 批規則相同)。 */
export const CARD_COLUMN_VIEWPORT_GUTTER = 16;
/** 量到的欄位比這個窄 ⇒ 視為量錯,退回原規則。 */
export const CARD_COLUMN_MIN_WIDTH = 320;
/** 從 root 往下找頁面容器時最多走幾層。 */
const MAX_DESCEND_DEPTH = 4;

export interface CardColumnAlign {
  /** 欄位中心點的 x(px,視窗座標;卡片本身用 left = 中心 + translateX(-50%) 置中)。 */
  center: number;
  width: number;
}

export function sameColumnAlign(a: CardColumnAlign | null, b: CardColumnAlign | null): boolean {
  if (a === null || b === null) return a === b;
  return a.center === b.center && a.width === b.width;
}

/** 純函式:把欄位左右邊界夾進畫面(左右各留 16px);太窄 ⇒ null。 */
export function computeCardColumnAlign(
  column: { left: number; right: number },
  viewportWidth: number,
): CardColumnAlign | null {
  const left = Math.max(CARD_COLUMN_VIEWPORT_GUTTER, column.left);
  const right = Math.min(viewportWidth - CARD_COLUMN_VIEWPORT_GUTTER, column.right);
  const width = right - left;
  if (!Number.isFinite(width) || width < CARD_COLUMN_MIN_WIDTH) return null;
  return { center: left + width / 2, width };
}

/** 元素「不含 transform」的左右邊界;inner = true 時再扣掉邊框與左右內距(= 內容欄)。 */
function horizontalEdges(el: HTMLElement, inner: boolean): { left: number; right: number } {
  const rect = el.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  const half = el.offsetWidth / 2;
  if (!inner) return { left: center - half, right: center + half };
  const cs = getComputedStyle(el);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return {
    left: center - half + px(cs.borderLeftWidth) + px(cs.paddingLeft),
    right: center + half - px(cs.borderRightWidth) - px(cs.paddingRight),
  };
}

function isInFlowVisible(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") return false;
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

/** 從 App 殼層 root 往下找頁面容器(有左右內距、或比 root 窄的第一層)。 */
export function findPageColumnElement(root: HTMLElement): HTMLElement | null {
  const rootWidth = root.offsetWidth;
  let el: HTMLElement = root;
  for (let depth = 0; depth <= MAX_DESCEND_DEPTH; depth += 1) {
    const cs = getComputedStyle(el);
    const padded =
      (Number.parseFloat(cs.paddingLeft) || 0) > 0 || (Number.parseFloat(cs.paddingRight) || 0) > 0;
    if (padded || el.offsetWidth < rootWidth - 1) return el;
    const next = Array.from(el.children).find(isInFlowVisible);
    if (!next) return null;
    el = next;
  }
  return null;
}

/** 底下開著的全頁層面板(排除小卡窗自己、浮出面板 Popover)。 */
function findOpenUnderlyingLayer(card: HTMLElement): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'),
  ).filter(
    (el) =>
      el !== card &&
      !el.contains(card) &&
      !card.contains(el) &&
      !el.closest("[data-radix-popper-content-wrapper]") &&
      getComputedStyle(el).position === "fixed" &&
      el.offsetWidth > 0,
  );
  return candidates.at(-1) ?? null;
}

/** 量出小卡窗該對齊的欄位;找不到 ⇒ null(退回原規則)。 */
export function measureCardColumnAlign(card: HTMLElement): CardColumnAlign | null {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const layer = findOpenUnderlyingLayer(card);
  if (layer) return computeCardColumnAlign(horizontalEdges(layer, false), viewportWidth);
  const root = document.querySelector<HTMLElement>(`[${APP_CONTENT_ROOT_ATTR}]`);
  if (!root) return null;
  const column = findPageColumnElement(root);
  if (!column) return null;
  return computeCardColumnAlign(horizontalEdges(column, true), viewportWidth);
}

/**
 * 小卡窗本體掛上去後量一次,之後畫面拉寬拉窄(resize)、內容欄尺寸變(ResizeObserver)、
 * 進場動畫結束、下一個 frame(鎖捲動造成的位移)都再量。量到 null ⇒ 小卡窗走原本規則。
 */
export function useCardColumnAlign(card: HTMLElement | null): CardColumnAlign | null {
  const [align, setAlign] = React.useState<CardColumnAlign | null>(null);

  React.useLayoutEffect(() => {
    if (!card) {
      setAlign(null);
      return undefined;
    }
    let frame = 0;
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => schedule()) : null;
    const measure = () => {
      const next = measureCardColumnAlign(card);
      setAlign((prev) => (sameColumnAlign(prev, next) ? prev : next));
    };
    function schedule() {
      if (typeof window.requestAnimationFrame !== "function") {
        measure();
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    }
    measure();
    schedule();
    const root = document.querySelector<HTMLElement>(`[${APP_CONTENT_ROOT_ATTR}]`);
    if (observer && root) observer.observe(root);
    card.addEventListener("animationend", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
      observer?.disconnect();
      card.removeEventListener("animationend", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [card]);

  return align;
}
