// 模組 15(手機推播通知)§7.1:public/push-sw.js 裡 push/notificationclick 事件處理邏輯的
// 純函式版本,方便 Vitest 測試(service worker 執行環境依賴 `self`/`clients`/`registration`
// 這些全域物件,測試環境沒有,見規格書 §7.1 測試要求)。這裡的邏輯必須跟 public/push-sw.js
// 裡的 handlePushEvent/handleNotificationClick 保持一致——比照模組 11 判斷 11「前端/Edge Function
// 執行環境彼此不共用程式碼,各自各寫一份小型函式」的既有先例,push-sw.js 是純 JavaScript 靜態
// 檔案(不經過 Vite/TypeScript 編譯),沒辦法直接 import 這個 TS 檔案。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次(§〇.5 / §4.7):預設目的地原本是 '/app/my-calendar',
//    而 src/App.tsx 裡**根本沒有這個路由** —— 一旦真的有人收到推播並點下去,會落到「找不到頁面」。
//    現在 fallback 一律是 '/app'(這個路由一定存在,HomePage 本身會依角色自動導到正確落點)。
//    **不要再把任何具體的功能頁路徑寫成 fallback。** 各角色實際的落點由 Edge Function 組 payload
//    時決定(§5.5),不是前端猜的。

import type { PushTargetType } from "./types";

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  /** §6.3:只有測試推播會有。 */
  kind: "test" | null;
  /** §6.3:測試推播的送達回報網址(完整絕對網址,含一次性 token)。 */
  ackUrl: string | null;
}

/** §4.7 第 4 點:唯一允許的 fallback 目的地。 */
export const PUSH_FALLBACK_URL = "/app";

const DEFAULT_PAYLOAD: PushNotificationPayload = {
  title: "秒約",
  body: "",
  url: PUSH_FALLBACK_URL,
  kind: null,
  ackUrl: null,
};

/**
 * §4.7 第 2 點 / §5.5:收件人角色 → 點擊後的目的地。
 * ⚠️ 這張對照表跟 Edge Function 端的 `PUSH_TARGET_URLS`
 * (supabase/functions/_shared/pushDispatchCore.ts)是同一套規則的兩份實作
 * (兩個執行環境不共用程式碼)。**那一份改了,這一份也要改。**
 */
export const PUSH_TARGET_URLS: Record<PushTargetType, string> = {
  staff: "/app/calendar",
  admin: "/app/orders",
  agent: "/app/orders",
};

export function resolvePushUrlForTarget(targetType: PushTargetType | null | undefined): string {
  if (!targetType) return PUSH_FALLBACK_URL;
  return PUSH_TARGET_URLS[targetType] ?? PUSH_FALLBACK_URL;
}

/** 對應 push-sw.js 的 handlePushEvent 內解析邏輯:給定推播事件收到的原始 JSON 內容
 * (`event.data.json()` 的結果),組出 showNotification 要用的 {title, body, url}。
 * 解析失敗或欄位型別不對時一律 fallback 成預設值,不拋錯(規則 4.3「安靜」精神延伸到這裡)。 */
export function parsePushPayload(raw: unknown): PushNotificationPayload {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYLOAD };
  const record = raw as Record<string, unknown>;
  const title = record["title"];
  const body = record["body"];
  const url = record["url"];
  const kind = record["kind"];
  const ackUrl = record["ack_url"];
  return {
    title: typeof title === "string" && title ? title : DEFAULT_PAYLOAD.title,
    body: typeof body === "string" ? body : DEFAULT_PAYLOAD.body,
    url: typeof url === "string" && url ? url : DEFAULT_PAYLOAD.url,
    kind: kind === "test" ? "test" : null,
    ackUrl: typeof ackUrl === "string" && ackUrl ? ackUrl : null,
  };
}

/** 對應 push-sw.js 的 handleNotificationClick:從 `event.notification.data` 取出要導向的網址,
 * 查無資料時 fallback 到 /app(§4.7 第 4 點)。 */
export function resolveNotificationClickUrl(notificationData: unknown): string {
  if (notificationData && typeof notificationData === "object") {
    const url = (notificationData as Record<string, unknown>)["url"];
    if (typeof url === "string" && url) return url;
  }
  return PUSH_FALLBACK_URL;
}

/** §6.3 備援路徑:點了測試通知時,把 ack token 接在目的地網址後面帶回頁面。 */
export function appendPushTestAckParam(url: string, ackUrl: string | null | undefined): string {
  if (!ackUrl) return url;
  let token: string | null = null;
  try {
    token = new URL(ackUrl).searchParams.get("token");
  } catch {
    token = null;
  }
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}push_test_ack=${token}`;
}

/** §6.3 第 2 點:service worker 收到推播之後要不要回報送達。 */
export function shouldAcknowledgePush(payload: PushNotificationPayload): boolean {
  return payload.kind === "test" && Boolean(payload.ackUrl);
}

/** 組出 `registration.showNotification(title, options)` 的第二個參數,供測試驗證欄位是否正確。 */
export function buildShowNotificationOptions(payload: PushNotificationPayload): {
  body: string;
  icon: string;
  data: { url: string; kind: "test" | null; ackUrl: string | null };
} {
  return {
    body: payload.body,
    icon: "/icons/icon-192.png",
    data: { url: payload.url, kind: payload.kind, ackUrl: payload.ackUrl },
  };
}
