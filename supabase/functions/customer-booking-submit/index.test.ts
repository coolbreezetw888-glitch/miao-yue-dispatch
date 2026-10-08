// 客戶端第 3 批 — customer-booking-submit 測試(注入假 Turnstile、假 admin、假推播)
// 涵蓋:C3-B01~B03、C3-C02 呼叫方式、C3-G03、C3-F01 / F02 / F06
import { assert, assertEquals } from "jsr:@std/assert";
import { handleRequest, isTurnstileTestSecret, looksLikeUserToken, type SubmitDeps } from "./index.ts";
import type { DispatchPushForBookingParams } from "../_shared/pushDispatchCore.ts";

const SITE = "https://miao-yue-dispatch.vercel.app";
const SUB_ID = "11111111-2222-4333-8444-555555555555";
const ITEM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STAFF = "99999999-8888-4777-8666-555555555555";
const USER_ID = "c0000000-0000-4000-8000-000000000001";
const PROD_SECRET = "0x4AAAAAAA-real-secret-SENTINEL";
const TURNSTILE_TOKEN = "TURNSTILE_TOKEN_SENTINEL_xyz";

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const USER_JWT = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ role: "authenticated", sub: USER_ID })}.SIG_SENTINEL`;
const ANON_JWT = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ role: "anon" })}.ANONSIG`;

const CREATED = {
  state: "created",
  booking: {
    status: "pending_confirmation",
    start_at: "2026-10-13T02:00:00+00:00",
    end_at: "2026-10-13T03:00:00+00:00",
    staff_display: "阿明",
    items: [{ name: "室內機清洗", quantity: 1 }],
    address: null,
    phone: "0912-345-678",
    estimated_amount: 1000,
    is_guest: true,
  },
  completion_message: "店家確認後會與你聯絡。",
};

interface Fake {
  deps: SubmitDeps;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  fetchCalls: { url: string; body: string }[];
  pushCalls: DispatchPushForBookingParams[];
  logs: string[];
}

function makeFake(opts: {
  env?: Record<string, string | undefined>;
  rateLimit?: Record<string, boolean>;
  submit?: { data: unknown; error: { code?: string; hint?: string; message?: string } | null };
  user?: { id: string; app_metadata: Record<string, unknown> | null } | null;
  siteverify?: Record<string, unknown> | "network_error";
  pushThrows?: boolean;
} = {}): Fake {
  const env: Record<string, string | undefined> = {
    PUBLIC_SITE_URL: SITE,
    SUPABASE_URL: "https://wjtbmmnakcriuaqoknsq.supabase.co",
    TURNSTILE_SECRET_KEY: PROD_SECRET,
    ...(opts.env ?? {}),
  };
  const f: Fake = { rpcCalls: [], fetchCalls: [], pushCalls: [], logs: [], deps: null as unknown as SubmitDeps };
  const push = (...args: unknown[]) => f.logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  f.deps = {
    env: (k) => env[k],
    rpc(fn, args) {
      f.rpcCalls.push({ fn, args });
      if (fn === "internal_rate_limit_hit") {
        const bucket = String(args.p_bucket);
        return Promise.resolve({ data: opts.rateLimit?.[bucket] ?? true, error: null });
      }
      if (fn === "internal_customer_submit_booking") {
        return Promise.resolve(
          opts.submit ?? {
            data: { ...CREATED, _internal: { replayed: false, booking_id: "b-1", merchant_id: "m-1", push_title: "新的線上預約（待確認）", push_body: "客人「王小明」…" } },
            error: null,
          },
        );
      }
      return Promise.resolve({ data: null, error: { message: "unexpected" } });
    },
    getUser: () =>
      Promise.resolve(opts.user === undefined ? { id: USER_ID, app_metadata: { account_type: "customer" } } : opts.user),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      f.fetchCalls.push({ url: String(input), body: String(init?.body ?? "") });
      if (opts.siteverify === "network_error") throw new Error("down");
      const body = opts.siteverify ?? { success: true, action: "guest_booking", hostname: "miao-yue-dispatch.vercel.app" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
    dispatchPush(params) {
      f.pushCalls.push(params);
      if (opts.pushThrows) return Promise.reject(new Error("push down"));
      return Promise.resolve({ dispatched: false });
    },
    log: { info: push, warn: push, error: push },
  };
  return f;
}

function draft(extra: Record<string, unknown> = {}) {
  return {
    items: [{ service_item_id: ITEM, quantity: 2, unit_price: 0 }],
    staff_id: STAFF,
    date: "2026-10-13",
    time: "10:00",
    name: "王小明NAME_SENTINEL",
    address: "台北市ADDRESS_SENTINEL",
    notes: "NOTES_SENTINEL",
    ...extra,
  };
}

function req(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://x.supabase.co/functions/v1/customer-booking-submit", {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": "6.6.6.6, 203.0.113.9", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}
const guestBody = (g: Record<string, unknown> = {}) => ({
  slug: " Shop-CD0E4D ",
  submission_id: SUB_ID,
  draft: draft(),
  guest: { phone: "0912-345-678", agree_policy: true, turnstile_token: TURNSTILE_TOKEN, ...g },
});
const memberBody = () => ({ slug: "shop-cd0e4d", submission_id: SUB_ID, draft: draft() });

async function call(f: Fake, r: Request) {
  const res = await handleRequest(r, f.deps);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}
const submitCall = (f: Fake) => f.rpcCalls.find((c) => c.fn === "internal_customer_submit_booking");

// ---------------------------------------------------------------------------
Deno.test("B01 來源不允許 ⇒ 403;OPTIONS 允許的來源 204", async () => {
  const f = makeFake();
  assertEquals((await call(f, req(guestBody(), { Origin: "https://evil.example" }))).status, 403);
  const opt = await handleRequest(req(null, { Origin: SITE }, "OPTIONS"), f.deps);
  assertEquals(opt.status, 204);
  assertEquals(opt.headers.get("Access-Control-Allow-Origin"), SITE);
  assertEquals(f.rpcCalls.length, 0);
});

Deno.test("B01 格式錯 ⇒ 400:壞 JSON、超過 8KB、submission_id 不是 uuid、草稿不合格(數量 21)", async () => {
  const f = makeFake();
  assertEquals((await call(f, req("{not json"))).status, 400);
  assertEquals((await call(f, req({ ...guestBody(), pad: "x".repeat(9000) }))).status, 400);
  assertEquals((await call(f, req({ ...guestBody(), submission_id: "abc" }))).status, 400);
  const bad = await call(f, req({ ...guestBody(), draft: draft({ items: [{ service_item_id: ITEM, quantity: 21 }] }) }));
  assertEquals(bad.status, 400);
  assertEquals(bad.body, { state: "invalid_request", hint: "invalid_draft" });
  assertEquals(f.rpcCalls.length, 0);
});

Deno.test("B01 會員 token + guest 同時帶 ⇒ 400;兩個都沒帶 ⇒ 400", async () => {
  const f = makeFake();
  assertEquals((await call(f, req(guestBody(), { Authorization: `Bearer ${USER_JWT}` }))).status, 400);
  assertEquals((await call(f, req(memberBody()))).status, 400);
  assertEquals(f.rpcCalls.length, 0);
});

Deno.test("B01 帶 anon key 的 Authorization ⇒ 視為訪客", async () => {
  assertEquals(looksLikeUserToken(ANON_JWT), false);
  assertEquals(looksLikeUserToken(USER_JWT), true);
  assertEquals(looksLikeUserToken("sb_publishable_xxx"), false);
  const f = makeFake();
  const r = await call(f, req(guestBody(), { Authorization: `Bearer ${ANON_JWT}` }));
  assertEquals(r.status, 200);
  assertEquals(submitCall(f)?.args.p_user_id, null);
});

Deno.test("G03 同一 IP 10 分鐘超過 10 次 ⇒ rate_limited,不驗 Turnstile、不建單;IP 用 XFF 最後一段", async () => {
  const f = makeFake({ rateLimit: { customer_submit_ip: false } });
  const r = await call(f, req(guestBody()));
  assertEquals(r.body, { state: "rate_limited" });
  assertEquals(f.rpcCalls[0].args, { p_bucket: "customer_submit_ip", p_key: "ip:203.0.113.9", p_window_seconds: 600, p_max: 10 });
  assertEquals(f.fetchCalls.length, 0);
  assertEquals(submitCall(f), undefined);
});

Deno.test("G03 訪客同一 IP 同一間店 24 小時超過 5 次 ⇒ rate_limited(通過 Turnstile 之後才算)", async () => {
  const f = makeFake({ rateLimit: { customer_submit_guest_shop: false } });
  const r = await call(f, req(guestBody()));
  assertEquals(r.body, { state: "rate_limited" });
  const shop = f.rpcCalls.find((c) => c.args.p_bucket === "customer_submit_guest_shop");
  assertEquals(shop?.args, { p_bucket: "customer_submit_guest_shop", p_key: "ip:203.0.113.9|slug:shop-cd0e4d", p_window_seconds: 86400, p_max: 5 });
  assertEquals(f.fetchCalls.length, 1);
  assertEquals(submitCall(f), undefined);
});

Deno.test("B02 會員:token 無效 / 不是客人帳號 ⇒ not_linked,不建單", async () => {
  const f1 = makeFake({ user: null });
  assertEquals((await call(f1, req(memberBody(), { Authorization: `Bearer ${USER_JWT}` }))).body, { state: "not_linked" });
  const f2 = makeFake({ user: { id: USER_ID, app_metadata: { account_type: "staff" } } });
  assertEquals((await call(f2, req(memberBody(), { Authorization: `Bearer ${USER_JWT}` }))).body, { state: "not_linked" });
  assertEquals(submitCall(f1), undefined);
  assertEquals(submitCall(f2), undefined);
});

Deno.test("B02 / F01 會員成功:p_user_id = token 的人、同意固定 true、草稿只留白名單;回應刪掉 _internal;推播用 skipInAppNotification + messageOverride", async () => {
  const f = makeFake();
  const r = await call(f, req({ ...memberBody(), draft: draft({ final_amount: 0, status: "accepted", member_id: "x", user_id: "y" }) }, { Authorization: `Bearer ${USER_JWT}` }));
  assertEquals(r.status, 200);
  assertEquals(r.body, CREATED);
  const args = submitCall(f)!.args;
  assertEquals(args.p_user_id, USER_ID);
  assertEquals(args.p_guest_phone, null);
  assertEquals(args.p_agree_policy, true);
  assertEquals(args.p_submission_id, SUB_ID);
  assertEquals(args.p_draft, {
    items: [{ service_item_id: ITEM, quantity: 2 }], staff_id: STAFF, date: "2026-10-13", time: "10:00",
    name: "王小明NAME_SENTINEL", address: "台北市ADDRESS_SENTINEL", notes: "NOTES_SENTINEL",
  });
  assertEquals(f.fetchCalls.length, 0);
  assertEquals(f.pushCalls, [{
    merchantId: "m-1", bookingId: "b-1", eventType: "booking_created", skipInAppNotification: true,
    messageOverride: { title: "新的線上預約（待確認）", body: "客人「王小明」…" },
  }]);
});

Deno.test("B02 重送(replayed)⇒ 回原結果但不再發推播;推播丟錯 ⇒ 仍回 200", async () => {
  const f = makeFake({ submit: { data: { ...CREATED, _internal: { replayed: true } }, error: null } });
  const r = await call(f, req(memberBody(), { Authorization: `Bearer ${USER_JWT}` }));
  assertEquals(r.body, CREATED);
  assertEquals(f.pushCalls.length, 0);
  const f2 = makeFake({ pushThrows: true });
  const r2 = await call(f2, req(memberBody(), { Authorization: `Bearer ${USER_JWT}` }));
  assertEquals(r2.status, 200);
  assertEquals(r2.body.state, "created");
});

Deno.test("B02 業務 state 原樣回傳(slot_taken 不發推播)", async () => {
  const f = makeFake({ submit: { data: { state: "slot_taken" }, error: null } });
  const r = await call(f, req(guestBody()));
  assertEquals(r.body, { state: "slot_taken" });
  assertEquals(f.pushCalls.length, 0);
});

Deno.test("B03 訪客成功:siteverify 帶 secret / token / remoteip / idempotency_key;p_user_id null", async () => {
  const f = makeFake();
  const r = await call(f, req(guestBody()));
  assertEquals(r.body, CREATED);
  assertEquals(f.fetchCalls.length, 1);
  assertEquals(f.fetchCalls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  const form = new URLSearchParams(f.fetchCalls[0].body);
  assertEquals(form.get("secret"), PROD_SECRET);
  assertEquals(form.get("response"), TURNSTILE_TOKEN);
  assertEquals(form.get("remoteip"), "203.0.113.9");
  assertEquals(form.get("idempotency_key"), SUB_ID);
  const args = submitCall(f)!.args;
  assertEquals(args.p_user_id, null);
  assertEquals(args.p_guest_phone, "0912-345-678");
  assertEquals(args.p_agree_policy, true);
  assertEquals(args.p_slug, "shop-cd0e4d");
});

Deno.test("F02 訪客四種失敗都不建單:沒 token、success=false、action 不對、hostname 不對(+ 連線失敗)", async () => {
  const cases: [Record<string, unknown>, Parameters<typeof makeFake>[0]][] = [
    [{ turnstile_token: undefined }, {}],
    [{}, { siteverify: { success: false, "error-codes": ["timeout-or-duplicate"] } }],
    [{}, { siteverify: { success: true, action: "other", hostname: "miao-yue-dispatch.vercel.app" } }],
    [{}, { siteverify: { success: true, action: "guest_booking", hostname: "evil.example" } }],
    [{}, { siteverify: "network_error" }],
  ];
  for (const [g, o] of cases) {
    const f = makeFake(o);
    const r = await call(f, req(guestBody(g)));
    assertEquals(r.body, { state: "bot_check_failed" });
    assertEquals(submitCall(f), undefined);
  }
});

Deno.test("B03 沒設定 TURNSTILE_SECRET_KEY ⇒ guest_unavailable(不可以放行)", async () => {
  const f = makeFake({ env: { TURNSTILE_SECRET_KEY: undefined } });
  assertEquals((await call(f, req(guestBody()))).body, { state: "guest_unavailable" });
  assertEquals(submitCall(f), undefined);
});

Deno.test("B03 正式環境設成官方測試 secret ⇒ 一律失敗 + 警告;本機 + 測試 secret ⇒ 只看 success", async () => {
  assert(isTurnstileTestSecret("1x0000000000000000000000000000000AA"));
  assert(isTurnstileTestSecret("2x0000000000000000000000000000000AA"));
  assert(!isTurnstileTestSecret(PROD_SECRET));
  const f = makeFake({ env: { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" } });
  assertEquals((await call(f, req(guestBody()))).body, { state: "bot_check_failed" });
  assertEquals(f.fetchCalls.length, 0);
  assert(f.logs.some((l) => l.includes("測試 secret")));
  const local = makeFake({
    env: { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", SUPABASE_URL: "http://kong:8000", PUBLIC_SITE_URL: "http://127.0.0.1:5191" },
    siteverify: { success: true, action: "test", hostname: "example.com" },
  });
  assertEquals((await call(local, req(guestBody()))).body.state, "created");
});

Deno.test("B02 資料庫輸入錯誤 ⇒ 400 + hint;其他錯誤 ⇒ 500(不帶原文)", async () => {
  const f = makeFake({ submit: { data: null, error: { code: "22023", hint: "invalid_phone", message: "電話格式不正確。" } } });
  const r = await call(f, req(guestBody()));
  assertEquals(r.status, 400);
  assertEquals(r.body, { state: "invalid_request", hint: "invalid_phone" });
  const f2 = makeFake({ submit: { data: null, error: { code: "XX000", message: "內部錯誤 SECRET_DB_DETAIL" } } });
  const r2 = await call(f2, req(guestBody()));
  assertEquals(r2.status, 500);
  assertEquals(r2.body, { state: "server_error" });
  assert(!f2.logs.join("\n").includes("SECRET_DB_DETAIL"));
});

Deno.test("F06 log 不印 token、secret、完整電話、姓名、地址、備註", async () => {
  const runs = [
    makeFake(),
    makeFake({ siteverify: { success: false } }),
    makeFake({ submit: { data: null, error: { code: "22023", hint: "invalid_phone" } } }),
  ];
  for (const f of runs) await call(f, req(guestBody()));
  const m = makeFake();
  await call(m, req(memberBody(), { Authorization: `Bearer ${USER_JWT}` }));
  const all = [...runs, m].flatMap((f) => f.logs).join("\n");
  for (const s of [TURNSTILE_TOKEN, PROD_SECRET, "SIG_SENTINEL", "0912-345-678", "0912345678", "NAME_SENTINEL", "ADDRESS_SENTINEL", "NOTES_SENTINEL"]) {
    assert(!all.includes(s), `log 不應包含 ${s}`);
  }
  assert(all.includes("***678"), "電話只印末 3 碼");
});
