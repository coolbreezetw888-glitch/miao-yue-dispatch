/**
 * 視窗正上方「點了關閉」的空白條 —— ui-overlay-patterns skill 三之六(第 11 批 J,#995 J-4 ~ J-7)。
 *
 * 🔴 只給三個殼(FullPageLayer / CardDialog / CardAlertDialog)用,頁面不要 import。
 *
 * 規則:
 *   - 全站視窗點遮罩(左右兩側、下方)一律不關;改成視窗**正上方**留一條透明可點區,點了 = 按 Esc。
 *   - 寬度 = 視窗寬、左右對齊視窗;高度 = min(上限, 視窗上方剩下的高度);剩不到 16px 就不畫
 *     (⇒ 手機全頁層滿版、上方 0px ⇒ 自然沒有空白條)。
 *     上限:全頁層 56px(面板上緣 sm:top-14)、小卡窗 / 確認窗 48px(≥ 44px 觸控目標)。
 *   - 它是 Portal 裡、遮罩之後的兄弟元素(fixed、pointer-events-auto、z-50),用 ResizeObserver +
 *     resize + animationend 量視窗本體的 getBoundingClientRect() 定位。
 *   - aria-hidden、不可 Tab 聚焦(鍵盤用 Esc;螢幕閱讀器用既有 ✕ / 取消鈕)。
 */

import * as React from "react";
import { X } from "lucide-react";

import { computeStripRect, sameRect, type StripRect } from "./overlayDismissLogic";

interface OverlayDismissStripProps {
  /** 視窗本體(Radix Content)的 ref。 */
  targetRef: React.RefObject<HTMLElement | null>;
  maxHeight: number;
  /** 「關閉」(全頁層 / 小卡窗)或「取消」(確認窗)。 */
  label: string;
  onDismiss: () => void;
}

export function OverlayDismissStrip({
  targetRef,
  maxHeight,
  label,
  onDismiss,
}: OverlayDismissStripProps) {
  const [rect, setRect] = React.useState<StripRect | null>(null);

  React.useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const el = targetRef.current;
      const next = el ? computeStripRect(el.getBoundingClientRect(), maxHeight) : null;
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (typeof window.requestAnimationFrame !== "function") {
        measure();
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    // 進場動畫(zoom-in-95)期間量到的是縮小後的框,動畫結束再量一次。
    schedule();
    const el = targetRef.current;
    const observer =
      typeof ResizeObserver !== "undefined" && el ? new ResizeObserver(schedule) : null;
    if (observer && el) observer.observe(el);
    el?.addEventListener("animationend", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
      observer?.disconnect();
      el?.removeEventListener("animationend", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [targetRef, maxHeight]);

  if (!rect) return null;
  return (
    <div
      aria-hidden="true"
      data-overlay-dismiss-strip=""
      className="group pointer-events-auto fixed z-50 flex cursor-pointer select-none items-center justify-center rounded-lg transition-colors hover:bg-background/10"
      // pointer-events 也寫一份 inline:Radix 模態視窗開著時 body 是 pointer-events:none,空白條一定要能點。
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        pointerEvents: "auto",
      }}
      onClick={onDismiss}
    >
      <span className="inline-flex items-center gap-1 text-[13px] text-background opacity-60 transition-opacity group-hover:opacity-100">
        <X className="h-4 w-4" />
        {label}
      </span>
    </div>
  );
}
