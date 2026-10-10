// 模組 11:LINE 通知 — line-webhook 的 Deno 測試(對應第七節「Deno」欄位,規則 2.2/2.3 核心必測)。
//
// 規則 2.2 已知答案測試向量:LINE 官方沒有公開測試向量,這裡改用密碼學演算法本身的正確性驗證
// (webhook-payment-integration SKILL 規則 2 的精神)——用 Node.js 的 crypto 模組(跟這支
// Edge Function 實際使用的 Deno WebCrypto API 是完全不同的兩套實作)獨立算出：
//   密鑰 = "my-test-channel-secret"
//   內容 = '{"destination":"Uabc123","events":[]}'
//   HMAC-SHA256 base64 = "JAbE46YdBtXxshUa8DAcpR8oLbAyaM6FSv1qDuhWlw0="
// 這裡驗證的是「HMAC-SHA256 這個演算法本身在我方程式碼裡有沒有算對」,不是「跟 LINE 真實環境
// 行為完全一致」(那個殘餘風險見規格書第〇節,只能等有真實 LINE 帳號送來的請求才能確認)。
//
// 只測試跟 I/O 分離的純函式(computeLineSignature/constantTimeEquals/verifyLineSignature/
// isSixDigitBindingCode),不呼叫真正的 Deno.serve handler(那需要真實的 Supabase 環境變數/
// 資料庫連線,這次沒有可用的測試環境可以打,見規格書第〇節)。冪等處理(規則 2.3)的「同一個
// webhookEventId 送兩次只處理一次」邏輯,用一個獨立的假資料庫（in-memory Map）模擬
// line_webhook_events 表的行為驗證。

import { assertEquals } from "jsr:@std/assert@1";
import {
  computeLineSignature,
  constantTimeEquals,
  isSixDigitBindingCode,
  verifyLineSignature,
} from "./index.ts";

const KNOWN_SECRET = "my-test-channel-secret";
const KNOWN_BODY = '{"destination":"Uabc123","events":[]}';
const KNOWN_ANSWER = "JAbE46YdBtXxshUa8DAcpR8oLbAyaM6FSv1qDuhWlw0=";

Deno.test(
  "computeLineSignature: 已知密鑰+已知內容算出跟獨立(Node.js crypto)計算完全一致的結果",
  async () => {
    const rawBody = new TextEncoder().encode(KNOWN_BODY);
    const signature = await computeLineSignature(rawBody, KNOWN_SECRET);
    assertEquals(signature, KNOWN_ANSWER);
  },
);

Deno.test("verifyLineSignature: 正確簽章通過驗證", async () => {
  const rawBody = new TextEncoder().encode(KNOWN_BODY);
  const ok = await verifyLineSignature(rawBody, KNOWN_ANSWER, KNOWN_SECRET);
  assertEquals(ok, true);
});

Deno.test("verifyLineSignature: 錯誤簽章被拒絕(核心必測,規則 2.2 第 5 點)", async () => {
  const rawBody = new TextEncoder().encode(KNOWN_BODY);
  const ok = await verifyLineSignature(rawBody, "this-is-a-forged-signature==", KNOWN_SECRET);
  assertEquals(ok, false);
});

Deno.test("verifyLineSignature: 缺少簽章標頭時視為驗證失敗", async () => {
  const rawBody = new TextEncoder().encode(KNOWN_BODY);
  const ok = await verifyLineSignature(rawBody, null, KNOWN_SECRET);
  assertEquals(ok, false);
});

Deno.test("verifyLineSignature: 密鑰不同(不同商家)算出的簽章不吻合,被擋下", async () => {
  const rawBody = new TextEncoder().encode(KNOWN_BODY);
  const ok = await verifyLineSignature(rawBody, KNOWN_ANSWER, "a-completely-different-secret");
  assertEquals(ok, false);
});

Deno.test("verifyLineSignature: 內容被竄改一個位元組,簽章就對不上", async () => {
  // 規則 2.2 第 1 點強調的陷阱:即使是「看起來一樣」的內容,只要原始位元組有差異,簽章就會不同——
  // 這裡故意把 destination 從 Uabc123 改成 Uabc124,模擬「先 parse 再重新字串化」可能造成的
  // 位元組差異(例如 key 順序改變、空白字元被吃掉)。
  const tamperedBody = new TextEncoder().encode('{"destination":"Uabc124","events":[]}');
  const ok = await verifyLineSignature(tamperedBody, KNOWN_ANSWER, KNOWN_SECRET);
  assertEquals(ok, false);
});

Deno.test("constantTimeEquals: 長度不同直接回傳 false", () => {
  assertEquals(constantTimeEquals("abc", "abcd"), false);
});

Deno.test("constantTimeEquals: 內容相同回傳 true", () => {
  assertEquals(constantTimeEquals("abc123==", "abc123=="), true);
});

Deno.test("isSixDigitBindingCode: 6 碼數字格式判定為 true", () => {
  assertEquals(isSixDigitBindingCode("123456"), true);
  assertEquals(isSixDigitBindingCode("000000"), true);
});

Deno.test("isSixDigitBindingCode: 非 6 碼數字格式判定為 false(判斷 7)", () => {
  assertEquals(isSixDigitBindingCode("12345"), false); // 5 碼
  assertEquals(isSixDigitBindingCode("1234567"), false); // 7 碼
  assertEquals(isSixDigitBindingCode("12345a"), false); // 含字母
  assertEquals(isSixDigitBindingCode("你好嗎呀呢喔"), false); // 貼圖/非數字文字
  assertEquals(isSixDigitBindingCode(""), false);
});

// =========================================================================
// 規則 2.3(核心必測):冪等處理——同一個 webhookEventId 送兩次只處理一次。
// 用一個簡化的假「line_webhook_events 表」(in-memory Set)模擬 index.ts 主流程裡
// 「查詢是否已存在 → 不存在才處理並寫入」這段邏輯的行為,驗證邏輯本身正確
// (不重新啟動整個 Deno.serve handler,那需要真實資料庫連線)。
// =========================================================================
function createFakeIdempotencyStore() {
  const processed = new Set<string>();
  let processCount = 0;
  return {
    /** 模擬 index.ts 主迴圈對每個 event 的處理邏輯:已存在就跳過,不存在才處理並記錄。 */
    handleEvent(webhookEventId: string): "processed" | "skipped" {
      if (processed.has(webhookEventId)) {
        return "skipped";
      }
      processed.add(webhookEventId);
      processCount += 1;
      return "processed";
    },
    get processCount() {
      return processCount;
    },
  };
}

Deno.test("冪等處理:同一個 webhookEventId 送兩次,只處理一次", () => {
  const store = createFakeIdempotencyStore();
  const result1 = store.handleEvent("01HXXXX-same-event-id");
  const result2 = store.handleEvent("01HXXXX-same-event-id");
  assertEquals(result1, "processed");
  assertEquals(result2, "skipped");
  assertEquals(store.processCount, 1);
});

Deno.test("冪等處理:不同的 webhookEventId 正常各自處理", () => {
  const store = createFakeIdempotencyStore();
  store.handleEvent("event-a");
  store.handleEvent("event-b");
  store.handleEvent("event-c");
  assertEquals(store.processCount, 3);
});

// =========================================================================
// 客戶端第 5-A 批 C5-F01:follow / unfollow ⇒ 好友狀態(handleRequest 可注入後的整段流程)
// =========================================================================
import { computeLineSignature as sign, friendshipChangeFromEvent, handleRequest } from "./index.ts";

const C5_SECRET = "c5-channel-secret";
const C5_USER = "U0123456789abcdef0123456789abcdef";

function c5FakeClient(
  lineNotificationsFeature: boolean | "error" = true,
  credentials: "ok" | "missing" | "error" = "ok",
) {
  const rec = {
    rpcs: [] as { fn: string; args: Record<string, unknown> }[],
    credentialCalls: [] as Record<string, unknown>[],
    configSelects: [] as string[],
    events: new Set<string>(),
    replies: 0,
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select(cols?: string) {
          if (table === "merchant_line_configs") rec.configSelects.push(String(cols));
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        maybeSingle() {
          if (table === "merchant_line_configs") {
            // #1053:表裡已經沒有金鑰欄位,只回 merchant_id。
            return Promise.resolve({
              data: filters.line_bot_user_id === "Ubot" ? { merchant_id: "m-1" } : null,
              error: null,
            });
          }
          if (table === "line_webhook_events") {
            return Promise.resolve({ data: rec.events.has(String(filters.webhook_event_id)) ? { webhook_event_id: "x" } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert(row: Record<string, unknown>) {
          if (table === "line_webhook_events") rec.events.add(String(row.webhook_event_id));
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      // #1053:金鑰從 Vault 取(另外記錄,不混進 rpcs 讓既有斷言維持原樣)。
      if (fn === "internal_get_line_messaging_credentials") {
        rec.credentialCalls.push(args);
        if (credentials === "error") return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
        return Promise.resolve({
          data: credentials === "ok" ? { channel_secret: C5_SECRET, channel_access_token: "TOKEN" } : null,
          error: null,
        });
      }
      rec.rpcs.push({ fn, args });
      if (fn === "internal_merchant_has_feature") {
        return Promise.resolve(lineNotificationsFeature === "error"
          ? { data: null, error: { code: "XX000" } }
          : { data: lineNotificationsFeature, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    },
  };
  return { client, rec };
}

async function c5Request(events: unknown[], signature?: string) {
  const body = JSON.stringify({ destination: "Ubot", events });
  const sig = signature ?? await sign(new TextEncoder().encode(body), C5_SECRET);
  return new Request("https://x.supabase.co/functions/v1/line-webhook", {
    method: "POST",
    headers: { "x-line-signature": sig },
    body,
  });
}

function c5Deps(client: unknown) {
  return {
    env: () => undefined,
    createAdminClient: () => client,
    fetchImpl: (() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch,
  };
}

Deno.test("C5-F01-1 follow ⇒ is_friend true;unfollow ⇒ false;用事件 timestamp;不回覆", async () => {
  const { client, rec } = c5FakeClient();
  const res = await handleRequest(await c5Request([
    { type: "follow", webhookEventId: "e1", timestamp: 1760000000000, replyToken: "r", source: { type: "user", userId: C5_USER } },
    { type: "unfollow", webhookEventId: "e2", timestamp: 1760000100000, source: { type: "user", userId: C5_USER } },
  ]), c5Deps(client));
  assertEquals(res.status, 200);
  assertEquals(rec.rpcs, [
    { fn: "internal_set_line_friendship", args: { p_merchant_id: "m-1", p_line_user_id: C5_USER, p_is_friend: true, p_changed_at: new Date(1760000000000).toISOString(), p_source: "webhook" } },
    { fn: "internal_set_line_friendship", args: { p_merchant_id: "m-1", p_line_user_id: C5_USER, p_is_friend: false, p_changed_at: new Date(1760000100000).toISOString(), p_source: "webhook" } },
  ]);
});

Deno.test("C5-F01-2 同一個事件重送(同 webhookEventId)只記一次;亂序由資料庫用 timestamp 判斷", async () => {
  const { client, rec } = c5FakeClient();
  const ev = { type: "follow", webhookEventId: "dup", timestamp: 1760000000000, source: { userId: C5_USER } };
  await handleRequest(await c5Request([ev]), c5Deps(client));
  await handleRequest(await c5Request([{ ...ev, deliveryContext: { isRedelivery: true } }]), c5Deps(client));
  assertEquals(rec.rpcs.length, 1);
});

Deno.test("C5-F01-3 驗簽失敗 ⇒ 401,完全不寫好友狀態", async () => {
  const { client, rec } = c5FakeClient();
  const res = await handleRequest(await c5Request([{ type: "follow", webhookEventId: "e9", source: { userId: C5_USER } }], "forged=="), c5Deps(client));
  assertEquals(res.status, 401);
  assertEquals(rec.rpcs.length, 0);
});

Deno.test("C5-F01-4 不明 destination ⇒ 安靜 200、不寫;綁定碼訊息照舊走 consume_line_binding_code", async () => {
  const { client, rec } = c5FakeClient();
  const body = JSON.stringify({ destination: "Unknown", events: [{ type: "follow", webhookEventId: "e3", source: { userId: C5_USER } }] });
  const res = await handleRequest(new Request("https://x/", { method: "POST", headers: { "x-line-signature": "x" }, body }), c5Deps(client));
  assertEquals(res.status, 200);
  assertEquals(rec.rpcs.length, 0);

  await handleRequest(await c5Request([
    { type: "message", webhookEventId: "e4", replyToken: "r", message: { type: "text", text: "123456" }, source: { userId: C5_USER } },
  ]), c5Deps(client));
  assertEquals(rec.rpcs.map((r) => r.fn), ["internal_merchant_has_feature", "consume_line_binding_code"]);
  assertEquals(rec.rpcs[0].args, { p_merchant_id: "m-1", p_feature_key: "line_notifications" });
});

// #1051(H1-21):店家「LINE 通知」功能關閉(或查詢失敗)⇒ 綁定碼不綁定、也不回覆。
for (const gate of [false, "error"] as const) {
  Deno.test(`#1051 LINE 通知功能 ${gate === false ? "關閉" : "查詢失敗"} ⇒ 不呼叫 consume_line_binding_code、不回覆`, async () => {
    const { client, rec } = c5FakeClient(gate);
    let replies = 0;
    const deps = {
      ...c5Deps(client),
      fetchImpl: (() => {
        replies++;
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    };
    const res = await handleRequest(await c5Request([
      { type: "message", webhookEventId: `g-${String(gate)}`, replyToken: "r", message: { type: "text", text: "123456" }, source: { userId: C5_USER } },
    ]), deps);
    assertEquals(res.status, 200);
    assertEquals(rec.rpcs.map((r) => r.fn), ["internal_merchant_has_feature"]);
    assertEquals(replies, 0);
  });
}

Deno.test("#1053 金鑰從 Vault 取:查表只選 merchant_id,用 RPC 取到的 secret 驗簽、token 回覆", async () => {
  const { client, rec } = c5FakeClient();
  const auths: string[] = [];
  const deps = {
    ...c5Deps(client),
    fetchImpl: ((_url: string, init?: RequestInit) => {
      auths.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch,
  };
  const res = await handleRequest(await c5Request([
    { type: "message", webhookEventId: "v1", replyToken: "r", message: { type: "text", text: "123456" }, source: { userId: C5_USER } },
  ]), deps);
  assertEquals(res.status, 200);
  assertEquals(rec.configSelects, ["merchant_id"]);
  assertEquals(rec.credentialCalls, [{ p_merchant_id: "m-1" }]);
  assertEquals(auths, ["Bearer TOKEN"]);
});

for (const mode of ["missing", "error"] as const) {
  Deno.test(`#1053 金鑰讀不到(${mode === "missing" ? "沒設定 / Vault 沒有" : "RPC 失敗"})⇒ 當作沒設定:安靜 200、不處理任何事件、log 不帶原文`, async () => {
    const { client, rec } = c5FakeClient(true, mode);
    const logs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      logs.push(a);
    };
    try {
      const res = await handleRequest(await c5Request([
        { type: "follow", webhookEventId: `k-${mode}`, source: { userId: C5_USER } },
      ]), c5Deps(client));
      assertEquals(res.status, 200);
      assertEquals(rec.rpcs.length, 0);
      assertEquals(rec.events.size, 0);
      assertEquals(logs, mode === "error" ? [["[line-webhook] 讀取 LINE 金鑰失敗", "XX000"]] : []);
    } finally {
      console.error = orig;
    }
  });
}

Deno.test("C5-F01-5 friendshipChangeFromEvent:沒有 userId / 其他事件 ⇒ null", () => {
  assertEquals(friendshipChangeFromEvent({ type: "follow", webhookEventId: "a" }), null);
  assertEquals(friendshipChangeFromEvent({ type: "message", webhookEventId: "a", source: { userId: C5_USER } }), null);
});
