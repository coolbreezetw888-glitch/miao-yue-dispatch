// 模組 15 擴充(手機推播擴及三種角色)— push-test-ack 的 Deno 測試。
// 對應規格書 §6.3(送達回報)、§6.4(公開端點與 token 規則,核心必測)。
//
// 🔴 這支端點是整批唯一 `verify_jwt=false` 的公開端點,權限完全靠「不可猜測的一次性 token」。
//    §6.4 第 4 點的鐵律是:**不論 token 有效、無效、過期、已用過,回應完全一樣**(204 + 空 body)
//    —— 任何差異化的回應都是一個可以拿來窮舉 token 的訊號。這支測試檔就是釘住這件事的。
//
// ⚠️ 分工說明(免得有人以為這裡沒測到「acked_at 有沒有真的被寫入」):
//    「一次性 / 10 分鐘過期 / 只更新那一台裝置的 last_seen_at」是**資料庫函式**
//    public.ack_push_test_notification 的語意,測試在
//    supabase/tests/database/module15_02_push_multi_role.sql 的 ⑩ 區塊(pgTAP)。
//    這個檔案負責的是 **Edge Function 這一層**:有沒有正確把 token 取出來、有沒有呼叫那支函式、
//    以及「回應永遠一模一樣」這條紅線。
//
// ⚠️ 怎麼跑(這台開發機沒有安裝 deno,不要以為這些測試沒辦法執行):
//        npm run test:edge
//        node scripts/run-edge-function-tests.mjs supabase/functions/push-test-ack/index.test.ts
//    完整說明見 scripts/run-edge-function-tests.mjs 的檔頭。

import { assertEquals } from "jsr:@std/assert@1";

import { extractAckToken, handleRequest, type HandleRequestDeps } from "./index.ts";

const VALID_TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ANOTHER_TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const ACK_URL = "https://example.supabase.co/functions/v1/push-test-ack";

function setEnv(): void {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
}

interface Recorded {
  rpcCalls: [string, Record<string, unknown>][];
}

function makeDeps(rpcResult: { data: unknown; error: unknown } = { data: true, error: null }): {
  deps: HandleRequestDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = { rpcCalls: [] };
  const adminClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      recorded.rpcCalls.push([fn, args]);
      return Promise.resolve(rpcResult);
    },
  };
  return {
    deps: { createAdminClient: () => adminClient } as unknown as HandleRequestDeps,
    recorded,
  };
}

function ackRequest(query: string, body: unknown = {}): Request {
  return new Request(`${ACK_URL}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** §6.4 第 4 點:每一條路徑都要通過這個「回應一模一樣」的檢查。 */
async function assertIdenticalEmptyResponse(res: Response): Promise<void> {
  assertEquals(res.status, 204);
  assertEquals(await res.text(), "");
  assertEquals(res.headers.get("Content-Type"), null);
}

// =========================================================================
// extractAckToken 純函式
// =========================================================================
Deno.test("extractAckToken:從 querystring 取得 token", () => {
  assertEquals(extractAckToken(`${ACK_URL}?token=${VALID_TOKEN}`, null), VALID_TOKEN);
  assertEquals(extractAckToken(`${ACK_URL}?a=1&token=${VALID_TOKEN}&b=2`, null), VALID_TOKEN);
});

Deno.test("extractAckToken:querystring 沒有時改從 JSON body 取", () => {
  assertEquals(extractAckToken(ACK_URL, { token: VALID_TOKEN }), VALID_TOKEN);
});

Deno.test("extractAckToken:兩邊都沒有、或是空白值時回 null", () => {
  assertEquals(extractAckToken(ACK_URL, null), null);
  assertEquals(extractAckToken(`${ACK_URL}?token=`, null), null);
  assertEquals(extractAckToken(`${ACK_URL}?token=%20%20`, null), null);
  assertEquals(extractAckToken(ACK_URL, { token: "" }), null);
  assertEquals(extractAckToken(ACK_URL, { token: 123 }), null);
  assertEquals(extractAckToken("not a url", null), null);
});

// =========================================================================
// §6.4 核心必測:回應永遠一模一樣
// =========================================================================
Deno.test("push-test-ack(核心必測):有效 token → 204、body 為空、而且真的呼叫了資料庫函式", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ data: true, error: null });
  const res = await handleRequest(ackRequest(`?token=${VALID_TOKEN}`), deps);
  await assertIdenticalEmptyResponse(res);
  assertEquals(recorded.rpcCalls, [["ack_push_test_notification", { p_ack_token: VALID_TOKEN }]]);
});

Deno.test(
  "push-test-ack(🔴 核心必測 §6.4 第 2 點):同一個 token 第二次(函式回 false)→ 回應跟第一次完全一樣",
  async () => {
    setEnv();
    const first = await handleRequest(
      ackRequest(`?token=${VALID_TOKEN}`),
      makeDeps({ data: true, error: null }).deps,
    );
    const second = await handleRequest(
      ackRequest(`?token=${VALID_TOKEN}`),
      makeDeps({ data: false, error: null }).deps,
    );
    await assertIdenticalEmptyResponse(first);
    await assertIdenticalEmptyResponse(second);
    assertEquals(first.status, second.status);
  },
);

Deno.test("push-test-ack(核心必測):過期的 token(函式回 false)→ 一樣 204 + 空 body", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ data: false, error: null });
  const res = await handleRequest(ackRequest(`?token=${ANOTHER_TOKEN}`), deps);
  await assertIdenticalEmptyResponse(res);
  // 仍然有呼叫函式 —— 「有效/過期」的差別只存在於伺服器端,呼叫端看不出來。
  assertEquals(recorded.rpcCalls.length, 1);
});

Deno.test("push-test-ack(核心必測):資料庫整個出錯時也不透露任何東西,一樣 204 + 空 body", async () => {
  setEnv();
  const { deps } = makeDeps({ data: null, error: { message: "boom" } });
  await assertIdenticalEmptyResponse(await handleRequest(ackRequest(`?token=${VALID_TOKEN}`), deps));
});

Deno.test(
  "push-test-ack(核心必測):格式不對的 token → 204,而且**完全不去撞資料庫**(公開端點的節流)",
  async () => {
    setEnv();
    const { deps, recorded } = makeDeps();
    await assertIdenticalEmptyResponse(await handleRequest(ackRequest("?token=not-a-uuid"), deps));
    await assertIdenticalEmptyResponse(
      await handleRequest(ackRequest("?token=00000000-0000-0000-0000"), deps),
    );
    assertEquals(recorded.rpcCalls, []);
  },
);

Deno.test("push-test-ack(核心必測):完全不帶 token → 204 + 空 body,不呼叫資料庫", async () => {
  setEnv();
  const { deps, recorded } = makeDeps();
  await assertIdenticalEmptyResponse(await handleRequest(ackRequest(""), deps));
  assertEquals(recorded.rpcCalls, []);
});

Deno.test("push-test-ack:body 不是合法 JSON 時不會炸掉,照樣 204", async () => {
  setEnv();
  const { deps } = makeDeps();
  const req = new Request(`${ACK_URL}?token=${VALID_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ 這不是 JSON",
  });
  await assertIdenticalEmptyResponse(await handleRequest(req, deps));
});

Deno.test("push-test-ack:GET 之類的其他方法也回 204(不透露這個端點只吃 POST)", async () => {
  setEnv();
  const { deps, recorded } = makeDeps();
  const res = await handleRequest(new Request(`${ACK_URL}?token=${VALID_TOKEN}`), deps);
  await assertIdenticalEmptyResponse(res);
  assertEquals(recorded.rpcCalls, []);
});

Deno.test("push-test-ack:OPTIONS 回 CORS preflight(service worker 的 fetch 需要)", async () => {
  setEnv();
  const { deps } = makeDeps();
  const res = await handleRequest(new Request(ACK_URL, { method: "OPTIONS" }), deps);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("push-test-ack:缺少環境變數時也回 204(不透露伺服器設定狀態)", async () => {
  Deno.env.set("SUPABASE_URL", "");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "");
  const { deps, recorded } = makeDeps();
  await assertIdenticalEmptyResponse(await handleRequest(ackRequest(`?token=${VALID_TOKEN}`), deps));
  assertEquals(recorded.rpcCalls, []);
  setEnv();
});

Deno.test("push-test-ack:token 也可以從 body 帶(service worker 若改用 body 送不會壞)", async () => {
  setEnv();
  const { deps, recorded } = makeDeps();
  await assertIdenticalEmptyResponse(await handleRequest(ackRequest("", { token: VALID_TOKEN }), deps));
  assertEquals(recorded.rpcCalls, [["ack_push_test_notification", { p_ack_token: VALID_TOKEN }]]);
});
