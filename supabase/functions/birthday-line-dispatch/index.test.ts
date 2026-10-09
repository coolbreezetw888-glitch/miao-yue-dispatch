// 紅利系統重構 批次 5(#841)— birthday-line-dispatch 的 Deno 測試(規格書 §3.7、§七)。
//
// 分工:「未綁 LINE ⇒ skipped_not_bound、商家未連線 ⇒ skipped_not_connected、已認領不重撈、回寫只改 pending」
// 是資料庫函式 claim_birthday_line_pending / mark_birthday_line_result 的語意,測在
// supabase/tests/database/module10_15_bonus_refactor_batch5_birthday.sql 的 G 區塊。
// 這裡測 Edge Function 這一層:密鑰、文案代入、LINE 成功 / 失敗、發送紀錄與回寫、失敗不中斷整批。
//
// 跑法:npm run test:edge(或 node scripts/run-edge-function-tests.mjs supabase/functions/birthday-line-dispatch/index.test.ts)

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  type BirthdayDispatchDb,
  type BirthdayLogInsert,
  type ClaimedBirthdayRow,
  BIRTHDAY_FEATURE_CHECK_FAILED_ERROR,
  BIRTHDAY_FEATURE_DISABLED_ERROR,
  CLAIM_BATCH_SIZE,
  handleRequest,
  isValidCronSecret,
  renderBirthdayMessage,
} from "./index.ts";

const URL_ = "https://example.supabase.co/functions/v1/birthday-line-dispatch";
const SECRET = "correct-birthday-secret";

function row(overrides: Partial<ClaimedBirthdayRow> = {}): ClaimedBirthdayRow {
  return {
    grant_id: "g-1",
    merchant_id: "m-1",
    member_id: "mem-1",
    line_user_id: "U-1",
    channel_access_token: "token-1",
    message_template: "{{member_name}} 生日快樂！{{merchant_name}} 送您 {{points}} 點",
    member_name: "王小明",
    points: 30,
    merchant_name: "涼風工匠",
    ...overrides,
  };
}

interface Recorded {
  claims: number[];
  logs: BirthdayLogInsert[];
  marks: [string, string, string | null, string | null][];
  lineCalls: { url: string; auth: string | null; body: unknown }[];
  /** SPECS-INDEX #1025 FG2-F01:問過哪幾間店的「LINE 通知」開關。 */
  featureChecks: string[];
}

function makeDb(
  batches: ClaimedBirthdayRow[][],
  opts: { insertLogThrows?: boolean; lineFeature?: (merchantId: string) => boolean | "error" } = {},
) {
  const recorded: Recorded = { claims: [], logs: [], marks: [], lineCalls: [], featureChecks: [] };
  let i = 0;
  const db: BirthdayDispatchDb = {
    lineFeatureEnabled(merchantId) {
      recorded.featureChecks.push(merchantId);
      return Promise.resolve(opts.lineFeature ? opts.lineFeature(merchantId) : true);
    },
    claimPending(limit) {
      recorded.claims.push(limit);
      return Promise.resolve(batches[i++] ?? []);
    },
    insertLog(r) {
      if (opts.insertLogThrows) return Promise.reject(new Error("db down"));
      recorded.logs.push(r);
      return Promise.resolve(`log-${recorded.logs.length}`);
    },
    markResult(grantId, status, error, logId) {
      recorded.marks.push([grantId, status, error, logId]);
      return Promise.resolve();
    },
  };
  return { db, recorded };
}

function makeFetch(recorded: Recorded, responder: (n: number) => Response | Error): typeof fetch {
  let n = 0;
  return ((input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.lineCalls.push({
      url: String(input),
      auth: headers.get("Authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const r = responder(n++);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as typeof fetch;
}

function cronRequest(secret: string | null, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Cron-Secret"] = secret;
  return new Request(URL_, { method, headers, body: method === "POST" ? "{}" : undefined });
}

// =========================================================================
// 密鑰
// =========================================================================
Deno.test("isValidCronSecret:缺少 / 錯誤 / 長度不同都擋下,正確才放行", () => {
  assertEquals(isValidCronSecret(null, SECRET), false);
  assertEquals(isValidCronSecret("wrong", SECRET), false);
  assertEquals(isValidCronSecret(SECRET + "x", SECRET), false);
  assertEquals(isValidCronSecret(SECRET, SECRET), true);
});

Deno.test("isValidCronSecret:環境變數沒設(空字串)時一律擋下", () => {
  assertEquals(isValidCronSecret("", ""), false);
  assertEquals(isValidCronSecret(null, ""), false);
});

Deno.test("handleRequest(核心):密鑰錯誤回 401,完全不認領、不呼叫 LINE", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row()]]);
  const fetchImpl = makeFetch(recorded, () => new Response("{}", { status: 200 }));
  for (const bad of [null, "wrong-secret", ""]) {
    const res = await handleRequest(cronRequest(bad), { db, fetchImpl });
    assertEquals(res.status, 401);
  }
  assertEquals(recorded.claims.length, 0);
  assertEquals(recorded.lineCalls.length, 0);
});

Deno.test("handleRequest:伺服器沒設定密鑰時,就算帶了標頭也是 401", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", "");
  const { db, recorded } = makeDb([[row()]]);
  const res = await handleRequest(cronRequest(""), { db, fetchImpl: makeFetch(recorded, () => new Response("{}")) });
  assertEquals(res.status, 401);
  assertEquals(recorded.claims.length, 0);
});

Deno.test("handleRequest:非 POST 回 405", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db } = makeDb([]);
  const res = await handleRequest(cronRequest(SECRET, "GET"), { db });
  assertEquals(res.status, 405);
});

// =========================================================================
// 發送成功 / 失敗
// =========================================================================
Deno.test("handleRequest(核心):LINE 成功 ⇒ 代入文案、寫發送紀錄 sent、回寫 sent", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row()]]);
  const fetchImpl = makeFetch(recorded, () => new Response("{}", { status: 200 }));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 1, sent: 1, failed: 0 });
  assertEquals(recorded.lineCalls.length, 1);
  assertEquals(recorded.lineCalls[0].url, "https://api.line.me/v2/bot/message/push");
  assertEquals(recorded.lineCalls[0].auth, "Bearer token-1");
  assertEquals(recorded.lineCalls[0].body, {
    to: "U-1",
    messages: [{ type: "text", text: "王小明 生日快樂！涼風工匠 送您 30 點" }],
  });
  assertEquals(recorded.logs, [{
    merchant_id: "m-1",
    event_type: "birthday_bonus",
    target_type: "member",
    target_id: "mem-1",
    target_line_user_id: "U-1",
    status: "sent",
    error_detail: null,
    rendered_message: "王小明 生日快樂！涼風工匠 送您 30 點",
  }]);
  assertEquals(recorded.marks, [["g-1", "sent", null, "log-1"]]);
});

Deno.test("handleRequest(核心):LINE 回 400 ⇒ 發送紀錄 failed、回寫 failed 並帶錯誤,下一筆照發", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row(), row({ grant_id: "g-2", member_id: "mem-2", line_user_id: "U-2" })]]);
  const fetchImpl = makeFetch(recorded, (n) =>
    n === 0 ? new Response('{"message":"The request body has 1 error(s)"}', { status: 400 }) : new Response("{}"));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });

  assertEquals(await res.json(), { claimed: 2, sent: 1, failed: 1 });
  assertEquals(recorded.logs[0].status, "failed");
  assertEquals(recorded.logs[0].error_detail, 'HTTP 400 {"message":"The request body has 1 error(s)"}');
  assertEquals(recorded.marks[0], ["g-1", "failed", 'HTTP 400 {"message":"The request body has 1 error(s)"}', "log-1"]);
  assertEquals(recorded.marks[1], ["g-2", "sent", null, "log-2"]);
});

Deno.test("handleRequest:LINE 連線例外(網路錯誤)也記 failed,不讓整支函式炸掉", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row()]]);
  const fetchImpl = makeFetch(recorded, () => new Error("connection reset"));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(res.status, 200);
  assertEquals(recorded.marks, [["g-1", "failed", "connection reset", "log-1"]]);
});

Deno.test("handleRequest:寫發送紀錄失敗時仍回寫結果(log id 為 null),不重送", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row()]], { insertLogThrows: true });
  const fetchImpl = makeFetch(recorded, () => new Response("{}"));
  await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(recorded.lineCalls.length, 1);
  assertEquals(recorded.marks, [["g-1", "sent", null, null]]);
});

Deno.test("handleRequest:沒有要發的列(未綁定 / 未連線都已在資料庫端略過)⇒ 完全不呼叫 LINE", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[]]);
  const fetchImpl = makeFetch(recorded, () => new Response("{}"));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(await res.json(), { claimed: 0, sent: 0, failed: 0 });
  assertEquals(recorded.lineCalls.length, 0);
  assertEquals(recorded.claims, [CLAIM_BATCH_SIZE]);
});

Deno.test("handleRequest:文案是空白 ⇒ 不呼叫 LINE,直接記 failed", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row({ message_template: "   " })]]);
  const fetchImpl = makeFetch(recorded, () => new Response("{}"));
  await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(recorded.lineCalls.length, 0);
  assertEquals(recorded.marks, [["g-1", "failed", "生日 LINE 文案是空白，沒有發送", "log-1"]]);
});

Deno.test("handleRequest:滿一批(100 筆)會再認領下一批,不滿就停", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const full = Array.from({ length: CLAIM_BATCH_SIZE }, (_, k) => row({ grant_id: `g-${k}` }));
  const { db, recorded } = makeDb([full, [row({ grant_id: "g-last" })]]);
  const fetchImpl = makeFetch(recorded, () => new Response("{}"));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(await res.json(), { claimed: CLAIM_BATCH_SIZE + 1, sent: CLAIM_BATCH_SIZE + 1, failed: 0 });
  assertEquals(recorded.claims.length, 2);
});

// =========================================================================
// 文案代入(商家輸入一律當純文字)
// =========================================================================
Deno.test("renderBirthdayMessage:三個變數代入;不認得的變數原樣保留", () => {
  assertEquals(
    renderBirthdayMessage(row({ message_template: "{{member_name}}/{{points}}/{{merchant_name}}/{{unknown}}" })),
    "王小明/30/涼風工匠/{{unknown}}",
  );
});

Deno.test("renderBirthdayMessage(資安):代入的值不會被二次展開,HTML / 特殊字元原樣當純文字", () => {
  const text = renderBirthdayMessage(row({
    message_template: "<b>{{member_name}}</b> {{points}}",
    member_name: "{{points}}<script>alert(1)</script>",
  }));
  assertEquals(text, "<b>{{points}}<script>alert(1)</script></b> 30");
});

Deno.test("renderBirthdayMessage:超過 LINE 上限 5000 字會截斷", () => {
  const text = renderBirthdayMessage(row({ message_template: "{{member_name}}", member_name: "字".repeat(6000) }));
  assertEquals(Array.from(text).length, 5000);
  assert(text.startsWith("字字"));
});

// =========================================================================
// SPECS-INDEX #1025 FG2-F01:每間店發送前檢查平台功能「LINE 通知」(這支自己檢查,X7)。
// =========================================================================
Deno.test("FG2:A 店沒開 LINE 通知 ⇒ A 店不打 LINE、不寫發送紀錄、回寫 failed + 白話原因;B 店照常發", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb(
    [[row({ grant_id: "g-a", merchant_id: "m-a" }), row({ grant_id: "g-b", merchant_id: "m-b", line_user_id: "U-b" })]],
    { lineFeature: (m) => m !== "m-a" },
  );
  const fetchImpl = makeFetch(recorded, () => new Response("{}", { status: 200 }));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 2, sent: 1, failed: 1 });
  assertEquals(recorded.featureChecks, ["m-a", "m-b"]);
  assertEquals(recorded.lineCalls.length, 1);
  assertEquals((recorded.lineCalls[0].body as { to: string }).to, "U-b");
  assertEquals(recorded.logs.length, 1);
  assertEquals(recorded.logs[0].merchant_id, "m-b");
  assertEquals(recorded.marks[0], ["g-a", "failed", BIRTHDAY_FEATURE_DISABLED_ERROR, null]);
  assertEquals(recorded.marks[1][0], "g-b");
  assertEquals(recorded.marks[1][1], "sent");
});

Deno.test("FG2:查詢功能開關失敗 ⇒ 不發(fail closed)、回寫 failed + 原因", async () => {
  Deno.env.set("BIRTHDAY_LINE_CRON_SECRET", SECRET);
  const { db, recorded } = makeDb([[row()]], { lineFeature: () => "error" });
  const fetchImpl = makeFetch(recorded, () => new Response("{}", { status: 200 }));
  const res = await handleRequest(cronRequest(SECRET), { db, fetchImpl });
  assertEquals(await res.json(), { claimed: 1, sent: 0, failed: 1 });
  assertEquals(recorded.lineCalls.length, 0);
  assertEquals(recorded.logs.length, 0);
  assertEquals(recorded.marks[0], ["g-1", "failed", BIRTHDAY_FEATURE_CHECK_FAILED_ERROR, null]);
});
