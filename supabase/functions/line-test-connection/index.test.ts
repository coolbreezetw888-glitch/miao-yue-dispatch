// 模組 11:LINE 通知 — line-test-connection 的 Deno 測試(對應第七節「Deno」欄位)。
// 只測 callLineBotInfo/buildTestResultUpdate 這兩支跟 I/O 分離的純函式,用假的 fetch 模擬
// LINE API 成功/401/逾時三種情境(對應規格書 3.13「mock fetch 回傳成功/401/逾時三種情境」)。
// 不呼叫真正的 Deno.serve handler(那需要真實的 Supabase 環境變數/資料庫連線,屬於整合測試
// 範疇,這次沒有可用的測試環境可以打——見規格書第〇節,這裡只驗證「我方程式碼邏輯正確」)。

import { assertEquals } from "jsr:@std/assert@1";
import { buildTestResultUpdate, callLineBotInfo } from "./index.ts";

const FIXED_NOW = "2026-09-20T12:00:00.000Z";

Deno.test("callLineBotInfo: 成功時回傳 ok=true 且帶出 body", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ userId: "Uabc123", basicId: "@testbot", displayName: "測試官方帳號" }),
        { status: 200 },
      ),
    )) as unknown as typeof fetch;

  const result = await callLineBotInfo(fakeFetch, "valid-token");
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.body?.userId, "Uabc123");
  assertEquals(result.body?.basicId, "@testbot");
  assertEquals(result.body?.displayName, "測試官方帳號");
  assertEquals(result.networkErrorMessage, null);
});

Deno.test("callLineBotInfo: 401 時回傳 ok=false 且 status=401", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "Authentication failed" }), { status: 401 }),
    )) as unknown as typeof fetch;

  const result = await callLineBotInfo(fakeFetch, "invalid-token");
  assertEquals(result.ok, false);
  assertEquals(result.status, 401);
  assertEquals(result.body, null);
});

Deno.test("callLineBotInfo: 網路逾時/連線失敗時回傳 status=0 且帶出錯誤訊息", async () => {
  const fakeFetch = (() => Promise.reject(new Error("network timeout"))) as unknown as typeof fetch;

  const result = await callLineBotInfo(fakeFetch, "any-token");
  assertEquals(result.ok, false);
  assertEquals(result.status, 0);
  assertEquals(result.networkErrorMessage, "network timeout");
});

Deno.test("buildTestResultUpdate: 成功情境正確組裝寫入內容與回應", () => {
  const { update, response } = buildTestResultUpdate(
    {
      ok: true,
      status: 200,
      body: { userId: "Uabc123", basicId: "@testbot", displayName: "測試官方帳號" },
      networkErrorMessage: null,
    },
    FIXED_NOW,
  );

  assertEquals(update.is_connected, true);
  assertEquals(update.line_bot_user_id, "Uabc123");
  assertEquals(update.line_bot_basic_id, "@testbot");
  assertEquals(update.display_name, "測試官方帳號");
  assertEquals(update.last_tested_at, FIXED_NOW);
  assertEquals(update.last_test_result, "連線成功");
  assertEquals(response.success, true);
});

Deno.test("buildTestResultUpdate: 401 情境正確組裝白話錯誤訊息且 is_connected=false", () => {
  const { update, response } = buildTestResultUpdate(
    { ok: false, status: 401, body: null, networkErrorMessage: null },
    FIXED_NOW,
  );

  assertEquals(update.is_connected, false);
  assertEquals(update.line_bot_user_id, null);
  assertEquals(update.last_test_result, "Channel Access Token 無效或已過期,請確認是否正確複製");
  assertEquals(response.success, false);
});

Deno.test("buildTestResultUpdate: 逾時情境正確組裝白話錯誤訊息", () => {
  const { update, response } = buildTestResultUpdate(
    { ok: false, status: 0, body: null, networkErrorMessage: "network timeout" },
    FIXED_NOW,
  );

  assertEquals(update.is_connected, false);
  assertEquals(update.last_test_result.includes("無法連線到 LINE 伺服器"), true);
  assertEquals(update.last_test_result.includes("network timeout"), true);
  assertEquals(response.success, false);
});

Deno.test("buildTestResultUpdate: 其他非 200 狀態碼正確組裝白話錯誤訊息", () => {
  const { update } = buildTestResultUpdate(
    { ok: false, status: 500, body: null, networkErrorMessage: null },
    FIXED_NOW,
  );

  assertEquals(update.last_test_result.includes("500"), true);
});
