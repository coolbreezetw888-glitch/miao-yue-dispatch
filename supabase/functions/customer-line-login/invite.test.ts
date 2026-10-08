// 客戶端第 4-B 批 C4-H06 / C4-F04 / C4-F05:customer-line-login 的 purpose:'invite'(聯絡人邀請連結)。
// 既有 index.test.ts / join.test.ts 全部照舊通過;這裡只測新增的行為。
import { assertEquals } from "jsr:@std/assert";
import { base64UrlEncode, handleRequest, sha256Hex, type HandleRequestDeps } from "./index.ts";

const SITE = "https://miao-yue-dispatch.vercel.app";
const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const NOW = 1_800_000_000_000;
const TOKEN = "INVITEtokenSENTINEL_abcdefghijklmn"; // 34 碼,符合邀請碼格式
const TOKEN_HASH_PROMISE = sha256Hex(TOKEN);

function makeDeps(overrides: Partial<Record<string, unknown>> = {}, rpcErrors: Record<string, boolean> = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const logger = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const deps: HandleRequestDeps = {
    env: (k) => ({ PUBLIC_SITE_URL: SITE, SUPABASE_URL: "https://x.supabase.co" } as Record<string, string>)[k],
    db: {
      rpc(fn, args) {
        rpcCalls.push({ fn, args });
        if (rpcErrors[fn]) return Promise.resolve({ data: null, error: { message: "boom" } });
        const table: Record<string, unknown> = {
          internal_customer_line_login_start: { status: "ok", channel_id: CHANNEL_ID },
          internal_customer_line_login_consume: {
            status: "ok", merchant_id: "m-1", slug: "shop-1", channel_id: CHANNEL_ID, nonce: "NONCE", code_verifier: "VERIFIER",
            draft: null, invite_token_hash: "a".repeat(64),
          },
          internal_get_line_login_credentials: { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET, enabled: true, merchant_active: true },
          internal_customer_line_identity_find: { user_id: "u-1", email: "line-1@customer.miaoyue.invalid" },
          internal_customer_line_identity_upsert: { user_id: "u-1", email: "line-1@customer.miaoyue.invalid" },
          internal_customer_line_login_succeeded: null,
          internal_customer_contact_invite_claim: { state: "valid" },
          ...(overrides as Record<string, unknown>),
        };
        return Promise.resolve({ data: table[fn] ?? null, error: null });
      },
    },
    authAdmin: {
      createUser: () => Promise.resolve({ data: null, error: "no" }),
      deleteUser: () => Promise.resolve({ error: null }),
      generateLink: () => Promise.resolve({ data: { properties: { hashed_token: "TOKEN_HASH" } }, error: null }),
    },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/v2.1/token")) {
        return new Response(JSON.stringify({ id_token: await signIdToken(), access_token: "AT" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    now: () => NOW,
    randomBytes: (n) => new Uint8Array(n).fill(7),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    log: { info: logger, warn: logger, error: logger },
  };
  return { deps, rpcCalls, logs };
}

async function signIdToken(): Promise<string> {
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ iss: "https://access.line.me", aud: CHANNEL_ID, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce: "NONCE", sub: "U-inv", name: "小李" });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${base64UrlEncode(sig)}`;
}

function post(body: unknown): Request {
  return new Request("https://x.supabase.co/functions/v1/customer-line-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify(body),
  });
}

Deno.test("C4-H06 start:purpose invite ⇒ 只把邀請碼雜湊傳給資料庫,草稿 null", async () => {
  const { deps, rpcCalls, logs } = makeDeps();
  const res = await handleRequest(post({ action: "start", slug: "shop-1", purpose: "invite", invite_token: TOKEN }), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.status, "ok");
  const args = rpcCalls.find((c) => c.fn === "internal_customer_line_login_start")?.args ?? {};
  assertEquals(args.p_draft, null);
  assertEquals(args.p_invite_token_hash, await TOKEN_HASH_PROMISE);
  assertEquals(JSON.stringify(rpcCalls).includes(TOKEN), false);
  assertEquals(JSON.stringify(body).includes(TOKEN), false);
  assertEquals(logs.join("\n").includes(TOKEN), false);
});

Deno.test("C4-H06 start:沒有 purpose invite 時不傳 p_invite_token_hash(第 2、3 批呼叫格式不變)", async () => {
  const { deps, rpcCalls } = makeDeps();
  await handleRequest(post({ action: "start", slug: "shop-1", purpose: "join" }), deps);
  const args = rpcCalls.find((c) => c.fn === "internal_customer_line_login_start")?.args ?? {};
  assertEquals("p_invite_token_hash" in args, false);
});

Deno.test("C4-H06 start:邀請碼格式不對 / 沒帶 / 同時帶草稿 ⇒ 400 invalid_request,不寫資料庫", async () => {
  for (const extra of [
    {},
    { invite_token: "short" },
    { invite_token: "x".repeat(129) },
    { invite_token: "含中文的邀請碼含中文的邀請碼含中文的邀請碼含中文的邀請碼" },
    { invite_token: 12345 },
    { invite_token: TOKEN, draft: { items: [] } },
  ]) {
    const { deps, rpcCalls } = makeDeps();
    const res = await handleRequest(post({ action: "start", slug: "shop-1", purpose: "invite", ...extra }), deps);
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { status: "invalid_request" });
    assertEquals(rpcCalls.length, 0);
  }
});

Deno.test("C4-H06 start:資料庫回 invalid_request ⇒ 400", async () => {
  const { deps } = makeDeps({ internal_customer_line_login_start: { status: "invalid_request" } });
  const res = await handleRequest(post({ action: "start", slug: "shop-1", purpose: "invite", invite_token: TOKEN }), deps);
  assertEquals(res.status, 400);
});

Deno.test("C4-H06 complete:邀請登入成功 ⇒ 保留邀請給這個帳號,回 purpose invite + invite valid", async () => {
  const { deps, rpcCalls } = makeDeps();
  const res = await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), deps);
  assertEquals(await res.json(), {
    status: "ok", slug: "shop-1", draft: null, purpose: "invite", invite: { state: "valid" }, token_hash: "TOKEN_HASH", verify_type: "email",
  });
  assertEquals(rpcCalls.find((c) => c.fn === "internal_customer_contact_invite_claim")?.args, {
    p_merchant_id: "m-1", p_user_id: "u-1", p_token_hash: "a".repeat(64),
  });
});

Deno.test("C4-H06 complete:邀請已失效 / 保留失敗 ⇒ invite invalid(登入照樣成功)", async () => {
  const a = makeDeps({ internal_customer_contact_invite_claim: { state: "invalid" } });
  const ra = await (await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), a.deps)).json();
  assertEquals([ra.status, ra.invite], ["ok", { state: "invalid" }]);
  const b = makeDeps({}, { internal_customer_contact_invite_claim: true });
  const rb = await (await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), b.deps)).json();
  assertEquals([rb.status, rb.invite], ["ok", { state: "invalid" }]);
});

Deno.test("C4-H06 complete:沒有邀請的登入 ⇒ 不呼叫保留、回應沒有 purpose / invite", async () => {
  const { deps, rpcCalls } = makeDeps({
    internal_customer_line_login_consume: {
      status: "ok", merchant_id: "m-1", slug: "shop-1", channel_id: CHANNEL_ID, nonce: "NONCE", code_verifier: "VERIFIER", draft: null,
    },
  });
  const res = await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), deps);
  assertEquals(await res.json(), { status: "ok", slug: "shop-1", draft: null, token_hash: "TOKEN_HASH", verify_type: "email" });
  assertEquals(rpcCalls.some((c) => c.fn === "internal_customer_contact_invite_claim"), false);
});

Deno.test("C4-H06 complete:邀請登入時客人在 LINE 取消 / LINE 錯誤 ⇒ 多 purpose invite", async () => {
  const a = makeDeps();
  assertEquals(await (await handleRequest(post({ action: "complete", state: "S".repeat(43), error: "access_denied" }), a.deps)).json(),
    { status: "cancelled", slug: "shop-1", draft: null, purpose: "invite" });
  const b = makeDeps();
  assertEquals(await (await handleRequest(post({ action: "complete", state: "S".repeat(43) }), b.deps)).json(),
    { status: "line_error", slug: "shop-1", draft: null, purpose: "invite" });
});

Deno.test("C4-H06 complete:暫存已用過 / 過期且是邀請登入 ⇒ login_expired + slug + purpose invite", async () => {
  const { deps } = makeDeps({ internal_customer_line_login_consume: { status: "login_expired", slug: "shop-1", purpose: "invite" } });
  assertEquals(await (await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), deps)).json(),
    { status: "login_expired", slug: "shop-1", purpose: "invite" });
});

Deno.test("C4-F05 log 不印邀請碼雜湊", async () => {
  const { deps, logs } = makeDeps({}, { internal_customer_contact_invite_claim: true });
  await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), deps);
  assertEquals(logs.join("\n").includes("a".repeat(64)), false);
  assertEquals(logs.length > 0, true);
});
