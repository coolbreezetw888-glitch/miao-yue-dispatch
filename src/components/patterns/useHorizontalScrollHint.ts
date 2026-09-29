/**
 * 右緣漸層要不要顯示 —— ui-overlay-patterns skill 六「右緣用漸層陰影暗示還有內容」的配套。
 *
 * ## 為什麼需要這支 hook(2026-09-30 QA 抓到)
 *
 * 行事曆與排班一覽的右緣漸層原本是**永遠顯示**的一個 `absolute inset-y-0 right-0 w-6` 區塊。
 * 問題:
 *   1. 螢幕夠寬、根本不用橫捲的時候(電腦上 2 位服務人員),它還是在那裡把**最右邊 24px 蓋掉**;
 *   2. 已經捲到最右端、後面沒有內容了,它還在暗示「右邊還有東西」——那是假訊息。
 *
 * 漸層的語意就是「**這個方向還有內容**」,所以它應該只在「現在真的還能往右捲」時出現。
 *
 * 用法:把回傳的 `ref` 掛到**捲動容器**(`overflow-x-auto` 那一層),用 `canScrollRight` 決定漸層
 * 要不要 render。容器寬度 / 內容寬度 / 捲動位置任何一項變了都會重算(scroll + ResizeObserver)。
 *
 * ```tsx
 * const { ref, canScrollRight } = useHorizontalScrollHint();
 * <div className="relative">
 *   <div ref={ref} className="overflow-x-auto">…</div>
 *   {canScrollRight ? <div aria-hidden className="pointer-events-none absolute …" /> : null}
 * </div>
 * ```
 *
 * 捲動容器同時被別的東西用 callback ref 佔著(行事曆的 `dragController.setGridRoot`)時,
 * 用 `attach` 把兩個 ref 串起來,不要二選一。
 */

import * as React from "react";

/** 容差 1px:瀏覽器在縮放比例不是整數時,scrollWidth / clientWidth 會差個零點幾。 */
const EPSILON = 1;

export function useHorizontalScrollHint(): {
  /** 掛到捲動容器上的 ref(callback ref,可以跟別的 ref 串)。 */
  attach: (node: HTMLElement | null) => void;
  /** 現在是不是還能往右捲(= 右邊還有沒看到的內容)。 */
  canScrollRight: boolean;
} {
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  const nodeRef = React.useRef<HTMLElement | null>(null);
  const observerRef = React.useRef<ResizeObserver | null>(null);

  const measure = React.useCallback(() => {
    const node = nodeRef.current;
    if (!node) {
      setCanScrollRight(false);
      return;
    }
    setCanScrollRight(node.scrollWidth - node.clientWidth - node.scrollLeft > EPSILON);
  }, []);

  const attach = React.useCallback(
    (node: HTMLElement | null) => {
      const prev = nodeRef.current;
      if (prev === node) return;
      if (prev) {
        prev.removeEventListener("scroll", measure);
        observerRef.current?.disconnect();
        observerRef.current = null;
      }
      nodeRef.current = node;
      if (!node) {
        setCanScrollRight(false);
        return;
      }
      node.addEventListener("scroll", measure, { passive: true });
      // 容器變寬 / 內容(服務人員欄數)變多都要重算。jsdom 沒有 ResizeObserver,所以要防呆。
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => measure());
        observer.observe(node);
        if (node.firstElementChild) observer.observe(node.firstElementChild);
        observerRef.current = observer;
      }
      measure();
    },
    [measure],
  );

  React.useEffect(() => () => attach(null), [attach]);

  return { attach, canScrollRight };
}
