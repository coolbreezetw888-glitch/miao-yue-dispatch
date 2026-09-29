// 訂閱一條 CSS media query 的結果(例如「螢幕是不是 640px 以上」),回傳 true/false。
//
// 2026-09-29(ui-v1-small,SPECS-INDEX #835,規範見 .claude/skills/ui-overlay-patterns/SKILL.md 第五節)
// 為了讓通知面板「手機從底部滑上來、電腦是 380px 氣泡」而加。這兩種是**不同的 Radix 元件**
// (Sheet vs Popover),沒辦法只靠 CSS class 切換,所以 React 這邊要知道目前的螢幕寬度。
//
// 為什麼不用既有的 src/hooks/use-mobile.tsx:
//   ・它的斷點寫死 768px,跟 Tailwind 的 `sm`(640px)不一致 —— 全站的 RWD class 都是用 `sm:`,
//     這裡要跟著同一條線,否則會出現「CSS 認為是電腦、React 認為是手機」的半套狀態。
//   ・它在沒有 window.matchMedia 的環境(vitest 的 jsdom)會直接丟錯,這裡多一層保護。
//
// 用 useSyncExternalStore 而不是 useState + useEffect:第一次渲染就拿得到正確值,不會先渲染
// 一個錯的版本再閃一下切換。
import { useCallback, useSyncExternalStore } from "react";

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = () => (hasMatchMedia() ? window.matchMedia(query).matches : false);
  // SSR / 測試環境沒有視窗可量:一律當成「不符合」。
  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Tailwind `sm` 斷點(640px)以上 = 電腦/平板版面。跟全站 `sm:` class 用同一條線。 */
export const TAILWIND_SM_MEDIA_QUERY = "(min-width: 640px)";
