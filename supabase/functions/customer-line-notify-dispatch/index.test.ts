// 客戶端第 5-A 批 — customer-line-notify-dispatch 的 Deno 測試(C5-S05 全分支、N13 範本代入、X02 機密)。
// 資料庫那一側(領取 / 準備 / 結束 / 收件人)測在 supabase/tests/database/c5_recipients_dispatch.sql。
// 跑法:npm run test:edge(或 node scripts/run-edge-function-tests.mjs supabase/functions/customer-line-notify-dispatch/index.test.ts)

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  classifyLineResponse,
  fetchLineQuota,
  isQuotaWarning,
  type CustomerLineDb,
  type FinishOutcome,
  handleRequest,
  isValidCronSecret,
  lineRetryKey,
  type LogInsert,
  memberCenterUrl,
  type PreparedJob,
  renderCustomerLineMessage,
  resolveLineApiBase,
  sanitizeError,
} from "./index.ts";

const URL_ = "https://example.supabase.co/functions/v1/customer-line-notify-dispatch";
const SECRET = "correct-customer-line-secret";
const TOKEN = "SENTINEL-CHANNEL-TOKEN-xyz";
const USER_A = "U0123456789abcdef0123456789abcdef";
const USER_B = "Ufedcba9876543210fedcba9876543210";

// ---------- 預設範本(跟 private.customer_line_default_templates(false) 逐字相同)----------
const T = {
  submitted_pending: "「{{merchant_name}}」已收到您的預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n店家確認後會再用 LINE 通知您。\n查看預約：{{member_center_url}}",
  submitted_accepted: "「{{merchant_name}}」預約成功：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  scheduled_by_store: "「{{merchant_name}}」已為您安排預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n查看預約：{{member_center_url}}",
  confirmed: "「{{merchant_name}}」已確認您的預約：\n{{booking_date}} {{booking_time}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  rescheduled: "「{{merchant_name}}」調整了您的預約時間：\n原本：{{old_booking_date}} {{old_booking_time}}\n改為：{{booking_date}} {{booking_time}}\n如果時間不方便，請聯絡店家：{{merchant_phone}}",
  cancelled_by_store: "「{{merchant_name}}」取消了您 {{booking_date}} {{booking_time}} 的預約。\n有問題請聯絡店家：{{merchant_phone}}",
  cancelled_by_customer: "您在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。",
  reminder: "提醒您：{{booking_day_word}} {{booking_time}} 在「{{merchant_name}}」有預約。\n{{service_items}}\n查看預約：{{member_center_url}}",
  completed: "謝謝您今天光臨「{{merchant_name}}」！\n查看紀錄：{{member_center_url}}",
  contact_request: "{{contact_name}} 申請成為您在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}",
  contact_removed: "您已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。",
  contact_approved: "您已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}",
  contact_rejected: "您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：{{merchant_phone}}",
};

const VARS: Record<string, string> = {
  member_name: "王小明",
  merchant_name: "涼風工匠",
  booking_date: "10月13日（二）",
  booking_time: "10:00",
  old_booking_date: "10月12日（一）",
  old_booking_time: "09:00",
  service_items: "室內機清洗 ×2、加價項目 ×1",
  staff_name: "阿明",
  merchant_phone: "0223456789",
  contact_name: "王太太",
  booking_day_word: "明天",
  member_center_url: "https://miaoyue.example/booking/coolbreeze/me/bookings",
};

Deno.test("N13-1 每個預設範本代入結果逐字比對", () => {
  const expected: Record<keyof typeof T, string> = {
    submitted_pending: "「涼風工匠」已收到您的預約：\n10月13日（二） 10:00\n室內機清洗 ×2、加價項目 ×1\n店家確認後會再用 LINE 通知您。\n查看預約：https://miaoyue.example/booking/coolbreeze/me/bookings",
    submitted_accepted: "「涼風工匠」預約成功：\n10月13日（二） 10:00\n室內機清洗 ×2、加價項目 ×1\n服務人員：阿明\n查看或取消：https://miaoyue.example/booking/coolbreeze/me/bookings",
    scheduled_by_store: "「涼風工匠」已為您安排預約：\n10月13日（二） 10:00\n室內機清洗 ×2、加價項目 ×1\n查看預約：https://miaoyue.example/booking/coolbreeze/me/bookings",
    confirmed: "「涼風工匠」已確認您的預約：\n10月13日（二） 10:00\n服務人員：阿明\n查看或取消：https://miaoyue.example/booking/coolbreeze/me/bookings",
    rescheduled: "「涼風工匠」調整了您的預約時間：\n原本：10月12日（一） 09:00\n改為：10月13日（二） 10:00\n如果時間不方便，請聯絡店家：0223456789",
    cancelled_by_store: "「涼風工匠」取消了您 10月13日（二） 10:00 的預約。\n有問題請聯絡店家：0223456789",
    cancelled_by_customer: "您在「涼風工匠」10月13日（二） 10:00 的預約已由 王太太 取消。",
    reminder: "提醒您：明天 10:00 在「涼風工匠」有預約。\n室內機清洗 ×2、加價項目 ×1\n查看預約：https://miaoyue.example/booking/coolbreeze/me/bookings",
    completed: "謝謝您今天光臨「涼風工匠」！\n查看紀錄：https://miaoyue.example/booking/coolbreeze/me/bookings",
    contact_request: "王太太 申請成為您在「涼風工匠」會員的聯絡人，請到會員中心同意或拒絕：https://miaoyue.example/booking/coolbreeze/me/bookings",
    contact_removed: "您已不是「涼風工匠」會員「王小明」的聯絡人，之後不會再收到這位會員的預約通知。",
    contact_approved: "您已成為「涼風工匠」會員「王小明」的聯絡人，可以到會員中心查看預約：https://miaoyue.example/booking/coolbreeze/me/bookings",
    contact_rejected: "您申請成為「涼風工匠」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：0223456789",
  };
  for (const code of Object.keys(T) as (keyof typeof T)[]) {
    assertEquals(renderCustomerLineMessage(T[code], VARS), expected[code], code);
  }
});

Deno.test("N13-2 店家沒填電話 ⇒ 含 {{merchant_phone}} 的那一整行拿掉(不留空尾巴)", () => {
  const vars = { ...VARS, merchant_phone: "" };
  assertEquals(renderCustomerLineMessage(T.rescheduled, vars), "「涼風工匠」調整了您的預約時間：\n原本：10月12日（一） 09:00\n改為：10月13日（二） 10:00");
  assertEquals(renderCustomerLineMessage(T.cancelled_by_store, vars), "「涼風工匠」取消了您 10月13日（二） 10:00 的預約。");
  // QA #1:電話那句是獨立一行 ⇒ 店家沒電話時仍會發出前半句(不再整則空白)
  assertEquals(renderCustomerLineMessage(T.contact_rejected, vars), "您申請成為「涼風工匠」會員聯絡人的要求沒有被同意。");
});

Deno.test("N13-3 姓名換行換成空白;變數只代入一次(不遞迴);不認得的原樣保留;截 5000 字", () => {
  assertEquals(renderCustomerLineMessage("{{contact_name}} 取消", { contact_name: "會計\r\n小姐 " }), "會計 小姐 取消");
  assertEquals(renderCustomerLineMessage("{{member_name}}/{{x}}", { member_name: "{{merchant_name}}", merchant_name: "店" }), "{{merchant_name}}/{{x}}");
  const long = renderCustomerLineMessage("{{member_name}}", { member_name: "字".repeat(6000) });
  assertEquals(Array.from(long).length, 5000);
});

Deno.test("N13-4 會員中心網址", () => {
  assertEquals(memberCenterUrl("https://a.example", "cool-breeze"), "https://a.example/booking/cool-breeze/me/bookings");
  assertEquals(memberCenterUrl(null, "x"), "");
});

Deno.test("S05-1 retry key:UUID 格式、同一位重試時同一把、不同人不同把", async () => {
  const a1 = await lineRetryKey("ob-1", USER_A);
  const a2 = await lineRetryKey("ob-1", USER_A);
  const b = await lineRetryKey("ob-1", USER_B);
  const c = await lineRetryKey("ob-2", USER_A);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a1), a1);
  assertEquals(a1, a2);
  assert(a1 !== b && a1 !== c);
});

Deno.test("S05-2 LINE 回應分類:2xx / 409 成功;429 每月額度 vs 太頻繁;5xx 暫時;其他 4xx 永久", () => {
  assertEquals(classifyLineResponse(200, ""), "ok");
  assertEquals(classifyLineResponse(409, '{"message":"The retry key is already accepted"}'), "ok");
  assertEquals(classifyLineResponse(429, '{"message":"You have reached your monthly limit."}'), "quota");
  assertEquals(classifyLineResponse(429, '{"message":"The API rate limit has been exceeded. Try again later."}'), "transient");
  assertEquals(classifyLineResponse(500, ""), "transient");
  assertEquals(classifyLineResponse(0, ""), "transient");
  assertEquals(classifyLineResponse(400, '{"message":"The property, \'to\', in the request body is invalid"}'), "permanent");
});

Deno.test("S05-3 錯誤內容遮掉 LINE userId、截 500 字", () => {
  assertEquals(sanitizeError(`bad ${USER_A}`), "bad U***");
  assertEquals(Array.from(sanitizeError("x".repeat(900))).length, 500);
});

Deno.test("F08 LINE 假端點只在本機 + LINE_MOCK_MODE=1 生效", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(resolveLineApiBase(env({ LINE_MOCK_MODE: "1", SUPABASE_URL: "https://x.supabase.co", LINE_MOCK_API_BASE: "http://127.0.0.1:9" })), "https://api.line.me");
  assertEquals(resolveLineApiBase(env({ LINE_MOCK_MODE: "1", SUPABASE_URL: "http://kong:8000", LINE_MOCK_API_BASE: "http://host.docker.internal:9/" })), "http://host.docker.internal:9");
  assertEquals(resolveLineApiBase(env({ SUPABASE_URL: "http://kong:8000" })), "https://api.line.me");
});

assert(isValidCronSecret(SECRET, SECRET));

// =========================================================================
// 主流程:假資料庫 + 假 LINE
// =========================================================================
interface World {
  queue: string[][];
  jobs: Record<string, PreparedJob>;
  logs: LogInsert[];
  finishes: [string, FinishOutcome, string | null][];
  lineCalls: { url: string; auth: string | null; retryKey: string | null; body: { to: string; messages: { text: string }[] } }[];
  lineResponder: (to: string, n: number) => Response;
  consoleLines: string[];
}

function world(jobs: Record<string, PreparedJob>, responder?: World["lineResponder"]): World {
  return {
    queue: [Object.keys(jobs)],
    jobs,
    logs: [],
    finishes: [],
    lineCalls: [],
    lineResponder: responder ?? (() => new Response("{}", { status: 200 })),
    consoleLines: [],
  };
}

function deps(w: World, envOverrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    CUSTOMER_LINE_CRON_SECRET: SECRET,
    PUBLIC_SITE_URL: "https://miaoyue.example",
    ...envOverrides,
  };
  const db: CustomerLineDb = {
    claim: () => Promise.resolve(w.queue.shift() ?? []),
    prepare: (id) => Promise.resolve(w.jobs[id] ?? { state: "not_claimed" }),
    insertLog: (row) => {
      w.logs.push(row);
      return Promise.resolve();
    },
    finish: (id, outcome, error) => {
      w.finishes.push([id, outcome, error]);
      return Promise.resolve();
    },
  };
  const counts: Record<string, number> = {};
  const fetchImpl = ((input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body));
    w.lineCalls.push({ url: String(input), auth: headers.get("Authorization"), retryKey: headers.get("X-Line-Retry-Key"), body });
    counts[body.to] = (counts[body.to] ?? 0) + 1;
    return Promise.resolve(w.lineResponder(body.to, counts[body.to]));
  }) as unknown as typeof fetch;
  const rec = (...a: unknown[]) => w.consoleLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  return { env: (k: string) => env[k], db, fetchImpl, log: { info: rec, warn: rec, error: rec } };
}

function req(secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Cron-Secret"] = secret;
  return new Request(URL_, { method: "POST", headers, body: "{}" });
}

function sendJob(over: Partial<PreparedJob> = {}): PreparedJob {
  return {
    state: "send",
    outbox_id: "ob-1",
    kind: "customer_confirmed",
    merchant_id: "m-1",
    booking_id: "b-1",
    member_id: "mem-1",
    attempts: 0,
    log_event_type: "customer_confirmed",
    channel_access_token: TOKEN,
    template_code: "confirmed",
    template: T.confirmed,
    variables: { ...VARS, member_center_url: "" },
    slug: "coolbreeze",
    recipients: [
      { to: USER_A, target_type: "member", target_id: "mem-1", target_user_id: "user-a" },
      { to: USER_B, target_type: "member", target_id: "mem-1", target_user_id: "user-b" },
    ],
    skipped: [{ target_type: "member", target_id: "mem-1", target_user_id: "user-c", reason: "customer_opted_out" }],
    ...over,
  };
}

Deno.test("S05-4 密鑰錯 / 沒帶 / 伺服器沒設 ⇒ 401,完全不碰資料庫", async () => {
  for (const [secret, env] of [["wrong", {}], [null, {}], [SECRET, { CUSTOMER_LINE_CRON_SECRET: "" }]] as const) {
    const w = world({ "ob-1": sendJob() });
    const res = await handleRequest(req(secret), deps(w, env as Record<string, string>));
    assertEquals(res.status, 401);
    assertEquals(w.queue.length, 1);
  }
  const w = world({});
  assertEquals((await handleRequest(new Request(URL_, { method: "GET" }), deps(w))).status, 405);
});

Deno.test("S05-5 成功:每位收件人一則(帶該店 token + retry key)、寫 sent;略過的寫 skipped;列標 sent;回應只有數字", async () => {
  const w = world({ "ob-1": sendJob() });
  const res = await handleRequest(req(), deps(w));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 1, sent: 1, skipped: 0, failed: 0, retried: 0, quota_exhausted: 0, quota_warned: 0 });
  assertEquals(w.lineCalls.length, 2);
  assertEquals(w.lineCalls[0].url, "https://api.line.me/v2/bot/message/push");
  assertEquals(w.lineCalls[0].auth, `Bearer ${TOKEN}`);
  assertEquals(w.lineCalls[0].retryKey, await lineRetryKey("ob-1", USER_A));
  assertEquals(w.lineCalls[0].body.messages[0].text,
    "「涼風工匠」已確認您的預約：\n10月13日（二） 10:00\n服務人員：阿明\n查看或取消：https://miaoyue.example/booking/coolbreeze/me/bookings");
  assertEquals(w.logs.map((l) => `${l.status}:${l.target_user_id}:${l.skip_reason}`), [
    "skipped:user-c:customer_opted_out", "sent:user-a:null", "sent:user-b:null",
  ]);
  assert(w.logs.every((l) => l.outbox_id === "ob-1" && l.event_type === "customer_confirmed" && l.target_type === "member"));
  assertEquals(w.finishes, [["ob-1", "sent", null]]);
});

Deno.test("S05-6 過時 / 時間改回 ⇒ 不打 LINE,寫一筆 skipped(stale / superseded)", async () => {
  const w = world({
    "ob-1": { state: "stale", outbox_id: "ob-1", kind: "customer_confirmed", merchant_id: "m-1", booking_id: "b-1", member_id: "mem-1" },
    "ob-2": { state: "superseded", outbox_id: "ob-2", kind: "customer_rescheduled", merchant_id: "m-1", booking_id: "b-1", member_id: "mem-1" },
    "ob-3": { state: "skip", reason: "event_disabled" },
    "ob-4": { state: "not_claimed" },
  });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.length, 0);
  assertEquals(w.logs.map((l) => `${l.event_type}:${l.status}:${l.skip_reason}`), [
    "customer_confirmed:skipped:stale", "customer_rescheduled:skipped:superseded",
  ]);
  assertEquals(w.finishes, [["ob-1", "skipped", "stale"], ["ob-2", "skipped", "superseded"], ["ob-3", "skipped", "event_disabled"]]);
});

Deno.test("S05-7 429 每月額度用完 ⇒ 不重試;這位與還沒發的都寫 quota_exhausted;列回 quota_exhausted", async () => {
  const w = world({ "ob-1": sendJob() }, () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 }));
  const res = await handleRequest(req(), deps(w));
  assertEquals((await res.json()).quota_exhausted, 1);
  assertEquals(w.lineCalls.length, 1);
  assertEquals(w.logs.filter((l) => l.skip_reason === "quota_exhausted").map((l) => l.target_user_id), ["user-a", "user-b"]);
  assertEquals(w.finishes, [["ob-1", "quota_exhausted", "quota_exhausted"]]);
});

Deno.test("S05-8 429 太頻繁 / 5xx ⇒ 重試(不寫 failed 記錄);成功的那位照寫 sent", async () => {
  const w = world({ "ob-1": sendJob() }, (to) =>
    to === USER_A ? new Response("{}", { status: 200 }) : new Response('{"message":"The API rate limit has been exceeded. Try again later."}', { status: 429 }));
  await handleRequest(req(), deps(w));
  assertEquals(w.logs.map((l) => `${l.status}:${l.target_user_id ?? ""}`), ["skipped:user-c", "sent:user-a"]);
  assertEquals(w.finishes[0][0], "ob-1");
  assertEquals(w.finishes[0][1], "retry");

  const w2 = world({ "ob-1": sendJob() }, () => new Response("oops", { status: 503 }));
  await handleRequest(req(), deps(w2));
  assertEquals(w2.finishes[0][1], "retry");
  assertEquals(w2.logs.filter((l) => l.status === "failed").length, 0);
});

Deno.test("S05-9 第 3 次重試還是 5xx ⇒ 寫 failed、列 failed;重試時 retry key 跟第一次相同", async () => {
  const w1 = world({ "ob-1": sendJob() }, () => new Response("", { status: 500 }));
  await handleRequest(req(), deps(w1));
  const w = world({ "ob-1": sendJob({ attempts: 3, skipped: [] }) }, () => new Response("", { status: 500 }));
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.map((c) => c.retryKey), w1.lineCalls.map((c) => c.retryKey));
  assertEquals(w.logs.map((l) => `${l.status}:${l.error_detail}`), ["failed:HTTP 500", "failed:HTTP 500"]);
  assertEquals(w.finishes, [["ob-1", "failed", "HTTP 500"]]);
});

Deno.test("S05-10 其他 4xx ⇒ 那一位 failed、不重試;全部失敗 ⇒ 列 failed", async () => {
  const w = world({ "ob-1": sendJob({ skipped: [] }) }, () => new Response(`{"message":"bad to ${USER_A}"}`, { status: 400 }));
  await handleRequest(req(), deps(w));
  assertEquals(w.logs.map((l) => l.status), ["failed", "failed"]);
  assert(w.logs.every((l) => !String(l.error_detail).includes(USER_A)));
  assertEquals(w.finishes, [["ob-1", "failed", "all_failed"]]);
});

Deno.test("S05-11 409(同一把 retry key 已被 LINE 收過)⇒ 當成功,不重送", async () => {
  const w = world({ "ob-1": sendJob({ recipients: [{ to: USER_A, target_type: "member", target_id: "mem-1", target_user_id: "user-a" }], skipped: [] }) },
    () => new Response('{"message":"The retry key is already accepted"}', { status: 409 }));
  await handleRequest(req(), deps(w));
  assertEquals(w.logs.map((l) => l.status), ["sent"]);
  assertEquals(w.finishes, [["ob-1", "sent", null]]);
});

Deno.test("S05-12 沒有收件人(全部略過)⇒ 不打 LINE,列 skipped", async () => {
  const w = world({ "ob-1": sendJob({ recipients: [] }) });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.length, 0);
  assertEquals(w.finishes, [["ob-1", "skipped", null]]);
});

Deno.test("S05-13 文字代入後是空白 ⇒ 不打 LINE,寫 failed", async () => {
  const w = world({ "ob-1": sendJob({ template: "  {{merchant_phone}}", variables: { merchant_phone: "" }, skipped: [] }) });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.length, 0);
  assertEquals(w.logs.map((l) => l.status), ["failed", "failed"]);
  assertEquals(w.finishes, [["ob-1", "failed", "empty_message"]]);
});

Deno.test("S06-1 店家那邊(客人送出)⇒ 模組 11 範本原樣代入、event_type booking_created、對象是管理員", async () => {
  const w = world({
    "ob-1": sendJob({
      kind: "store_booking_created",
      log_event_type: "booking_created",
      template: "{{customer_name}} 新預約\n電話：{{merchant_phone}}",
      variables: { customer_name: "王小明" },
      recipients: [{ to: USER_A, target_type: "admin", target_id: "adm-1", target_user_id: null }],
      skipped: [{ target_type: "staff", target_id: "st-1", target_user_id: null, reason: "target_not_bound" }],
    }),
  });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls[0].body.messages[0].text, "王小明 新預約\n電話：{{merchant_phone}}");
  assertEquals(w.logs.map((l) => `${l.event_type}:${l.target_type}:${l.status}`), ["booking_created:staff:skipped", "booking_created:admin:sent"]);
});

Deno.test("S05-14 一列處理丟錯不中斷整批", async () => {
  const w = world({ "ob-1": sendJob(), "ob-2": sendJob({ outbox_id: "ob-2" }) });
  const d = deps(w);
  const orig = d.db.prepare;
  d.db.prepare = (id) => (id === "ob-1" ? Promise.reject(new Error("boom")) : orig(id));
  const res = await handleRequest(req(), d);
  assertEquals((await res.json()).sent, 1);
  assertEquals(w.finishes.map((f) => f[0]), ["ob-2"]);
});

Deno.test("S05-15 一次最多 4 批 × 50 列", async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `x-${i}`);
  const w = world({});
  w.queue = [ids, ids, ids, ids, ids];
  const res = await handleRequest(req(), deps(w));
  assertEquals((await res.json()).claimed, 200);
  assertEquals(w.queue.length, 1);
});

Deno.test("X02 token / LINE userId 不出現在 console、記錄的錯誤內容、回應", async () => {
  for (const responder of [
    () => new Response("{}", { status: 200 }),
    () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 }),
    () => new Response("", { status: 500 }),
    () => new Response(`{"message":"invalid ${USER_B}"}`, { status: 400 }),
  ]) {
    const w = world({ "ob-1": sendJob({ attempts: 3 }) }, responder);
    const d = deps(w);
    d.db.finish = () => Promise.reject(new Error(`finish failed ${TOKEN}`));
    const res = await handleRequest(req(), d);
    const text = await res.text();
    const everything = [text, ...w.consoleLines, ...w.logs.map((l) => String(l.error_detail)), ...w.finishes.map((f) => String(f[2]))].join("\n");
    assert(!everything.includes(TOKEN), "token leaked");
    assert(!everything.includes(USER_A) && !everything.includes(USER_B), "userId leaked");
  }
});

// =========================================================================
// 第 5-B 批(#1047):每月上限雙保險、80% 鈴鐺、提醒 / 完成 / 聯絡人通知照常發
// =========================================================================

function quotaFetch(quota: { status?: number; body: unknown }, consumption: { status?: number; body: unknown }, w?: World) {
  return ((input: string, init: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("Authorization");
    if (url.endsWith("/v2/bot/message/quota")) {
      w?.lineCalls.push({ url, auth, retryKey: null, body: { to: "", messages: [] } });
      return Promise.resolve(new Response(JSON.stringify(quota.body), { status: quota.status ?? 200 }));
    }
    if (url.endsWith("/v2/bot/message/quota/consumption")) {
      w?.lineCalls.push({ url, auth, retryKey: null, body: { to: "", messages: [] } });
      return Promise.resolve(new Response(JSON.stringify(consumption.body), { status: consumption.status ?? 200 }));
    }
    const body = JSON.parse(String(init.body));
    w?.lineCalls.push({ url, auth, retryKey: new Headers(init.headers).get("X-Line-Retry-Key"), body });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

Deno.test("Q01-1 cap_remaining 比收件人少 ⇒ 只發前面幾位,其餘寫 skipped / monthly_cap", async () => {
  const w = world({ "ob-1": sendJob({ cap_remaining: 1, skipped: [] }) });
  const res = await handleRequest(req(), deps(w));
  assertEquals((await res.json()).sent, 1);
  assertEquals(w.lineCalls.length, 1);
  assertEquals(w.logs.map((l) => `${l.status}:${l.target_user_id}:${l.skip_reason}`), ["skipped:user-b:monthly_cap", "sent:user-a:null"]);
  assertEquals(w.finishes, [["ob-1", "sent", null]]);
});

Deno.test("Q01-2 cap_remaining = 0 ⇒ 不打 LINE,全部 monthly_cap,列 skipped;null(沒設上限)⇒ 照常", async () => {
  const w = world({ "ob-1": sendJob({ cap_remaining: 0, skipped: [] }) });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.length, 0);
  assertEquals(w.logs.map((l) => l.skip_reason), ["monthly_cap", "monthly_cap"]);
  assertEquals(w.finishes, [["ob-1", "skipped", null]]);

  const w2 = world({ "ob-1": sendJob({ cap_remaining: null, skipped: [] }) });
  await handleRequest(req(), deps(w2));
  assertEquals(w2.lineCalls.length, 2);
});

Deno.test("Q01-3 店家那邊(store_*)不受客人通知上限影響", async () => {
  const w = world({ "ob-1": sendJob({ kind: "store_booking_created", log_event_type: "booking_created", cap_remaining: 0, skipped: [] }) });
  await handleRequest(req(), deps(w));
  assertEquals(w.lineCalls.length, 2);
});

Deno.test("Q04-1 fetchLineQuota:limited / none / 失敗;isQuotaWarning 80% 整數比較", async () => {
  assertEquals(await fetchLineQuota(quotaFetch({ body: { type: "limited", value: 200 } }, { body: { totalUsage: 160 } }), "https://api.line.me", TOKEN),
    { type: "limited", limit: 200, used: 160 });
  assertEquals(await fetchLineQuota(quotaFetch({ body: { type: "none" } }, { body: { totalUsage: 5000 } }), "https://api.line.me", TOKEN),
    { type: "none", limit: null, used: 5000 });
  assertEquals(await fetchLineQuota(quotaFetch({ status: 401, body: {} }, { body: { totalUsage: 1 } }), "https://api.line.me", TOKEN), null);
  assertEquals(await fetchLineQuota(quotaFetch({ body: { type: "limited", value: 200 } }, { body: { oops: 1 } }), "https://api.line.me", TOKEN), null);
  const throwing = (() => Promise.reject(new Error(`net ${TOKEN}`))) as unknown as typeof fetch;
  assertEquals(await fetchLineQuota(throwing, "https://api.line.me", TOKEN), null);
  assertEquals(isQuotaWarning({ type: "limited", limit: 200, used: 160 }), true);
  assertEquals(isQuotaWarning({ type: "limited", limit: 200, used: 159 }), false);
  assertEquals(isQuotaWarning({ type: "none", limit: null, used: 999999 }), false);
  assertEquals(isQuotaWarning(null), false);
});

function quotaDeps(w: World, opts: { due: boolean; quota: unknown; used: number }) {
  const d = deps(w);
  const calls: string[] = [];
  d.db.quotaCheckDue = (m) => {
    calls.push(`due:${m}`);
    return Promise.resolve(opts.due);
  };
  d.db.quotaWarning = (m, used, limit) => {
    calls.push(`warn:${m}:${used}/${limit}`);
    return Promise.resolve(true);
  };
  d.fetchImpl = quotaFetch({ body: opts.quota }, { body: { totalUsage: opts.used } }, w);
  return { d, calls };
}

Deno.test("Q04-2 有發出去 + 該查了 + 已用 ≥ 80% ⇒ 查額度(用該店 token)並發鈴鐺;回應 quota_warned 1", async () => {
  const w = world({ "ob-1": sendJob() });
  const { d, calls } = quotaDeps(w, { due: true, quota: { type: "limited", value: 200 }, used: 170 });
  const res = await handleRequest(req(), d);
  assertEquals((await res.json()).quota_warned, 1);
  assertEquals(calls, ["due:m-1", "warn:m-1:170/200"]);
  const quotaCalls = w.lineCalls.filter((c) => c.url.includes("/quota"));
  assertEquals(quotaCalls.length, 2);
  assert(quotaCalls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

Deno.test("Q04-3 未滿 80% / 沒有上限 / 這小時查過 ⇒ 不發鈴鐺;沒有任何一則發出去 ⇒ 連查都不查", async () => {
  const cases: { due: boolean; quota: unknown; used: number }[] = [
    { due: true, quota: { type: "limited", value: 200 }, used: 159 },
    { due: true, quota: { type: "none" }, used: 9999 },
    { due: false, quota: { type: "limited", value: 200 }, used: 199 },
  ];
  for (const opts of cases) {
    const w = world({ "ob-1": sendJob() });
    const { d, calls } = quotaDeps(w, opts);
    const res = await handleRequest(req(), d);
    assertEquals((await res.json()).quota_warned, 0);
    assertEquals(calls, ["due:m-1"]);
    if (!opts.due) assertEquals(w.lineCalls.filter((c) => c.url.includes("/quota")).length, 0);
  }
  const w = world({ "ob-1": sendJob({ recipients: [] }) });
  const { d, calls } = quotaDeps(w, { due: true, quota: { type: "limited", value: 200 }, used: 199 });
  await handleRequest(req(), d);
  assertEquals(calls, []);
});

Deno.test("Q04-4 查額度失敗不影響這次發送結果,也不洩漏 token", async () => {
  const w = world({ "ob-1": sendJob() });
  const d = deps(w);
  d.db.quotaCheckDue = () => Promise.reject(new Error(`db down ${TOKEN}`));
  d.db.quotaWarning = () => Promise.resolve(true);
  const res = await handleRequest(req(), d);
  const body = await res.json();
  assertEquals(body.sent, 1);
  assertEquals(body.quota_warned, 0);
  assert(![JSON.stringify(body), ...w.consoleLines].join("\n").includes(TOKEN));
});

Deno.test("N07/N08/N09~N11 提醒、完成、聯絡人通知:照一般流程發(資料庫 prepare 不再標 skipped)", async () => {
  const jobs: Record<string, PreparedJob> = {
    "ob-r": sendJob({ outbox_id: "ob-r", kind: "customer_reminder", log_event_type: "customer_reminder", template_code: "reminder", template: T.reminder, skipped: [] }),
    "ob-c": sendJob({ outbox_id: "ob-c", kind: "customer_completed", log_event_type: "customer_completed", template_code: "completed", template: T.completed, skipped: [] }),
    "ob-q": sendJob({
      outbox_id: "ob-q", kind: "customer_contact_request", log_event_type: "customer_contact_request", booking_id: null,
      template_code: "contact_request", template: T.contact_request, skipped: [],
      recipients: [{ to: USER_A, target_type: "member", target_id: "mem-1", target_user_id: "user-a" }],
    }),
  };
  const w = world(jobs);
  const res = await handleRequest(req(), deps(w));
  assertEquals((await res.json()).sent, 3);
  const texts = w.lineCalls.map((c) => c.body.messages[0].text);
  assert(texts.includes("提醒您：明天 10:00 在「涼風工匠」有預約。\n室內機清洗 ×2、加價項目 ×1\n查看預約：https://miaoyue.example/booking/coolbreeze/me/bookings"));
  assert(texts.includes("王太太 申請成為您在「涼風工匠」會員的聯絡人，請到會員中心同意或拒絕：https://miaoyue.example/booking/coolbreeze/me/bookings"));
  assertEquals([...new Set(w.logs.map((l) => l.event_type))].sort(), ["customer_completed", "customer_contact_request", "customer_reminder"]);
  assert(w.logs.filter((l) => l.event_type === "customer_contact_request").every((l) => l.booking_id === null));
});
