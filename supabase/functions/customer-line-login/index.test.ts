// customer-line-login 單元測試(npm run test:edge)
// 規格 C2-B01、B03、C02、F01、F03、F04、F08、F09。
// 做法:handleRequest(req, deps) 注入假的資料庫(用記憶體模擬 internal_* RPC 的語意)、假的 Auth admin、假的 LINE 端點。
// id_token 由測試自己用 Web Crypto 獨立簽章(已知答案測試),被測程式負責驗章。
import { assert, assertEquals } from "jsr:@std/assert";
import {
  base64UrlEncode,
  clientIp,
  handleRequest,
  sha256Hex,
  pkceChallenge,
  validateDraft,
  type HandleRequestDeps,
} from "./index.ts";

// 測試用 Channel Secret 只用哨兵字串(不是任何真的 secret)。
const SECRET = "SENTINELSECRET0123456789abcdef01";
const OTHER_SECRET = "SENTINELWRONG00000000000000000ab";
const CHANNEL = "1234567890";
const SITE = "https://miao-yue-dispatch.vercel.app";
const SLUG = "pgtest-shop";
const MERCHANT = "11111111-1111-4111-8111-111111111111";
const NOW_MS = Date.UTC(2026, 9, 8, 4, 0, 0);
const CODE = "SENTINELAUTHCODE123";
const ACCESS = "SENTINELACCESSTOKEN456";
const TOKEN_HASH = "SENTINELTOKENHASH789";

const DRAFT = {
  items: [{ service_item_id: "22222222-2222-4222-8222-222222222222", quantity: 2 }],
  staff_id: null,
  date: "2026-10-20",
  time: "10:30",
  name: "王小明",
  address: "台北市測試路 1 號",
  notes: "請按電鈴",
};

// -------------------------------------------------------------------------
// 共用:log 與回應收集(F01 / F09 全文搜尋用)
// -------------------------------------------------------------------------
const ALL_LOGS: string[] = [];
const ALL_BODIES: string[] = [];

interface Attempt {
  merchant_id: string;
  channel_id: string;
  nonce: string;
  code_verifier: string;
  draft: unknown;
  ip_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface World {
  now: number;
  merchantAvailable: boolean;
  config: { channel_id: string; channel_secret: string; enabled: boolean; merchant_active: boolean } | null;
  attempts: Map<string, Attempt>;
  identities: Map<string, { user_id: string; email: string; name: string | null; picture: string | null }>;
  users: Map<string, { email: string; app_metadata: Record<string, unknown> }>;
  succeeded: { merchant_id: string; channel_id: string; status: string }[];
  deletedUsers: string[];
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  fetchCalls: { url: string; init?: RequestInit }[];
  tokenResponse: (body: URLSearchParams) => Promise<Response> | Response;
  friendship: () => Promise<Response> | Response;
  upsertOverride?: (args: Record<string, unknown>) => { user_id: string; email: string } | null;
  env: Record<string, string>;
  rand: number;
}

function newWorld(): World {
  return {
    now: NOW_MS,
    merchantAvailable: true,
    config: { channel_id: CHANNEL, channel_secret: SECRET, enabled: true, merchant_active: true },
    attempts: new Map(),
    identities: new Map(),
    users: new Map(),
    succeeded: [],
    deletedUsers: [],
    rpcCalls: [],
    fetchCalls: [],
    tokenResponse: () => new Response("{}", { status: 500 }),
    friendship: () => new Response(JSON.stringify({ friendFlag: true }), { status: 200 }),
    env: { SUPABASE_URL: "https://abcdefgh.supabase.co", PUBLIC_SITE_URL: SITE },
    rand: 0,
  };
}

function makeDeps(w: World): HandleRequestDeps {
  const log = (...args: unknown[]) => ALL_LOGS.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  return {
    env: (k) => w.env[k],
    now: () => w.now,
    randomBytes: (n) => {
      w.rand += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (w.rand * 31 + i * 7) & 0xff;
      return out;
    },
    randomUUID: () => {
      w.rand += 1;
      return `00000000-0000-4000-8000-${String(w.rand).padStart(12, "0")}`;
    },
    log: { info: log, warn: log, error: log },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      w.fetchCalls.push({ url, init });
      if (url.endsWith("/oauth2/v2.1/token")) return await w.tokenResponse(new URLSearchParams(String(init?.body ?? "")));
      if (url.endsWith("/friendship/v1/status")) return await w.friendship();
      return new Response("not found", { status: 404 });
    },
    authAdmin: {
      createUser: async (attrs) => {
        const id = `aaaaaaaa-0000-4000-8000-${String(w.users.size + 1).padStart(12, "0")}`;
        w.users.set(id, { email: attrs.email, app_metadata: attrs.app_metadata });
        return { data: { user: { id } }, error: null };
      },
      deleteUser: async (id) => {
        w.deletedUsers.push(id);
        w.users.delete(id);
        return { error: null };
      },
      generateLink: async (p) => {
        const exists = [...w.users.values()].some((u) => u.email === p.email);
        return exists ? { data: { properties: { hashed_token: TOKEN_HASH } }, error: null } : { data: null, error: { message: "no user" } };
      },
    },
    db: {
      rpc: async (fn, args) => {
        w.rpcCalls.push({ fn, args });
        switch (fn) {
          case "internal_customer_line_login_start": {
            if (args.p_slug !== SLUG || !w.merchantAvailable || !w.config || !w.config.enabled) {
              return { data: { status: "line_login_unavailable" }, error: null };
            }
            const recent = [...w.attempts.values()].filter((a) => a.ip_hash === args.p_ip_hash && a.created_at > w.now - 600_000).length;
            if (recent >= 30) return { data: { status: "rate_limited" }, error: null };
            w.attempts.set(String(args.p_state_hash), {
              merchant_id: MERCHANT, channel_id: w.config.channel_id, nonce: String(args.p_nonce),
              code_verifier: String(args.p_code_verifier), draft: args.p_draft, ip_hash: String(args.p_ip_hash),
              created_at: w.now, expires_at: w.now + 600_000, consumed_at: null,
            });
            return { data: { status: "ok", channel_id: w.config.channel_id }, error: null };
          }
          case "internal_customer_line_login_consume": {
            const a = w.attempts.get(String(args.p_state_hash));
            if (!a) return { data: { status: "login_expired" }, error: null };
            if (a.consumed_at !== null) return { data: { status: "login_expired", slug: SLUG }, error: null };
            const draft = a.draft;
            a.consumed_at = w.now;
            a.draft = null;
            if (a.expires_at <= w.now) return { data: { status: "login_expired", slug: SLUG }, error: null };
            return {
              data: { status: "ok", merchant_id: a.merchant_id, slug: SLUG, channel_id: a.channel_id, nonce: a.nonce, code_verifier: a.code_verifier, draft },
              error: null,
            };
          }
          case "internal_get_line_login_credentials":
            return { data: w.config, error: null };
          case "internal_customer_line_identity_find": {
            const i = w.identities.get(`${args.p_channel_id}|${args.p_sub}`);
            return { data: i ? { user_id: i.user_id, email: i.email } : null, error: null };
          }
          case "internal_customer_line_identity_upsert": {
            if (w.upsertOverride) return { data: w.upsertOverride(args), error: null };
            const key = `${args.p_channel_id}|${args.p_sub}`;
            const prev = w.identities.get(key);
            const userId = prev?.user_id ?? String(args.p_user_id);
            const email = w.users.get(userId)?.email ?? "";
            w.identities.set(key, { user_id: userId, email, name: (args.p_display_name as string) ?? null, picture: (args.p_picture_url as string) ?? null });
            return { data: { user_id: userId, email }, error: null };
          }
          case "internal_customer_line_login_succeeded":
            w.succeeded.push({ merchant_id: String(args.p_merchant_id), channel_id: String(args.p_channel_id), status: String(args.p_linked_oa_status) });
            return { data: null, error: null };
          case "internal_set_line_friendship":
            return { data: true, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    },
  };
}

async function call(w: World, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const req = new Request("http://localhost/functions/v1/customer-line-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleRequest(req, makeDeps(w));
  const text = await res.clone().text();
  ALL_BODIES.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : {}, res };
}

async function signIdToken(payload: Record<string, unknown>, opts: { secret?: string; alg?: string } = {}): Promise<string> {
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: opts.alg ?? "HS256", typ: "JWT" });
  const body = enc(payload);
  if ((opts.alg ?? "HS256") === "none") return `${head}.${body}.`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(opts.secret ?? SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${base64UrlEncode(sig)}`;
}

function goodClaims(nonce: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const nowS = Math.floor(NOW_MS / 1000);
  return {
    iss: "https://access.line.me", sub: "U0123456789abcdefSENTINELSUB", aud: CHANNEL,
    exp: nowS + 3600, iat: nowS - 5, nonce, name: "LINE 王", picture: "https://profile.line-scdn.net/abc", ...over,
  };
}

/** 跑一次 start,回傳 state 與 DB 裡存的 nonce / verifier。 */
async function startFlow(w: World) {
  const r = await call(w, { action: "start", slug: SLUG, draft: DRAFT });
  assertEquals(r.json.status, "ok");
  const u = new URL(String(r.json.authorize_url));
  const state = u.searchParams.get("state")!;
  const attempt = w.attempts.get(await sha256Hex(state))!;
  return { state, attempt, url: u };
}

function tokenOk(idTokenFactory: () => Promise<string>) {
  return async (body: URLSearchParams) => {
    if (body.get("code") !== CODE) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ access_token: ACCESS, id_token: await idTokenFactory(), token_type: "Bearer" }), { status: 200 });
  };
}

// =========================================================================
// start
// =========================================================================
Deno.test("B01-1 start:授權網址每個參數都正確,state 在資料庫只存雜湊", async () => {
  const w = newWorld();
  const { state, attempt, url } = await startFlow(w);
  assertEquals(url.origin + url.pathname, "https://access.line.me/oauth2/v2.1/authorize");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("client_id"), CHANNEL);
  assertEquals(url.searchParams.get("redirect_uri"), `${SITE}/auth/line/callback`);
  assertEquals(url.searchParams.get("scope"), "openid profile");
  assertEquals(url.searchParams.get("bot_prompt"), "normal");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("nonce"), attempt.nonce);
  assertEquals(url.searchParams.get("code_challenge"), await pkceChallenge(attempt.code_verifier));
  assert(attempt.code_verifier.length >= 43 && attempt.code_verifier.length <= 128, "verifier 長度 43~128");
  assert(state.length >= 43, "state 至少 32 bytes");
  const stored = JSON.stringify([...w.attempts.entries()]);
  assert(!stored.includes(state), "資料庫裡不能有 state 原文");
  assertEquals(attempt.draft, DRAFT);
});

Deno.test("B01-2 start:停用 / 不存在 / 未啟用一律 line_login_unavailable", async () => {
  const w1 = newWorld();
  const a = await call(w1, { action: "start", slug: "nope", draft: DRAFT });
  const w2 = newWorld();
  w2.merchantAvailable = false;
  const b = await call(w2, { action: "start", slug: SLUG, draft: DRAFT });
  const w3 = newWorld();
  w3.config!.enabled = false;
  const c = await call(w3, { action: "start", slug: SLUG, draft: DRAFT });
  assertEquals([a.json, b.json, c.json], [{ status: "line_login_unavailable" }, { status: "line_login_unavailable" }, { status: "line_login_unavailable" }]);
});

Deno.test("B01-3 start:同一 IP 10 分鐘第 31 次 ⇒ rate_limited", async () => {
  const w = newWorld();
  for (let i = 0; i < 30; i++) assertEquals((await call(w, { action: "start", slug: SLUG, draft: DRAFT })).json.status, "ok");
  assertEquals((await call(w, { action: "start", slug: SLUG, draft: DRAFT })).json.status, "rate_limited");
  // 換一個 IP 不受影響
  assertEquals((await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { "x-forwarded-for": "198.51.100.1" })).json.status, "ok");
});

Deno.test("B01-5 頻率限制:偽造 X-Forwarded-For 第一段繞不過去(取最後一段)", async () => {
  const w = newWorld();
  for (let i = 0; i < 30; i++) {
    const r = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` });
    assertEquals(r.json.status, "ok");
  }
  const r = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { "x-forwarded-for": "10.9.9.9, 203.0.113.9" });
  assertEquals(r.json.status, "rate_limited");
});

Deno.test("B01-6 頻率限制:有 cf-connecting-ip 時一律用它(XFF 怎麼換都一樣)", async () => {
  const w = newWorld();
  for (let i = 0; i < 30; i++) {
    await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": `10.1.0.${i}` });
  }
  const r = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "172.16.0.1" });
  assertEquals(r.json.status, "rate_limited");
});

Deno.test("B01-7 clientIp:串接值取最後一段、cf 優先、x-real-ip 不讀、什麼都沒有 = unknown", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost/x", { method: "POST", headers: h });
  assertEquals(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2 , 3.3.3.3" })), "3.3.3.3");
  assertEquals(clientIp(req({ "x-forwarded-for": "1.1.1.1,, " })), "1.1.1.1");
  assertEquals(clientIp(req({ "x-forwarded-for": "9.9.9.9", "cf-connecting-ip": " 4.4.4.4 " })), "4.4.4.4");
  assertEquals(clientIp(req({ "x-real-ip": "5.5.5.5" })), "unknown");
  assertEquals(clientIp(req({})), "unknown");
});

Deno.test("B01-8 頻率限制:完全沒有 IP 標頭的請求共用一個額度", async () => {
  const w = newWorld();
  const noIp = async () => {
    const req = new Request("http://localhost/functions/v1/customer-line-login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", slug: SLUG, draft: DRAFT }),
    });
    const res = await handleRequest(req, makeDeps(w));
    const text = await res.text();
    ALL_BODIES.push(text);
    return JSON.parse(text).status;
  };
  for (let i = 0; i < 30; i++) assertEquals(await noIp(), "ok");
  assertEquals(await noIp(), "rate_limited");
});

Deno.test("B01-4 start:草稿格式 / 長度檢查", async () => {
  const w = newWorld();
  const bad = [
    { ...DRAFT, name: "" },
    { ...DRAFT, name: "名".repeat(51) },
    { ...DRAFT, address: "址".repeat(201) },
    { ...DRAFT, notes: "備".repeat(501) },
    { ...DRAFT, items: [] },
    { ...DRAFT, items: Array.from({ length: 51 }, () => DRAFT.items[0]) },
    { ...DRAFT, items: [{ service_item_id: "not-a-uuid", quantity: 1 }] },
    { ...DRAFT, staff_id: "x" },
    { ...DRAFT, date: "2026/10/20" },
    { ...DRAFT, time: "25:00" },
    "string-draft",
  ];
  for (const d of bad) {
    const r = await call(w, { action: "start", slug: SLUG, draft: d });
    assertEquals([r.status, r.json.status], [400, "invalid_draft"], JSON.stringify(d).slice(0, 60));
  }
  assertEquals(w.attempts.size, 0);
  assertEquals(validateDraft({ ...DRAFT, address: "  ", notes: undefined })?.address, null);
});

Deno.test("F04-1 start:多塞 return_to 不影響回應,也不會存進草稿", async () => {
  const w = newWorld();
  const r = await call(w, { action: "start", slug: SLUG, draft: { ...DRAFT, return_to: "https://evil.example" }, return_to: "https://evil.example", redirect_uri: "https://evil.example/cb" });
  assertEquals(r.json.status, "ok");
  assert(!JSON.stringify(r.json).includes("evil"), "回應不能有 evil");
  assert(!JSON.stringify([...w.attempts.values()]).includes("evil"), "草稿不能有 evil");
  assertEquals(new URL(String(r.json.authorize_url)).searchParams.get("redirect_uri"), `${SITE}/auth/line/callback`);
});

Deno.test("CORS:別的網域 403;網站網域與本機開發網址放行", async () => {
  const w = newWorld();
  const evil = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { Origin: "https://evil.example" });
  assertEquals([evil.status, evil.res.headers.get("Access-Control-Allow-Origin")], [403, null]);
  const site = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { Origin: SITE });
  assertEquals([site.status, site.res.headers.get("Access-Control-Allow-Origin")], [200, SITE]);
  const local = await call(w, { action: "start", slug: SLUG, draft: DRAFT }, { Origin: "http://127.0.0.1:8080" });
  assertEquals(local.res.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:8080");
});

Deno.test("設定:缺 PUBLIC_SITE_URL ⇒ server_error;不明 action ⇒ invalid_request", async () => {
  const w = newWorld();
  delete w.env.PUBLIC_SITE_URL;
  assertEquals((await call(w, { action: "start", slug: SLUG, draft: DRAFT })).json.status, "server_error");
  const w2 = newWorld();
  assertEquals((await call(w2, { action: "hack" })).status, 400);
  assertEquals((await call(w2, "not json")).status, 400);
});

// =========================================================================
// complete
// =========================================================================
Deno.test("B03-1 complete 成功:建客戶帳號(app_metadata customer、不可能收信的 email)→ token_hash + 原封不動的草稿", async () => {
  const w = newWorld();
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
  const r = await call(w, { action: "complete", state, code: CODE });
  assertEquals(r.json, { status: "ok", slug: SLUG, draft: DRAFT, token_hash: TOKEN_HASH, verify_type: "email" });
  const users = [...w.users.values()];
  assertEquals(users.length, 1);
  assertEquals(users[0].app_metadata, { account_type: "customer" });
  assert(/^line-[0-9a-f-]+@customer\.miaoyue\.invalid$/.test(users[0].email), users[0].email);
  assertEquals(w.succeeded, [{ merchant_id: MERCHANT, channel_id: CHANNEL, status: "ok" }]);
  // token 交換帶了 PKCE verifier 與同一個 redirect_uri
  const tokenCall = w.fetchCalls.find((c) => c.url.endsWith("/oauth2/v2.1/token"))!;
  const sent = new URLSearchParams(String(tokenCall.init?.body));
  assertEquals([sent.get("code_verifier"), sent.get("redirect_uri"), sent.get("client_id"), sent.get("grant_type")],
    [attempt.code_verifier, `${SITE}/auth/line/callback`, CHANNEL, "authorization_code"]);
  // 草稿已從資料庫清掉
  assertEquals(attempt.draft, null);
});

Deno.test("C02-1 同一個 channel + sub 第二次登入拿到同一個帳號;不同 channel 同一 sub 是不同帳號", async () => {
  const w = newWorld();
  for (let i = 0; i < 2; i++) {
    const { state, attempt } = await startFlow(w);
    w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
    assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
  }
  assertEquals(w.users.size, 1);
  w.config = { ...w.config!, channel_id: "9999999999" };
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce, { aud: "9999999999" })));
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
  assertEquals(w.users.size, 2);
});

Deno.test("C02-2 同時登入兩次(upsert 回別的帳號)⇒ 刪掉自己剛建的多餘帳號", async () => {
  const w = newWorld();
  w.users.set("bbbbbbbb-0000-4000-8000-000000000001", { email: "line-existing@customer.miaoyue.invalid", app_metadata: { account_type: "customer" } });
  w.upsertOverride = () => ({ user_id: "bbbbbbbb-0000-4000-8000-000000000001", email: "line-existing@customer.miaoyue.invalid" });
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
  assertEquals(w.deletedUsers, ["aaaaaaaa-0000-4000-8000-000000000002"]);
});

Deno.test("B03-2 id_token 驗證:簽章錯 / alg none / RS256 / iss / aud / 過期 / iat 未來 / nonce / sub 空 全部 line_error", async () => {
  const cases: [string, (nonce: string) => Promise<string>][] = [
    ["簽章錯", (n) => signIdToken(goodClaims(n), { secret: OTHER_SECRET })],
    ["alg none", (n) => signIdToken(goodClaims(n), { alg: "none" })],
    // alg 混淆:header 寫別的演算法,但簽章仍是用 Channel Secret 算的「正確」HMAC ⇒ 只有 alg 檢查擋得住
    ["alg RS256(HMAC 簽章正確)", (n) => signIdToken(goodClaims(n), { alg: "RS256" })],
    ["alg HS512(HMAC 簽章正確)", (n) => signIdToken(goodClaims(n), { alg: "HS512" })],
    ["iss", (n) => signIdToken(goodClaims(n, { iss: "https://evil.example" }))],
    ["aud", (n) => signIdToken(goodClaims(n, { aud: "0000000000" }))],
    ["exp", (n) => signIdToken(goodClaims(n, { exp: Math.floor(NOW_MS / 1000) - 1 }))],
    ["iat", (n) => signIdToken(goodClaims(n, { iat: Math.floor(NOW_MS / 1000) + 120 }))],
    ["nonce", () => signIdToken(goodClaims("wrong-nonce"))],
    ["sub", (n) => signIdToken(goodClaims(n, { sub: "" }))],
    ["亂碼", async () => "not.a.jwt"],
  ];
  for (const [label, make] of cases) {
    const w = newWorld();
    const { state, attempt } = await startFlow(w);
    w.tokenResponse = tokenOk(() => make(attempt.nonce));
    const r = await call(w, { action: "complete", state, code: CODE });
    assertEquals(r.json, { status: "line_error", slug: SLUG, draft: DRAFT }, label);
    assertEquals(w.users.size, 0, `${label}:不能建帳號`);
  }
});

Deno.test("B03-3 state 重複使用 / 過期 ⇒ login_expired + slug;不存在 ⇒ login_expired 不帶 slug", async () => {
  const w = newWorld();
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
  // 用過 / 過期:那一列還在 ⇒ 帶 slug(前端可以顯示「回店家首頁」);偽造的 state ⇒ 不帶 slug
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json, { status: "login_expired", slug: SLUG });
  assertEquals((await call(w, { action: "complete", state: "x".repeat(43), code: CODE })).json, { status: "login_expired" });
  const s2 = await startFlow(w);
  w.now += 600_001;
  assertEquals((await call(w, { action: "complete", state: s2.state, code: CODE })).json, { status: "login_expired", slug: SLUG });
});

Deno.test("B03-4 商家中途改了 Channel ID / 停用 ⇒ login_expired(不打 LINE)", async () => {
  const w = newWorld();
  const { state } = await startFlow(w);
  w.config = { ...w.config!, channel_id: "5555555555" };
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json, { status: "login_expired", slug: SLUG });
  const w2 = newWorld();
  const s2 = await startFlow(w2);
  w2.config!.enabled = false;
  assertEquals((await call(w2, { action: "complete", state: s2.state, code: CODE })).json, { status: "login_expired", slug: SLUG });
  assertEquals(w.fetchCalls.length + w2.fetchCalls.length, 0);
});

Deno.test("B03-5 LINE token 端點失敗 / 連線失敗 / 沒有 id_token ⇒ line_error(草稿還給前端)", async () => {
  for (const make of [
    () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "SENTINEL_LINE_RAW_ERROR" }), { status: 400 }),
    () => { throw new Error("SENTINEL_NETWORK_ERROR"); },
    () => new Response(JSON.stringify({ access_token: ACCESS }), { status: 200 }),
  ]) {
    const w = newWorld();
    const { state } = await startFlow(w);
    w.tokenResponse = make as () => Response;
    const r = await call(w, { action: "complete", state, code: CODE });
    assertEquals(r.json, { status: "line_error", slug: SLUG, draft: DRAFT });
  }
});

Deno.test("B03-6 客人在 LINE 按取消 ⇒ cancelled + 草稿;state 已用掉", async () => {
  const w = newWorld();
  const { state } = await startFlow(w);
  const r = await call(w, { action: "complete", state, error: "ACCESS_DENIED" });
  assertEquals(r.json, { status: "cancelled", slug: SLUG, draft: DRAFT });
  assertEquals(w.fetchCalls.length, 0);
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json, { status: "login_expired", slug: SLUG });
});

Deno.test("B03-7 好友狀態:403 ⇒ not_linked;連線失敗 ⇒ unknown;都不影響登入", async () => {
  for (const [make, expected] of [
    [() => new Response("{}", { status: 403 }), "not_linked"],
    [() => { throw new Error("x"); }, "unknown"],
    [() => new Response("{}", { status: 500 }), "unknown"],
  ] as [() => Response, string][]) {
    const w = newWorld();
    const { state, attempt } = await startFlow(w);
    w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
    w.friendship = make;
    assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
    assertEquals(w.succeeded[0].status, expected);
  }
});

Deno.test("C5-F02 登入時讀 friendFlag:true / false 寫好友狀態;缺欄位 / 403 / 連線失敗不寫;都不影響登入", async () => {
  for (const [make, expected] of [
    [() => new Response(JSON.stringify({ friendFlag: true }), { status: 200 }), true],
    [() => new Response(JSON.stringify({ friendFlag: false }), { status: 200 }), false],
    [() => new Response(JSON.stringify({}), { status: 200 }), null],
    [() => new Response("not json", { status: 200 }), null],
    [() => new Response("{}", { status: 403 }), null],
    [() => { throw new Error("x"); }, null],
  ] as [() => Response, boolean | null][]) {
    const w = newWorld();
    const { state, attempt } = await startFlow(w);
    w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
    w.friendship = make;
    assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
    const calls = w.rpcCalls.filter((c) => c.fn === "internal_set_line_friendship");
    if (expected === null) {
      assertEquals(calls.length, 0);
    } else {
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args.p_is_friend, expected);
      assertEquals(calls[0].args.p_merchant_id, MERCHANT);
      assertEquals(calls[0].args.p_line_user_id, "U0123456789abcdefSENTINELSUB");
      assertEquals(calls[0].args.p_source, "login");
      assertEquals(calls[0].args.p_changed_at, new Date(NOW_MS).toISOString());
    }
  }
});

Deno.test("C5-F02-2 記好友狀態失敗 ⇒ 登入照樣成功", async () => {
  const w = newWorld();
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
  const d = makeDeps(w);
  const orig = d.db.rpc;
  d.db.rpc = (fn, args) => fn === "internal_set_line_friendship" ? Promise.resolve({ data: null, error: { message: "boom" } }) : orig(fn, args);
  const req = new Request("http://localhost/functions/v1/customer-line-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ action: "complete", state, code: CODE }),
  });
  assertEquals((await (await handleRequest(req, d)).json()).status, "ok");
});

Deno.test("B03-8 頭像只收 https:非 https 的 picture 不寫進資料庫", async () => {
  const w = newWorld();
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce, { picture: "javascript:alert(1)" })));
  assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
  const up = w.rpcCalls.find((c) => c.fn === "internal_customer_line_identity_upsert")!;
  assertEquals(up.args.p_picture_url, null);
});

// =========================================================================
// F08 假端點只能在本機
// =========================================================================
Deno.test("F08-1 LINE_MOCK_MODE=1 但 SUPABASE_URL 是正式網址 ⇒ 仍用官方端點並寫警告", async () => {
  const w = newWorld();
  w.env.LINE_MOCK_MODE = "1";
  w.env.LINE_MOCK_AUTHORIZE_URL = "http://127.0.0.1:9999/oauth2/v2.1/authorize";
  w.env.LINE_MOCK_API_BASE = "http://127.0.0.1:9999";
  const before = ALL_LOGS.length;
  const { url, state, attempt } = await startFlow(w);
  assertEquals(url.origin, "https://access.line.me");
  assert(ALL_LOGS.slice(before).some((l) => l.includes("LINE_MOCK_MODE 在非本機環境被忽略")));
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
  await call(w, { action: "complete", state, code: CODE });
  assert(w.fetchCalls.every((c) => c.url.startsWith("https://api.line.me/")), "token / 好友都打官方網址");
});

Deno.test("F08-2 本機(127.0.0.1 / kong)+ LINE_MOCK_MODE=1 ⇒ 用假端點", async () => {
  for (const sb of ["http://127.0.0.1:55321", "http://kong:8000"]) {
    const w = newWorld();
    w.env.SUPABASE_URL = sb;
    w.env.LINE_MOCK_MODE = "1";
    w.env.LINE_MOCK_AUTHORIZE_URL = "http://127.0.0.1:9999/oauth2/v2.1/authorize";
    w.env.LINE_MOCK_API_BASE = "http://127.0.0.1:9999";
    const { url, state, attempt } = await startFlow(w);
    assertEquals(url.origin, "http://127.0.0.1:9999");
    w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce)));
    assertEquals((await call(w, { action: "complete", state, code: CODE })).json.status, "ok");
    assert(w.fetchCalls.every((c) => c.url.startsWith("http://127.0.0.1:9999/")));
  }
});

// =========================================================================
// F01 / F09:所有回應與 log 全文搜尋(放最後,前面每一個測試的輸出都收集在 ALL_*)
// =========================================================================
Deno.test("F01-1 / F09-1 所有回應與 log 都搜不到 secret / 授權碼 / token / LINE 原始錯誤", async () => {
  // 再跑一次成功與失敗,確保兩種路徑都有被收集
  const w = newWorld();
  const { state, attempt } = await startFlow(w);
  w.tokenResponse = tokenOk(() => signIdToken(goodClaims(attempt.nonce), { secret: OTHER_SECRET }));
  await call(w, { action: "complete", state, code: CODE });
  const haystack = ALL_BODIES.join("\n") + "\n" + ALL_LOGS.join("\n");
  assert(ALL_BODIES.length > 50 && ALL_LOGS.length > 0, "有收集到東西");
  for (const needle of [SECRET, OTHER_SECRET, CODE, ACCESS, "SENTINEL_LINE_RAW_ERROR", "SENTINEL_NETWORK_ERROR", "U0123456789abcdefSENTINELSUB", attempt.code_verifier]) {
    assert(!haystack.includes(needle), `不能出現:${needle}`);
  }
  const logs = ALL_LOGS.join("\n");
  assert(!logs.includes(TOKEN_HASH), "log 不能有 token_hash");
});
