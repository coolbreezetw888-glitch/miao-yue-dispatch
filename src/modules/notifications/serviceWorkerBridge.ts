// §13.5 第 3 個重新查詢的觸發點:service worker 收到推播時主動通知畫面。
//
// 背景(§13.5 的查證結果):這個專案**沒有任何 realtime 訂閱、也沒有任何輪詢**
// (`grep -rn "\.channel(\|postgres_changes" src/` 與 `grep -rn "refetchInterval" src/` 兩個都是
// 0 命中)。v1 刻意不為了一個延伸功能替整個專案引進 realtime 基礎設施,改用三個現成就有的觸發點:
//   ① 元件掛載時查一次(react-query 標準行為);
//   ② 切回這個分頁時自動重查(main.tsx 的 QueryClient 沒有傳 defaultOptions,所以
//      refetchOnWindowFocus 維持官方預設的 true —— 這一條不用寫任何程式碼就有);
//   ③ 就是這個檔案:public/push-sw.js 收到**任何**推播時會對所有開著的分頁
//      `postMessage({ type: 'push-received' })`(測試推播另外送 'push-test-received'),
//      AppLayout 掛一個 message 監聽器,收到就 invalidate 鈴鐺的兩個 query。
//
// ⚠️ 邏輯刻意抽成純函式放在這裡,不寫在 AppLayout 的 useEffect 裡面 —— 那樣就只能靠 e2e 驗,
//    而 §十之二 明文要求一條 Vitest:「收到 push-received 會 invalidate、收到其他 type 不會」。

import type { QueryClient } from "@tanstack/react-query";

import { MY_NOTIFICATIONS_QUERY_KEY, MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY } from "./api";

/** push-sw.js 收到一般推播時送出的 type。 */
export const PUSH_RECEIVED_MESSAGE_TYPE = "push-received";

/**
 * 這則 service worker 訊息要不要讓鈴鐺重新查一次。
 *
 * ⚠️ 刻意**只**認 'push-received',不認 'push-test-received':測試推播不寫入 user_notifications
 *    (§13.2 邊界情況,CHECK 也刻意不含 'test'),所以收到測試推播時鈴鐺的內容不會有任何變化,
 *    重新查一次只是白打一次資料庫。
 */
export function shouldRefreshNotifications(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as { type?: unknown }).type === PUSH_RECEIVED_MESSAGE_TYPE;
}

/**
 * 收到 service worker 訊息時的處理:該重查就 invalidate 鈴鐺的兩個 query,否則什麼都不做。
 * 回傳值代表「有沒有真的做事」,方便測試與除錯。
 */
export function handleServiceWorkerNotificationMessage(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  data: unknown,
): boolean {
  if (!shouldRefreshNotifications(data)) return false;
  void queryClient.invalidateQueries({ queryKey: MY_NOTIFICATIONS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY });
  return true;
}
