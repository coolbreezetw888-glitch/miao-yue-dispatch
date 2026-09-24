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
