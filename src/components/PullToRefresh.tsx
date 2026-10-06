// SPECS-INDEX #982(2026-10-06):手機下拉刷新 —— 共用外殼層級元件。
// 規格:.project/specs/建單畫面與下拉刷新-第2批.md 第三節;判斷邏輯在 src/lib/pullToRefresh.ts。
//
// 掛在 src/routes/AppLayout.tsx(商家端與服務人員端**共用同一個外殼**),所以 /app 底下所有頁面
// 一次就有,不需要每頁各寫一份(規格第 6 點)。
//
// ─── 做了什麼 ────────────────────────────────────────────────────────────────────
//   ・手機(寬 < 1024px、觸控)頁面已經在最頂端時往下拉 ⇒ 頂部出現小箭頭 + 「下拉以重新整理」;
//     超過 70px 變「放開以重新整理」;放開 ⇒ 轉圈 +「重新整理中」,
//     重新抓**目前畫面上所有作用中的資料**(react-query 的 refetchQueries({ type: "active" })),
//     **不整頁重新載入**(全站資料都走 react-query,沒有需要退回整頁重載的頁面)。
//   ・所有監聽都是 passive、從不 preventDefault ⇒ 不可能擋到捲動、行事曆拖拉、左右滑。
//   ・停用條件見 resolvePullBlockReason / resolvePullDirection(彈窗 / 選單 / 整頁選擇畫面開著、
//     內層捲動區不在頂端、水平為主、長按之後才拖、多指、電腦版)。
//   ・html / body 設 overscroll-behavior-y: contain,避免瀏覽器自己的下拉刷新跟這個同時觸發
//     (規格第 5 點)。只在這個外殼掛著時設,離開 /app(登入頁、首頁)就還原。

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  PULL_TEXT_REFRESHING,
  resolvePullBlockReason,
  resolvePullDirection,
  resolvePullIndicator,
  shouldTriggerRefresh,
} from "@/lib/pullToRefresh";

/** 轉圈至少顯示這麼久,資料很快回來時才不會一閃而過、看不出有沒有刷新。 */
const MIN_REFRESHING_MS = 500;

type Phase = "idle" | "pulling" | "refreshing";

export function PullToRefresh() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [distance, setDistance] = useState(0);

  // 手勢進行中的資料放 ref(touchmove 很頻繁,不必每次都觸發 render 才拿得到最新值)。
  const gesture = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    direction: "undecided" | "pull";
    distance: number;
  } | null>(null);
  const refreshingRef = useRef(false);
  // 刷新完成後「至少轉 500ms」的計時器;元件卸載(切到登入頁等)時要清掉,不能在卸載後還 setState。
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overscrollBehaviorY;
    const prevBody = body.style.overscrollBehaviorY;
    html.style.overscrollBehaviorY = "contain";
    body.style.overscrollBehaviorY = "contain";
    return () => {
      html.style.overscrollBehaviorY = prevHtml;
      body.style.overscrollBehaviorY = prevBody;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    function reset() {
      gesture.current = null;
      if (!refreshingRef.current) {
        setPhase("idle");
        setDistance(0);
      }
    }

    function onTouchStart(e: TouchEvent) {
      if (refreshingRef.current) return;
      const reason = resolvePullBlockReason({
        target: e.target instanceof Element ? e.target : null,
        doc: document,
        viewportWidth: window.innerWidth,
        touchCount: e.touches.length,
        pageScrollTop: window.scrollY || document.documentElement.scrollTop || 0,
      });
      if (reason !== null) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      gesture.current = {
        startX: t.clientX,
        startY: t.clientY,
        startTime: performance.now(),
        direction: "undecided",
        distance: 0,
      };
    }

    function onTouchMove(e: TouchEvent) {
      const g = gesture.current;
      if (!g) return;
      // 別的元件已經接手這個手勢(例:行事曆拖拉在 dragging 時 preventDefault)、或第二根手指放上來 ⇒ 放棄。
      if (e.defaultPrevented || e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      if (g.direction === "undecided") {
        const direction = resolvePullDirection({
          dx,
          dy,
          elapsedMs: performance.now() - g.startTime,
        });
        if (direction === "cancel") {
          reset();
          return;
        }
        if (direction === "undecided") return;
        g.direction = "pull";
        setPhase("pulling");
      }
      g.distance = Math.max(0, dy);
      setDistance(g.distance);
    }

    function onTouchEnd() {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.direction !== "pull") {
        reset();
        return;
      }
      if (!shouldTriggerRefresh(g.distance)) {
        reset();
        return;
      }
      refreshingRef.current = true;
      setPhase("refreshing");
      const started = performance.now();
      void queryClient
        .refetchQueries({ type: "active" })
        .catch(() => {
          // 個別查詢失敗由各頁自己的錯誤狀態顯示;這裡只負責把指示器收起來。
        })
        .finally(() => {
          if (disposed) return;
          const wait = Math.max(0, MIN_REFRESHING_MS - (performance.now() - started));
          hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            refreshingRef.current = false;
            setPhase("idle");
            setDistance(0);
          }, wait);
        });
    }

    const passive = { passive: true } as const;
    document.addEventListener("touchstart", onTouchStart, passive);
    document.addEventListener("touchmove", onTouchMove, passive);
    document.addEventListener("touchend", onTouchEnd, passive);
    document.addEventListener("touchcancel", reset, passive);
    return () => {
      disposed = true;
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", reset);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [queryClient]);

  if (phase === "idle") return null;

  const indicator = resolvePullIndicator(distance);
  const refreshing = phase === "refreshing";
  const offset = refreshing ? 40 : indicator.offset;

  return (
    <div
      data-testid="pull-to-refresh-indicator"
      data-state={refreshing ? "refreshing" : indicator.ready ? "ready" : "pulling"}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-14 z-30 flex justify-center lg:hidden"
      style={{
        transform: `translateY(${offset - 24}px)`,
        opacity: refreshing ? 1 : indicator.progress,
      }}
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-[13px] text-foreground shadow-md">
        {refreshing ? (
          <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden="true" />
        ) : (
          <ArrowDown
            className={cn(
              "h-4 w-4 text-brand transition-transform",
              indicator.ready && "rotate-180",
            )}
            aria-hidden="true"
          />
        )}
        <span>{refreshing ? PULL_TEXT_REFRESHING : indicator.text}</span>
      </div>
    </div>
  );
}
