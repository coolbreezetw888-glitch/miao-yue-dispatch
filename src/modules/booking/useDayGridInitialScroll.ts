// SPECS-INDEX #1049(R2):時間軸改畫 00:00~24:00 之後,打開頁面 / 換日期時自動捲到營業開始時間
// (沒有營業時間 ⇒ 08:00)。商家端 CalendarPage 與服務人員端 MyCalendarTimelineView 共用。
//
// 規則:**同一個日期、同一個捲動框只捲一次**。資料重新整理(包含即時同步重查、拖拉後重抓)不會換捲動框,
// 所以不會再捲,使用者自己捲到哪裡就停在哪裡;換到別的日期才會再捲一次。
// #1049 QA L1:同一天裡捲動框被拆掉重掛(例:商家端 週檢視 → 月檢視 → 回週檢視、服務人員端 卡片列表 → 時間軸),
// 新的框 scrollTop 是 0、會停在 00:00 的深色區 ⇒ 換了新的捲動框也要再捲一次。

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * @param dateKey  目前顯示的日期(YYYY-MM-DD)。換日期 = 要再捲一次。
 * @param targetPx 要捲到的位置(px);資料還沒讀到(不知道營業時間)時傳 null,等讀到再捲。
 * @returns 掛在「捲動容器」上的 callback ref。
 */
export function useDayGridInitialScroll(
  dateKey: string,
  targetPx: number | null,
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  // 上一次捲過的「日期 + 捲動框」。兩者都一樣 ⇒ 不再捲。
  const scrolledRef = useRef<{ dateKey: string; node: HTMLElement } | null>(null);

  useLayoutEffect(() => {
    if (!node || targetPx === null) return;
    const last = scrolledRef.current;
    if (last && last.dateKey === dateKey && last.node === node) return;
    scrolledRef.current = { dateKey, node };
    node.scrollTop = Math.max(0, targetPx);
  }, [node, dateKey, targetPx]);

  return useCallback((next: HTMLElement | null) => setNode(next), []);
}
