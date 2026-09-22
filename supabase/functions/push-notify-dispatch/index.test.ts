// 模組 15(服務人員推播通知)— push-notify-dispatch 的 Deno 測試。對應規則 4.7(核心必測:
// 未授權呼叫被擋下)。用可注入的 deps(createCallerClient/createAdminClient)驗證 401/403 分支,
// 不需要真正的 Supabase 環境變數/資料庫連線。
//
// 這幾個環境變數必須在 import "./index.ts" 之前就存在(index.ts 頂層直接讀取),測試檔案開頭
// 先設好假值,確保「缺少環境變數」的 500 分支不會誤擋下面的測試案例。

Deno.env.set("SUPABASE_URL", "http://localhost:55321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("VAPID_SUBJECT", "mailto:test@example.com");
Deno.env.set("VAPID_PUBLIC_KEY", "test-public-key");
Deno.env.set("VAPID_PRIVATE_KEY", "test-private-key");

import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest, type CallerRpcClient, type HandleRequestDeps } from "./index.ts";

function makeDeps(allowed: boolean | null, rpcError: unknown = null): HandleRequestDeps {
  const callerClient: CallerRpcClient = {
    rpc: async () => ({ data: allowed, error: rpcError }),
  };
  return {
    createCallerClient: () => callerClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAdminClient: () => ({}) as any,
  };
}

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/push-notify-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("handleRequest(核心必測,規則 4.7):缺少 Authorization 標頭回 401", async () => {
  const req = makeRequest({ merchant_id: "m1", booking_id: "b1", event_type: "booking_created" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 401);
});

Deno.test("handleRequest(核心必測,規則 4.7):can_manage_bookings 回傳 false 時回 403,未授權呼叫被擋下", async () => {
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, makeDeps(false));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(typeof body.error, "string");
});

Deno.test("handleRequest:can_manage_bookings RPC 本身出錯時回 500,不當作授權通過", async () => {
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, makeDeps(null, { message: "boom" }));
  assertEquals(res.status, 500);
});

Deno.test("handleRequest:缺少必要欄位回 400", async () => {
  const req = makeRequest({ merchant_id: "m1" }, { Authorization: "Bearer fake-jwt" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test("handleRequest:不支援的 event_type 回 400", async () => {
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_completed" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test("handleRequest:非 POST 方法回 405", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", { method: "GET" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 405);
});

Deno.test("handleRequest:OPTIONS 預檢請求回 200 且不驗證授權", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", { method: "OPTIONS" });
  const res = await handleRequest(req, makeDeps(false));
  assertEquals(res.status, 200);
});

Deno.test("handleRequest:請求本文不是合法 JSON 時回 400", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", {
    method: "POST",
    headers: { Authorization: "Bearer fake-jwt", "Content-Type": "application/json" },
    body: "not-json",
  });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test("handleRequest:授权通过后正常呼叫 dispatchPushForBooking(用假 adminClient 讓下游 DB 呼叫全部靜默失敗,仍應回 200)", async () => {
  // 這裡刻意讓 adminClient 是空物件(呼叫 .from()/.rpc() 會丟例外),驗證即使下游 DB 操作失敗,
  // dispatchPushForBooking 內部的 buildPushDispatchDeps 各個方法都有 try 過的 error 處理
  // (見 pushDbAdapter.ts 每個方法遇到 error 都印 log 後回傳安全預設值,不會讓整個請求掛掉)。
  // 這個測試主要驗證 handleRequest 授權通過分支本身不會在呼叫 dispatchPushForBooking 前就中斷。
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
    { Authorization: "Bearer fake-jwt" },
  );
  const deps = makeDeps(true);
  // adminClient.from(...).select(...).eq(...).eq(...).maybeSingle() 需要至少能被呼叫,這裡改用
  // 一個會讓 getEventSetting 收到 rejected promise 的假 client,驗證整個流程仍然「安靜」處理掉。
  deps.createAdminClient = () =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "db down" } }) }),
            maybeSingle: () => Promise.resolve({ data: null, error: { message: "db down" } }),
          }),
        }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: () => Promise.resolve({ error: null }),
      }),
      rpc: () => Promise.resolve({ data: {}, error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 200);
});
