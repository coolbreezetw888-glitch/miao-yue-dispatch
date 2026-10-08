// 客戶端第 2 批(模組 13)— Edge Function customer-line-login
// 規格書 .project/specs/客戶端第2批-LINE登入與訪客預約.md:C2-B01~B04、C2-C02、C2-F01/F03/F04/F08/F09
// 介面文件(給前端):.project/notes/c2-contract.md
//
// 兩個 action(POST JSON):
//   start    { action:'start', slug, draft }          → 產生 LINE 授權網址(state / nonce / PKCE),草稿存伺服器 10 分鐘
//            { action:'start', slug, purpose:'join' }  → 第 3 批 C3-B04:沒有草稿的「加入會員」(complete 回 draft: null)
//            { action:'start', slug, purpose:'invite', invite_token } → 第 4-B 批 C4-H06:聯絡人邀請。只把邀請碼的
//                                                       SHA-256 存進登入暫存;complete 成功後把邀請「保留給這個帳號」
//                                                       (回 purpose:'invite'、invite:{state:'valid'|'invalid'})
//   complete { action:'complete', state, code?, error? } → 換 token、自己驗 id_token(HS256 / Channel Secret)、
//                                                       找或建客戶帳號、generateLink 回 token_hash(前端 verifyOtp 換登入狀態)
//
// 🔴 verify_jwt = false(客人還沒登入),寫在 supabase/config.toml [functions.customer-line-login]。
// 🔴 log 永遠不印:授權碼、access / id token、Channel Secret、state 原文、token_hash、邀請碼(原文與雜湊)。只印固定的原因代碼。
// 🔴 所有外部相依(資料庫 RPC、Auth admin、fetch、時間、亂數、log)都可注入,測試見 index.test.ts。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { clientIp } from "../_shared/clientIp.ts";
import { isAllowedOrigin, isLocalSupabaseUrl, siteOrigin } from "../_shared/customerOrigin.ts";

// =========================================================================
// 常數
// =========================================================================
export const OFFICIAL_AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
export const OFFICIAL_API_BASE = "https://api.line.me";
export const LINE_ISSUER = "https://access.line.me";
export const CALLBACK_PATH = "/auth/line/callback";
export const CUSTOMER_EMAIL_DOMAIN = "customer.miaoyue.invalid";
/** 前端 verifyOtp 要帶的 type(supabase-js 2.x;本機 GoTrue 實測 'email' 與 'magiclink' 都可以,'magiclink' 在型別上已標棄用)。 */
export const VERIFY_OTP_TYPE = "email";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DRAFT_BYTES = 8 * 1024;
const IAT_SKEW_SECONDS = 60;

// =========================================================================
// 相依注入
// =========================================================================
export interface RpcError {
  message?: string;
  code?: string;
}
export interface LoginDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}
export interface LoginAuthAdmin {
  createUser(attrs: {
    email: string;
    email_confirm: boolean;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  }): PromiseLike<{ data: { user: { id: string } | null } | null; error: unknown }>;
  deleteUser(id: string): PromiseLike<{ error: unknown }>;
  generateLink(params: { type: "magiclink"; email: string }): PromiseLike<{
    data: { properties?: { hashed_token?: string } | null } | null;
    error: unknown;
  }>;
}
export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
export interface HandleRequestDeps {
  env: (key: string) => string | undefined;
  db: LoginDb;
  authAdmin: LoginAuthAdmin;
  fetch: typeof fetch;
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  randomUUID: () => string;
  log: Logger;
}

function buildDefaultDeps(): HandleRequestDeps {
  const env = (k: string) => Deno.env.get(k);
  const client = createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    env,
    db: client as unknown as LoginDb,
    authAdmin: client.auth.admin as unknown as LoginAuthAdmin,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    randomUUID: () => crypto.randomUUID(),
    log: console,
  };
}

// =========================================================================
// 編碼 / 雜湊工具
// =========================================================================
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256Bytes(text)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256Bytes(verifier));
}

// =========================================================================
// 環境:網站網址、LINE 端點(假端點只在本機生效,C2-F08)
// =========================================================================
// isLocalSupabaseUrl / siteOrigin / isAllowedOrigin:第 3 批搬到 _shared/customerOrigin.ts 共用(內容不變),這裡轉出同名 export。
export { isAllowedOrigin, isLocalSupabaseUrl, siteOrigin };

export interface LineEndpoints {
  authorizeUrl: string;
  apiBase: string;
  mock: boolean;
}

export function resolveLineEndpoints(env: (k: string) => string | undefined, log: Logger): LineEndpoints {
  const official = { authorizeUrl: OFFICIAL_AUTHORIZE_URL, apiBase: OFFICIAL_API_BASE, mock: false };
  if (env("LINE_MOCK_MODE") !== "1") return official;
  if (!isLocalSupabaseUrl(env("SUPABASE_URL"))) {
    log.warn("[customer-line-login] LINE_MOCK_MODE 在非本機環境被忽略，改用 LINE 官方端點");
    return official;
  }
  return {
    authorizeUrl: env("LINE_MOCK_AUTHORIZE_URL") || OFFICIAL_AUTHORIZE_URL,
    apiBase: (env("LINE_MOCK_API_BASE") || OFFICIAL_API_BASE).replace(/\/+$/, ""),
    mock: true,
  };
}

// =========================================================================
// 草稿驗證(C2-B01 第 2 步):只留白名單欄位,其他一律丟掉(含 return_to 之類,C2-F04)
// =========================================================================
export interface BookingDraft {
  items: { service_item_id: string; quantity: number }[];
  staff_id: string | null;
  date: string;
  time: string;
  name: string;
  address: string | null;
  notes: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 第 4-B 批 C4-H03:聯絡人邀請碼(資料庫產生 24 bytes → base64url 32 碼;保留 128 碼上限)。 */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  return t === "" ? null : t;
}

export function validateDraft(raw: unknown): BookingDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > 50) return null;
  const items: BookingDraft["items"] = [];
  for (const it of d.items) {
    if (!it || typeof it !== "object") return null;
    const r = it as Record<string, unknown>;
    if (typeof r.service_item_id !== "string" || !UUID_RE.test(r.service_item_id)) return null;
    if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99) return null;
    items.push({ service_item_id: r.service_item_id.toLowerCase(), quantity: r.quantity });
  }
  let staffId: string | null = null;
  if (d.staff_id !== undefined && d.staff_id !== null) {
    if (typeof d.staff_id !== "string" || !UUID_RE.test(d.staff_id)) return null;
    staffId = d.staff_id.toLowerCase();
  }
  if (typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null;
  if (typeof d.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return null;
  if (typeof d.name !== "string") return null;
  const name = d.name.trim();
  if (name.length < 1 || name.length > 50) return null;
  const address = optionalText(d.address, 200);
  const notes = optionalText(d.notes, 500);
  if (address === undefined || notes === undefined) return null;
  const draft: BookingDraft = { items, staff_id: staffId, date: d.date, time: d.time, name, address, notes };
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_DRAFT_BYTES) return null;
  return draft;
}

// =========================================================================
// id_token 驗證(C2-B03 第 6 步):只收 HS256,金鑰 = Channel Secret
// =========================================================================
export interface IdTokenClaims {
  sub: string;
  name: string | null;
  picture: string | null;
}
export type IdTokenResult = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string };

export async function verifyLineIdToken(
  idToken: string,
  opts: { channelSecret: string; channelId: string; nonce: string; nowSeconds: number },
): Promise<IdTokenResult> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    signature = base64UrlDecode(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "alg" };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return { ok: false, reason: "signature" };
  if (payload.iss !== LINE_ISSUER) return { ok: false, reason: "iss" };
  const aud = payload.aud;
  if (!(aud === opts.channelId || (Array.isArray(aud) && aud.length === 1 && aud[0] === opts.channelId))) {
    return { ok: false, reason: "aud" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= opts.nowSeconds) return { ok: false, reason: "exp" };
  if (typeof payload.iat !== "number" || payload.iat > opts.nowSeconds + IAT_SKEW_SECONDS) return { ok: false, reason: "iat" };
  if (typeof payload.nonce !== "string" || payload.nonce !== opts.nonce) return { ok: false, reason: "nonce" };
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") return { ok: false, reason: "sub" };
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      name: typeof payload.name === "string" ? payload.name.slice(0, 100) : null,
      picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : null,
    },
  };
}

// =========================================================================
// HTTP
// =========================================================================
function corsHeadersFor(origin: string | null, allowed: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowed) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body: Record<string, unknown>, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * 頻率限制用的來源 IP。客戶端第 3 批(C3-G03)搬到 _shared/clientIp.ts 與 customer-booking-submit 共用,
 * 規則不變(cf-connecting-ip → X-Forwarded-For 最後一段 → "unknown");這裡用同名 export 轉出。
 */
export { clientIp };

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  const d = deps ?? buildDefaultDeps();
  const origin = req.headers.get("Origin");
  const site = siteOrigin(d.env);
  const allowed = isAllowedOrigin(origin, site);
  const cors = corsHeadersFor(origin, allowed);

  if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json({ status: "invalid_request" }, 405, cors);
  if (!allowed) return json({ status: "origin_not_allowed" }, 403, cors);
  if (!site) {
    d.log.error("[customer-line-login] 缺少或不正確的 PUBLIC_SITE_URL");
    return json({ status: "server_error" }, 500, cors);
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ status: "invalid_request" }, 400, cors);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ status: "invalid_request" }, 400, cors);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ status: "invalid_request" }, 400, cors);
  }

  try {
    if (body.action === "start") return await handleStart(req, body, d, site, cors);
    if (body.action === "complete") return await handleComplete(body, d, site, cors);
    return json({ status: "invalid_request" }, 400, cors);
  } catch (_err) {
    // 不把例外原文印出來(可能含外部回應內容)。
    d.log.error("[customer-line-login] 未預期的錯誤");
    return json({ status: "server_error" }, 500, cors);
  }
}

// -------------------------------------------------------------------------
// start
// -------------------------------------------------------------------------
async function handleStart(
  req: Request,
  body: Record<string, unknown>,
  d: HandleRequestDeps,
  site: string,
  cors: Record<string, string>,
): Promise<Response> {
  if (typeof body.slug !== "string" || body.slug.trim() === "" || body.slug.length > 100) {
    return json({ status: "invalid_request" }, 400, cors);
  }
  // 客戶端第 3 批 C3-B04:⑦-3 訪客完成頁「用 LINE 登入加入會員」⇒ purpose:'join',可以沒有草稿
  // (complete 會原樣回 draft: null)。沒有 purpose 或其他值 ⇒ 草稿照舊必填。
  let draft: BookingDraft | null;
  let inviteTokenHash: string | null = null;
  if (body.purpose === "invite") {
    // 第 4-B 批 C4-H06:邀請連結登入。不收草稿;邀請碼只存雜湊(原文不進資料庫、不進 log)。
    if (body.draft !== undefined && body.draft !== null) return json({ status: "invalid_request" }, 400, cors);
    if (typeof body.invite_token !== "string" || !INVITE_TOKEN_RE.test(body.invite_token)) {
      return json({ status: "invalid_request" }, 400, cors);
    }
    draft = null;
    inviteTokenHash = await sha256Hex(body.invite_token);
  } else if (body.purpose === "join" && (body.draft === undefined || body.draft === null)) {
    draft = null;
  } else {
    draft = validateDraft(body.draft);
    if (!draft) return json({ status: "invalid_draft" }, 400, cors);
  }

  const state = base64UrlEncode(d.randomBytes(32));
  const nonce = base64UrlEncode(d.randomBytes(32));
  const codeVerifier = base64UrlEncode(d.randomBytes(48)); // 64 字元
  const stateHash = await sha256Hex(state);
  const ipHash = await sha256Hex(`c2-line-login-ip:${clientIp(req)}`);

  const { data, error } = await d.db.rpc("internal_customer_line_login_start", {
    p_slug: body.slug.trim(),
    p_state_hash: stateHash,
    p_nonce: nonce,
    p_code_verifier: codeVerifier,
    p_draft: draft,
    p_ip_hash: ipHash,
    ...(inviteTokenHash ? { p_invite_token_hash: inviteTokenHash } : {}),
  });
  if (error) {
    d.log.error("[customer-line-login] start：資料庫呼叫失敗");
    return json({ status: "server_error" }, 500, cors);
  }
  const r = (data ?? {}) as { status?: string; channel_id?: string };
  if (r.status === "rate_limited") return json({ status: "rate_limited" }, 200, cors);
  if (r.status === "invalid_request") return json({ status: "invalid_request" }, 400, cors);
  if (r.status !== "ok" || !r.channel_id) return json({ status: "line_login_unavailable" }, 200, cors);

  const endpoints = resolveLineEndpoints(d.env, d.log);
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", r.channel_id);
  url.searchParams.set("redirect_uri", site + CALLBACK_PATH);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("bot_prompt", "normal");

  return json({ status: "ok", authorize_url: url.toString() }, 200, cors);
}

// -------------------------------------------------------------------------
// complete
// -------------------------------------------------------------------------
interface AttemptRow {
  status: string;
  merchant_id?: string;
  slug?: string | null;
  channel_id?: string;
  nonce?: string;
  code_verifier?: string;
  draft?: unknown;
  purpose?: string;
  invite_token_hash?: string;
}

async function handleComplete(
  body: Record<string, unknown>,
  d: HandleRequestDeps,
  site: string,
  cors: Record<string, string>,
): Promise<Response> {
  if (typeof body.state !== "string" || body.state.length < 16 || body.state.length > 200) {
    return json({ status: "login_expired" }, 200, cors);
  }

  // 1 + 2:用 state 雜湊找暫存;單次有效(找到就標成已使用,草稿同時從資料庫清掉)。
  const consumed = await d.db.rpc("internal_customer_line_login_consume", { p_state_hash: await sha256Hex(body.state) });
  if (consumed.error) {
    d.log.error("[customer-line-login] complete：資料庫呼叫失敗(consume)");
    return json({ status: "server_error" }, 500, cors);
  }
  const attempt = (consumed.data ?? { status: "login_expired" }) as AttemptRow;
  if (attempt.status !== "ok" || !attempt.merchant_id || !attempt.channel_id || !attempt.nonce || !attempt.code_verifier) {
    // 那一列還在(過期 / 用過)時資料庫會帶 slug,讓前端顯示「回店家首頁」;偽造的 state 不會有 slug。
    // 第 4-B 批:邀請登入的那一列再帶 purpose:'invite'(前端顯示「請重新打開邀請連結」)。
    const extra = attempt.purpose === "invite" ? { purpose: "invite" } : {};
    return json(typeof attempt.slug === "string" && attempt.slug ? { status: "login_expired", slug: attempt.slug, ...extra } : { status: "login_expired" }, 200, cors);
  }
  const slug = attempt.slug ?? null;
  const draft = attempt.draft ?? null;
  const inviteHash = typeof attempt.invite_token_hash === "string" && /^[0-9a-f]{64}$/.test(attempt.invite_token_hash)
    ? attempt.invite_token_hash
    : null;
  // 邀請登入:之後每個回應都多 purpose:'invite'(沒有邀請的回應格式跟第 3 批完全相同)。
  const inv: Record<string, unknown> = inviteHash ? { purpose: "invite" } : {};

  // 3. 客人在 LINE 按取消 / LINE 回錯誤。
  if (typeof body.error === "string" && body.error !== "") {
    return json({ status: "cancelled", slug, draft, ...inv }, 200, cors);
  }
  if (typeof body.code !== "string" || body.code === "" || body.code.length > 512) {
    return json({ status: "line_error", slug, draft, ...inv }, 200, cors);
  }

  // 4. 取這間店目前的 Channel 設定;中途改了 Channel ID / 停用 ⇒ login_expired。
  const cred = await d.db.rpc("internal_get_line_login_credentials", { p_merchant_id: attempt.merchant_id });
  if (cred.error) {
    d.log.error("[customer-line-login] complete：資料庫呼叫失敗(credentials)");
    return json({ status: "server_error" }, 500, cors);
  }
  const c = (cred.data ?? null) as
    | { channel_id?: string; channel_secret?: string; enabled?: boolean; merchant_active?: boolean }
    | null;
  if (!c || c.channel_id !== attempt.channel_id || !c.channel_secret || c.enabled !== true || c.merchant_active !== true) {
    return json({ status: "login_expired", slug, ...inv }, 200, cors);
  }
  const channelSecret = c.channel_secret;

  // 5. 換 token。
  const endpoints = resolveLineEndpoints(d.env, d.log);
  let tokenJson: Record<string, unknown>;
  try {
    const res = await d.fetch(`${endpoints.apiBase}/oauth2/v2.1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: body.code,
        redirect_uri: site + CALLBACK_PATH,
        client_id: attempt.channel_id,
        client_secret: channelSecret,
        code_verifier: attempt.code_verifier,
      }).toString(),
    });
    if (!res.ok) {
      d.log.warn(`[customer-line-login] LINE token 端點回應 ${res.status}`);
      return json({ status: "line_error", slug, draft, ...inv }, 200, cors);
    }
    tokenJson = (await res.json()) as Record<string, unknown>;
  } catch {
    d.log.warn("[customer-line-login] LINE token 端點連線失敗");
    return json({ status: "line_error", slug, draft, ...inv }, 200, cors);
  }
  if (typeof tokenJson.id_token !== "string") {
    d.log.warn("[customer-line-login] LINE token 回應沒有 id_token");
    return json({ status: "line_error", slug, draft, ...inv }, 200, cors);
  }

  // 6. 自己驗 id_token。
  const verified = await verifyLineIdToken(tokenJson.id_token, {
    channelSecret,
    channelId: attempt.channel_id,
    nonce: attempt.nonce,
    nowSeconds: Math.floor(d.now() / 1000),
  });
  if (!verified.ok) {
    d.log.warn(`[customer-line-login] id_token 驗證失敗：${verified.reason}`);
    return json({ status: "line_error", slug, draft, ...inv }, 200, cors);
  }

  // 7. 好友 / 官方帳號連結狀態(失敗不影響登入;access token 用完即丟,不存)。
  let linkedOaStatus: "ok" | "not_linked" | "unknown" = "unknown";
  if (typeof tokenJson.access_token === "string") {
    try {
      const fr = await d.fetch(`${endpoints.apiBase}/friendship/v1/status`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      linkedOaStatus = fr.ok ? "ok" : fr.status === 400 || fr.status === 403 ? "not_linked" : "unknown";
    } catch {
      linkedOaStatus = "unknown";
    }
  }

  // 8. 找或建客戶帳號(一個 Channel + LINE userId = 一個帳號)。
  const account = await findOrCreateCustomerAccount(d, attempt.channel_id, verified.claims);
  if (!account) return json({ status: "server_error" }, 500, cors);

  const succeeded = await d.db.rpc("internal_customer_line_login_succeeded", {
    p_merchant_id: attempt.merchant_id,
    p_channel_id: attempt.channel_id,
    p_linked_oa_status: linkedOaStatus,
  });
  if (succeeded.error) d.log.warn("[customer-line-login] 記錄最近成功登入失敗(不影響登入)");

  // 9. generateLink 只產生 hashed_token,不寄信。
  const link = await d.authAdmin.generateLink({ type: "magiclink", email: account.email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || typeof tokenHash !== "string" || tokenHash === "") {
    d.log.error("[customer-line-login] generateLink 失敗");
    return json({ status: "server_error" }, 500, cors);
  }

  // 第 4-B 批 C4-H06:邀請登入 ⇒ 把邀請保留給這個客戶帳號 30 分鐘(前端之後 accept 時 p_token 傳 null)。
  if (inviteHash) {
    let inviteState: "valid" | "invalid" = "invalid";
    const claimed = await d.db.rpc("internal_customer_contact_invite_claim", {
      p_merchant_id: attempt.merchant_id,
      p_user_id: account.userId,
      p_token_hash: inviteHash,
    });
    if (claimed.error) {
      d.log.warn("[customer-line-login] 保留邀請失敗(當成無效邀請)");
    } else if ((claimed.data as { state?: string } | null)?.state === "valid") {
      inviteState = "valid";
    }
    inv.invite = { state: inviteState };
  }

  // 10. 回到哪一頁由伺服器的 slug 決定(C2-F04)。
  return json({ status: "ok", slug, draft, ...inv, token_hash: tokenHash, verify_type: VERIFY_OTP_TYPE }, 200, cors);
}

async function findOrCreateCustomerAccount(
  d: HandleRequestDeps,
  channelId: string,
  claims: IdTokenClaims,
): Promise<{ userId: string; email: string } | null> {
  const found = await d.db.rpc("internal_customer_line_identity_find", { p_channel_id: channelId, p_sub: claims.sub });
  if (found.error) {
    d.log.error("[customer-line-login] 資料庫呼叫失敗(identity_find)");
    return null;
  }
  const existing = found.data as { user_id?: string; email?: string } | null;

  let userId = existing?.user_id ?? null;
  let createdUserId: string | null = null;
  if (!userId) {
    const created = await d.authAdmin.createUser({
      email: `line-${d.randomUUID()}@${CUSTOMER_EMAIL_DOMAIN}`,
      email_confirm: true,
      app_metadata: { account_type: "customer" },
      user_metadata: {},
    });
    const id = created.data?.user?.id;
    if (created.error || !id) {
      d.log.error("[customer-line-login] 建立客戶帳號失敗");
      return null;
    }
    userId = id;
    createdUserId = id;
  }

  const up = await d.db.rpc("internal_customer_line_identity_upsert", {
    p_user_id: userId,
    p_channel_id: channelId,
    p_sub: claims.sub,
    p_display_name: claims.name,
    p_picture_url: claims.picture,
  });
  const upData = up.data as { user_id?: string; email?: string } | null;
  if (up.error || !upData?.user_id || !upData.email) {
    d.log.error("[customer-line-login] 資料庫呼叫失敗(identity_upsert)");
    if (createdUserId) await d.authAdmin.deleteUser(createdUserId);
    return null;
  }
  // 同一個人同時登入兩次:另一邊先寫進去了 ⇒ 用既有的,把自己剛建的多餘帳號刪掉。
  if (createdUserId && upData.user_id !== createdUserId) {
    await d.authAdmin.deleteUser(createdUserId);
  }
  return { userId: upData.user_id, email: upData.email };
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
