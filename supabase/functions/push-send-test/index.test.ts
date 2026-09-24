// 模組 15 擴充(手機推播擴及三種角色)— push-send-test 的 Deno 測試。
// 對應規格書 §6.1(測試推播)、§6.2(權限靠 RLS 不靠前端誠實,核心必測)、§6.6(頻率限制)。
//
// 🔴 這支測試檔守的是這一批最敏感的一段邏輯:**「要發給誰」永遠不能由前端說了算。**
//    handleRequest 刻意做成可注入的形狀(HandleRequestDeps),所以這裡完全不需要真的 Supabase
//    連線、也不會真的打 FCM。
//
// ⚠️ 怎麼跑(這台開發機沒有安裝 deno,不要以為這些測試沒辦法執行):
//        npm run test:edge
//        node scripts/run-edge-function-tests.mjs supabase/functions/push-send-test/index.test.ts
//    那支腳本用 esbuild 把這個檔案打包成 Node 可執行的 ESM,並補上 Deno.test / Deno.env /
//    jsr:@std/assert 的最小替身。完整說明見 scripts/run-edge-function-tests.mjs 的檔頭。
//    如果環境裡有真正的 deno,`deno test --allow-env supabase/functions/` 也跑得起來。

import { assertEquals } from "jsr:@std/assert@1";

import {
  handleRequest,
  TEST_PUSH_BODY,
  TEST_PUSH_RATE_LIMIT,
  TEST_PUSH_TITLE,
  type HandleRequestDeps,
} from "./index.ts";

// =========================================================================
// 測試替身
// =========================================================================
function setEnv(): void {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  Deno.env.set("VAPID_SUBJECT", "mailto:test@example.test");
  Deno.env.set("VAPID_PUBLIC_KEY", "vapid-public");
  Deno.env.set("VAPID_PRIVATE_KEY", "vapid-private");
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

interface Recorded {
  /** 呼叫者 client 上發生的每一次 rpc:[函式名, 參數]。 */
  rpcCalls: [string, Record<string, unknown>][];
  /** 呼叫者 client 對 push_subscriptions 下的篩選條件(用來證明沒有用 user_id 篩)。 */
  callerFilters: [string, unknown][];
  /** 呼叫者 client 查過哪些表(用來證明裝置清單不是用 service role 查的)。 */
  callerTables: string[];
  /** service role client 查過哪些表。 */
  adminTables: string[];
  logRows: Record<string, unknown>[];
  deletedSubscriptionIds: string[];
  sentPayloads: { endpoint: string; payload: Record<string, unknown> }[];
}

interface FakeOptions {
  identity?: { target_type: string; target_id: string; display_name: string } | null;
  identityError?: unknown;
  recentTestCount?: number;
  subscriptions?: SubscriptionRow[];
  sendResults?: { ok: boolean; status: number; errorDetail: string | null }[];
}

function makeDeps(options: FakeOptions = {}): { deps: HandleRequestDeps; recorded: Recorded } {
  const recorded: Recorded = {
    rpcCalls: [],
    callerFilters: [],
    callerTables: [],
    adminTables: [],
    logRows: [],
    deletedSubscriptionIds: [],
    sentPayloads: [],
  };

  const identity =
    options.identity === undefined
      ? { target_type: "staff", target_id: "staff-1", display_name: "服務人員甲" }
      : options.identity;
  const subscriptions = options.subscriptions ?? [
    { id: "sub-1", endpoint: "https://fcm.example/1", p256dh_key: "p1", auth_key: "a1" },
  ];
  const sendResults = options.sendResults ?? [];
  let sendCall = 0;

  // 呼叫者自己的 JWT client:查裝置一定要走這一條(§6.2 第 1 點)。
  function buildCallerQuery(rows: SubscriptionRow[]) {
    const query = {
      eq(column: string, value: unknown) {
        recorded.callerFilters.push([column, value]);
        return buildCallerQuery(rows.filter((r) => (r as never as Record<string, unknown>)[column] === value));
      },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        resolve({ data: rows, error: null });
      },
    };
    return query;
  }

  const callerClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      recorded.rpcCalls.push([fn, args]);
      if (fn === "get_my_push_identity") {
        if (options.identityError) return Promise.resolve({ data: null, error: options.identityError });
        return Promise.resolve({ data: identity, error: null });
      }
      if (fn === "count_my_recent_test_pushes") {
        return Promise.resolve({ data: options.recentTestCount ?? 0, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `未預期的 rpc: ${fn}` } });
    },
    from(table: string) {
      recorded.callerTables.push(table);
      return { select: (_columns: string) => buildCallerQuery(subscriptions) };
    },
  };

  // service role client:§6.2 第 2 點,只用來寫 log / 刪除失效裝置,**絕不用來查要發給誰**。
  const adminClient = {
    from(table: string) {
      recorded.adminTables.push(table);
      return {
        insert(row: Record<string, unknown>) {
          recorded.logRows.push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq(_column: string, value: unknown) {
              recorded.deletedSubscriptionIds.push(value as string);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  let tokenSeq = 0;

  const deps = {
    createCallerClient: () => callerClient,
    createAdminClient: () => adminClient,
    sendPush: (
      _vapid: unknown,
      subscription: { endpoint: string },
      payload: Record<string, unknown>,
    ) => {
      recorded.sentPayloads.push({ endpoint: subscription.endpoint, payload });
      const result = sendResults[sendCall] ?? { ok: true, status: 201, errorDetail: null };
      sendCall += 1;
      return Promise.resolve(result);
    },
    newAckToken: () => {
      tokenSeq += 1;
      return `ack-token-${tokenSeq}`;
    },
  } as unknown as HandleRequestDeps;

  return { deps, recorded };
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.supabase.co/functions/v1/push-send-test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-jwt", ...headers },
    body: JSON.stringify(body),
  });
}

// =========================================================================
// §6.1 / §6.2 的核心必測情境
// =========================================================================
Deno.test("push-send-test(核心必測):缺少 Authorization 標頭 → 401", async () => {
  setEnv();
  const { deps, recorded } = makeDeps();
  const req = new Request("https://example.supabase.co/functions/v1/push-send-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchant_id: "m1" }),
  });
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 401);
  // 連身分解析都不該發生。
  assertEquals(recorded.rpcCalls.length, 0);
});

Deno.test("push-send-test(核心必測):不屬於這間商家 → 403", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ identityError: { code: "42501", message: "不是成員" } });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(res.status, 403);
  // 被擋在身分那一關,不該查任何裝置、不該送出任何東西。
  assertEquals(recorded.callerTables.length, 0);
  assertEquals(recorded.sentPayloads.length, 0);
});

Deno.test("push-send-test:這個人還沒開通任何裝置 → 200 + no_subscription(不是錯誤)", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ subscriptions: [] });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { sent: 0, failed: 0, reason: "no_subscription", ack_tokens: [] });
  assertEquals(recorded.sentPayloads.length, 0);
  assertEquals(recorded.logRows.length, 0);
});

Deno.test(
  "push-send-test(🔴 核心必測 §6.2):body 裡塞了別人的 user_id / target_id / target_type 時完全被忽略",
  async () => {
    setEnv();
    const { deps, recorded } = makeDeps();
    const res = await handleRequest(
      postRequest({
        merchant_id: "m1",
        // 以下四個欄位是攻擊者想指定「發給誰」的嘗試,函式一個都不該採用。
        user_id: "someone-else-user-id",
        target_id: "someone-else-target-id",
        target_type: "admin",
        staff_id: "someone-else-staff-id",
      }),
      deps,
    );
    assertEquals(res.status, 200);

    // ① 兩支 rpc 都只帶 p_merchant_id,沒有任何身分參數。
    for (const [fn, args] of recorded.rpcCalls) {
      assertEquals(Object.keys(args), ["p_merchant_id"], `${fn} 不該收到身分參數`);
      assertEquals(args["p_merchant_id"], "m1");
    }

    // ② 裝置清單是用「呼叫者自己的 JWT client」查的(RLS 就是權限檢查本身),
    //    而且完全沒有用 user_id 之類的欄位去篩 —— 篩選是 RLS 做的,不是我們做的。
    assertEquals(recorded.callerTables, ["push_subscriptions"]);
    assertEquals(recorded.callerFilters, []);

    // ③ service role client 只碰 push_notification_log(寫 log),**沒有**用它查 push_subscriptions。
    assertEquals(recorded.adminTables, ["push_notification_log"]);

    // ④ 寫進 log 的收件人來自 get_my_push_identity,不是 body。
    assertEquals(recorded.logRows[0]["target_type"], "staff");
    assertEquals(recorded.logRows[0]["target_id"], "staff-1");
  },
);

Deno.test("push-send-test:帶 endpoint 時只對那一台裝置發(§7.5 第 1 點)", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({
    subscriptions: [
      { id: "sub-1", endpoint: "https://fcm.example/1", p256dh_key: "p", auth_key: "a" },
      { id: "sub-2", endpoint: "https://fcm.example/2", p256dh_key: "p", auth_key: "a" },
    ],
  });
  await handleRequest(
    postRequest({ merchant_id: "m1", endpoint: "https://fcm.example/2" }),
    deps,
  );
  assertEquals(recorded.callerFilters, [["endpoint", "https://fcm.example/2"]]);
  assertEquals(recorded.sentPayloads.length, 1);
  assertEquals(recorded.sentPayloads[0].endpoint, "https://fcm.example/2");
});

Deno.test("push-send-test(§6.3):payload 帶 kind='test' 與完整絕對網址的 ack_url", async () => {
  setEnv();
  const { deps, recorded } = makeDeps();
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  const body = (await res.json()) as { sent: number; ack_tokens: string[] };

  assertEquals(body.sent, 1);
  assertEquals(body.ack_tokens, ["ack-token-1"]);

  const payload = recorded.sentPayloads[0].payload;
  assertEquals(payload["kind"], "test");
  assertEquals(
    payload["ack_url"],
    "https://example.supabase.co/functions/v1/push-test-ack?token=ack-token-1",
  );
  // §4.7 第 4 點:測試推播導到一定存在的 /app,不是任何具體功能頁。
  assertEquals(payload["url"], "/app");
  // §6.5:測試通知本身的文字也不能承諾「已生效」。
  assertEquals(payload["title"], TEST_PUSH_TITLE);
  assertEquals(payload["body"], TEST_PUSH_BODY);

  // §6.4 第 3 點:log 要記下這一列是發給哪一台裝置,ack 進來才能精準更新 last_seen_at。
  assertEquals(recorded.logRows[0]["ack_token"], "ack-token-1");
  assertEquals(recorded.logRows[0]["ack_subscription_id"], "sub-1");
  assertEquals(recorded.logRows[0]["event_type"], "test");
  assertEquals(recorded.logRows[0]["status"], "sent");
});

Deno.test("push-send-test(核心必測,規則 4.6):404 回應時刪除那一台失效裝置", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({
    sendResults: [{ ok: false, status: 404, errorDetail: "gone" }],
  });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(await res.json(), { sent: 0, failed: 1, ack_tokens: ["ack-token-1"] });
  assertEquals(recorded.deletedSubscriptionIds, ["sub-1"]);
  assertEquals(recorded.logRows[0]["status"], "failed");
});

Deno.test("push-send-test(規則 4.6):500 這種暫時性錯誤不刪除裝置", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({
    sendResults: [{ ok: false, status: 500, errorDetail: "server error" }],
  });
  await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(recorded.deletedSubscriptionIds, []);
  assertEquals(recorded.logRows[0]["error_detail"], "server error");
});

Deno.test("push-send-test(核心必測 §6.6):60 秒內已經發過 3 次 → 429,而且不會再送出任何通知", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ recentTestCount: TEST_PUSH_RATE_LIMIT });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(res.status, 429);
  assertEquals(recorded.sentPayloads.length, 0);
  assertEquals(recorded.logRows.length, 0);
});

Deno.test("push-send-test(§6.6):只發過 2 次時還可以再發一次", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({ recentTestCount: TEST_PUSH_RATE_LIMIT - 1 });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(recorded.sentPayloads.length, 1);
});

Deno.test("push-send-test:缺 merchant_id → 400", async () => {
  setEnv();
  const { deps } = makeDeps();
  const res = await handleRequest(postRequest({}), deps);
  assertEquals(res.status, 400);
});

Deno.test("push-send-test:非 POST → 405;OPTIONS → CORS preflight", async () => {
  setEnv();
  const { deps } = makeDeps();
  const getRes = await handleRequest(
    new Request("https://example.supabase.co/functions/v1/push-send-test", { method: "GET" }),
    deps,
  );
  assertEquals(getRes.status, 405);

  const optionsRes = await handleRequest(
    new Request("https://example.supabase.co/functions/v1/push-send-test", { method: "OPTIONS" }),
    deps,
  );
  assertEquals(optionsRes.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("push-send-test:缺 VAPID 環境變數 → 500(不會裸奔送出)", async () => {
  setEnv();
  Deno.env.set("VAPID_PRIVATE_KEY", "");
  const { deps, recorded } = makeDeps();
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  assertEquals(res.status, 500);
  assertEquals(recorded.sentPayloads.length, 0);
  setEnv();
});

Deno.test("push-send-test:多台裝置各自一個 ack_token、各自一列 log", async () => {
  setEnv();
  const { deps, recorded } = makeDeps({
    subscriptions: [
      { id: "sub-1", endpoint: "https://fcm.example/1", p256dh_key: "p", auth_key: "a" },
      { id: "sub-2", endpoint: "https://fcm.example/2", p256dh_key: "p", auth_key: "a" },
    ],
  });
  const res = await handleRequest(postRequest({ merchant_id: "m1" }), deps);
  const body = (await res.json()) as { sent: number; ack_tokens: string[] };
  assertEquals(body.sent, 2);
  assertEquals(body.ack_tokens, ["ack-token-1", "ack-token-2"]);
  assertEquals(recorded.logRows.length, 2);
  assertEquals(recorded.logRows[0]["ack_subscription_id"], "sub-1");
  assertEquals(recorded.logRows[1]["ack_subscription_id"], "sub-2");
});
