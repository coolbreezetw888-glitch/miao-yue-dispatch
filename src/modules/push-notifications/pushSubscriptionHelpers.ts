// 模組 15(服務人員推播通知)§7.2:usePushSubscription 用到的純函式,抽出來方便 Vitest 測試
// (不依賴 Notification/navigator.serviceWorker/PushManager 這些瀏覽器全域物件)。

/** 把 VAPID 公鑰(base64url 字串)轉成 Uint8Array,`pushManager.subscribe` 的
 * `applicationServerKey` 參數要用這個格式(標準 Web Push 做法)。 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** 判斷目前這台裝置(依 endpoint)是不是已經在資料庫的訂閱清單裡。 */
export function findMatchingSubscription<T extends { endpoint: string }>(
  subscriptions: T[],
  currentEndpoint: string | null,
): T | null {
  if (!currentEndpoint) return null;
  return subscriptions.find((s) => s.endpoint === currentEndpoint) ?? null;
}

/** 第六節規則 3:iOS Safari 但尚未以獨立視窗模式開啟時,不顯示「開啟通知」按鈕,改顯示引導文字。
 * 複用模組 7 InstallPwaHint.tsx 已經匯出的 detectIosSafari/isRunningStandalone 純函式判斷結果
 * 當作輸入,這裡只負責組合判斷,不重新寫一次 User Agent 判斷邏輯。 */
export function shouldBlockIosNonStandalone(isIosSafari: boolean, isStandalone: boolean): boolean {
  return isIosSafari && !isStandalone;
}
