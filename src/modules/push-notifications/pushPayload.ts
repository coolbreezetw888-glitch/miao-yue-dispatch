// 模組 15(服務人員推播通知)§7.1:public/push-sw.js 裡 push/notificationclick 事件處理邏輯的
// 純函式版本,方便 Vitest 測試(service worker 執行環境依賴 `self`/`clients`/`registration`
// 這些全域物件,測試環境沒有,見規格書 §7.1 測試要求)。這裡的邏輯必須跟 public/push-sw.js
// 裡的 handlePushEvent/handleNotificationClick 保持一致——比照模組 11 判斷 11「前端/Edge Function
// 執行環境彼此不共用程式碼,各自各寫一份小型函式」的既有先例,push-sw.js 是純 JavaScript 靜態
// 檔案(不經過 Vite/TypeScript 編譯),沒辦法直接 import 這個 TS 檔案。

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
}

const DEFAULT_PAYLOAD: PushNotificationPayload = {
  title: "秒約",
  body: "",
  url: "/app/my-calendar",
};

/** 對應 push-sw.js 的 handlePushEvent 內解析邏輯:給定推播事件收到的原始 JSON 內容
 * (`event.data.json()` 的結果),組出 showNotification 要用的 {title, body, url}。
 * 解析失敗或欄位型別不對時一律 fallback 成預設值,不拋錯(規則 4.3「安靜」精神延伸到這裡)。 */
export function parsePushPayload(raw: unknown): PushNotificationPayload {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYLOAD };
  const record = raw as Record<string, unknown>;
  const title = record["title"];
  const body = record["body"];
  const url = record["url"];
  return {
    title: typeof title === "string" && title ? title : DEFAULT_PAYLOAD.title,
    body: typeof body === "string" ? body : DEFAULT_PAYLOAD.body,
    url: typeof url === "string" && url ? url : DEFAULT_PAYLOAD.url,
  };
}

/** 對應 push-sw.js 的 handleNotificationClick:從 `event.notification.data` 取出要導向的網址,
 * 查無資料時 fallback 到我的行事曆首頁(規格書 7.1 第 3 點:先不做深層連結)。 */
export function resolveNotificationClickUrl(notificationData: unknown): string {
  if (notificationData && typeof notificationData === "object") {
    const url = (notificationData as Record<string, unknown>)["url"];
    if (typeof url === "string" && url) return url;
  }
  return DEFAULT_PAYLOAD.url;
}

/** 組出 `registration.showNotification(title, options)` 的第二個參數,供測試驗證欄位是否正確。 */
export function buildShowNotificationOptions(payload: PushNotificationPayload): {
  body: string;
  icon: string;
  data: { url: string };
} {
  return {
    body: payload.body,
    icon: "/icons/icon-192.png",
    data: { url: payload.url },
  };
}
