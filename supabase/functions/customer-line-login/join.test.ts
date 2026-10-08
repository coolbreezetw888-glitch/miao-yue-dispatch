// 客戶端第 3 批 C3-B04:customer-line-login 的 purpose:'join'(⑦-3「用 LINE 登入加入會員」,沒有預約草稿)。
// 既有 index.test.ts 全部照舊通過;這裡只測新增的行為。
import { assertEquals } from "jsr:@std/assert";
import { base64UrlEncode, handleRequest, type HandleRequestDeps } from "./index.ts";

const SITE = "https://miao-yue-dispatch.vercel.app";
const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const NOW = 1_800_000_000_000;

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const deps: HandleRequestDeps = {
    env: (k) => ({ PUBLIC_SITE_URL: SITE, SUPABASE_URL: "https://x.supabase.co" } as Record<string, string>)[k],
    db: {
      rpc(fn, args) {
        rpcCalls.push({ fn, args });
        const table: Record<string, unknown> = {
          internal_customer_line_login_start: { status: "ok", channel_id: CHANNEL_ID },
          internal_customer_line_login_consume: {
            status: "ok", merchant_id: "m-1", slug: "shop-1", channel_id: CHANNEL_ID, nonce: "NONCE", code_verifier: "VERIFIER", draft: null,
          },
          internal_get_line_login_credentials: { channel_id: CHANNEL_ID, channel_secret: CHANNEL_SECRET, enabled: true, merchant_active: true },
          internal_customer_line_identity_find: { user_id: "u-1", email: "line-1@customer.miaoyue.invalid" },
          internal_customer_line_identity_upsert: { user_id: "u-1", email: "line-1@customer.miaoyue.invalid" },
          internal_customer_line_login_succeeded: null,
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
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, rpcCalls };
}

async function signIdToken(): Promise<string> {
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ iss: "https://access.line.me", aud: CHANNEL_ID, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce: "NONCE", sub: "U-join", name: "王小明" });
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

const DRAFT = {
  items: [{ service_item_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", quantity: 1 }],
  staff_id: null, date: "2026-10-13", time: "10:00", name: "王小明", address: null, notes: null,
};

Deno.test("C3-B04 start:purpose join + 沒有草稿 ⇒ 成功,資料庫存 draft = null", async () => {
  const { deps, rpcCalls } = makeDeps();
  const res = await handleRequest(post({ action: "start", slug: "shop-1", purpose: "join" }), deps);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.status, "ok");
  assertEquals(typeof body.authorize_url, "string");
  assertEquals(rpcCalls.find((c) => c.fn === "internal_customer_line_login_start")?.args.p_draft, null);
});

Deno.test("C3-B04 start:purpose join + draft:null 也可以;purpose join 帶了草稿照樣驗證後存", async () => {
  const a = makeDeps();
  assertEquals((await handleRequest(post({ action: "start", slug: "shop-1", purpose: "join", draft: null }), a.deps)).status, 200);
  const b = makeDeps();
  assertEquals((await handleRequest(post({ action: "start", slug: "shop-1", purpose: "join", draft: DRAFT }), b.deps)).status, 200);
  assertEquals(b.rpcCalls.find((c) => c.fn === "internal_customer_line_login_start")?.args.p_draft, DRAFT);
});

Deno.test("C3-B04 start:沒有 purpose 或 purpose 不是 join ⇒ 草稿照舊必填(400 invalid_draft)", async () => {
  for (const body of [
    { action: "start", slug: "shop-1" },
    { action: "start", slug: "shop-1", draft: null },
    { action: "start", slug: "shop-1", purpose: "other" },
    { action: "start", slug: "shop-1", purpose: "join", draft: { items: [] } },
  ]) {
    const { deps, rpcCalls } = makeDeps();
    const res = await handleRequest(post(body), deps);
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { status: "invalid_draft" });
    assertEquals(rpcCalls.length, 0);
  }
});

Deno.test("C3-B04 complete:暫存的 draft 是 null ⇒ 原樣回 draft: null(前端走「加入會員」)", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(post({ action: "complete", state: "S".repeat(43), code: "CODE" }), deps);
  assertEquals(await res.json(), { status: "ok", slug: "shop-1", draft: null, token_hash: "TOKEN_HASH", verify_type: "email" });
});
