// 本機 e2e 的「瀏覽器沒有打到雲端」斷言,所有 e2e-local spec 共用。
// (第一道防線是 playwright.local.config.ts 的 Chromium DNS 規則:雲端網域根本解析不到;
//   這裡是第二道:逐條測試記錄請求主機,結束時斷言 supabase.co = 0,並要求確實打到本機,避免「0 筆」是假的。)
//
// SPECS-INDEX #874(規格風險 4):即時同步之後瀏覽器會開 Realtime 的 WebSocket。WebSocket 的握手**不一定**
// 會出現在 page.on("request") 裡,所以這裡另外用 page.on("websocket") 記錄每一條 WebSocket 的網址,
// 結束時斷言「沒有任何一條連到 127.0.0.1 / localhost 以外」(判斷規則見 local-target.ts 的
// nonLoopbackWebSocketUrls,有單元測試)。既有 spec 不用改任何一行就自動多了這道檢查。
import { expect, type Page } from "@playwright/test";

import { nonLoopbackWebSocketUrls } from "./local-target";

export interface RequestRecorder {
  hosts: string[];
  /** 這一頁開過的所有 WebSocket 網址(含 Vite HMR 與 Supabase Realtime)。 */
  webSocketUrls: string[];
}

export function recordRequestHosts(page: Page): RequestRecorder {
  const recorder: RequestRecorder = { hosts: [], webSocketUrls: [] };
  page.on("request", (req) => {
    try {
      recorder.hosts.push(new URL(req.url()).host);
    } catch {
      recorder.hosts.push(req.url());
    }
  });
  page.on("websocket", (ws) => {
    recorder.webSocketUrls.push(ws.url());
  });
  return recorder;
}

export function expectOnlyLocalRequests(recorder: RequestRecorder): void {
  const cloud = recorder.hosts.filter((h) => /supabase\.co/i.test(h));
  expect(cloud, "本機模式不可以有任何請求打到 supabase.co").toEqual([]);
  expect(
    recorder.hosts.some((h) => h.startsWith("127.0.0.1:")),
    "正向對照:這條測試確實有打到本機 Supabase",
  ).toBe(true);
  expect(
    nonLoopbackWebSocketUrls(recorder.webSocketUrls),
    "本機模式不可以有任何 WebSocket 連到 127.0.0.1 / localhost 以外",
  ).toEqual([]);
}
