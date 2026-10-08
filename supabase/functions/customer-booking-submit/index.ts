// 客戶端第 3 批(模組 13)— Edge Function customer-booking-submit
// 規格書 .project/specs/客戶端第3批-送出預約與通知店家.md:C3-B01~B03、C3-C02、C3-G03、C3-F01/F02/F06(「零之零」優先)
// 介面文件(給前端):.project/notes/c3-contract.md
//
// POST JSON:
//   { slug, submission_id, draft:{items, staff_id, date, time, name, address, notes}, guest?:{phone, agree_policy, turnstile_token} }
//   會員:Authorization: Bearer <客人 access token>(客戶專用 client),不帶 guest。
//   訪客:不帶 Authorization(或帶 anon key),一定要帶 guest。兩者都帶 / 都沒帶 ⇒ 400 invalid_request。
//
// 業務結果一律 HTTP 200 + { state, ... }(state 見 c3-contract);格式錯 400、來源不允許 403、伺服器錯 500。
//
// 🔴 verify_jwt = false(訪客沒有登入狀態),寫在 supabase/config.toml [functions.customer-booking-submit]。
// 🔴 資料庫送出核心 internal_customer_submit_booking 只給 service_role:訪客一定要先過這裡的 Turnstile。
// 🔴 log 永遠不印:token(Supabase / Turnstile)、secret、完整電話(只印末 3 碼)、地址、備註、姓名。
// 🔴 所有外部相依(資料庫 RPC、Auth、fetch、推播、log)都可注入,測試見 index.test.ts。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { clientIp } from "../_shared/clientIp.ts";
import { isAllowedOrigin, isLocalSupabaseUrl, siteOrigin } from "../_shared/customerOrigin.ts";
import { buildPushDispatchDeps } from "../_shared/pushDbAdapter.ts";
import { dispatchPushForBooking, type DispatchPushForBookingParams } from "../_shared/pushDispatchCore.ts";

// =========================================================================
// 常數
// =========================================================================
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "guest_booking";
const MAX_BODY_BYTES = 8 * 1024;
/** C3-G03:同一 IP 10 分鐘最多 10 次送出(會員 + 訪客合計)。 */
export const IP_WINDOW_SECONDS = 600;
export const IP_MAX = 10;
/** C3-G03:訪客另外同一 IP 同一間店 24 小時最多 5 次(通過 Turnstile 之後才計算)。 */
export const GUEST_SHOP_WINDOW_SECONDS = 86400;
export const GUEST_SHOP_MAX = 5;

/** 資料庫 raise 的「輸入格式錯」hint ⇒ HTTP 400 { state:'invalid_request', hint }。 */
export const INPUT_ERROR_HINTS = new Set([
  "invalid_request",
  "invalid_draft",
  "invalid_phone",
  "policy_not_agreed",
  "address_required",
  "invalid_items",
  "no_primary_item",
  "invalid_duration",
  "duration_too_long",
]);

// =========================================================================
// 相依注入
// =========================================================================
export interface RpcError {
  message?: string;
  code?: string;
  hint?: string;
}
export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
export interface CustomerUser {
  id: string;
  app_metadata: Record<string, unknown> | null;
}
export interface SubmitDeps {
  env: (key: string) => string | undefined;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
  /** 用 service role 驗客人的 access token;無效回 null。 */
  getUser(token: string): Promise<CustomerUser | null>;
  fetch: typeof fetch;
  /** C3-C02:沿用 _shared/pushDispatchCore.ts 的 dispatchPushForBooking。 */
  dispatchPush(params: DispatchPushForBookingParams): Promise<unknown>;
  log: Logger;
}

function buildDefaultDeps(): SubmitDeps {
  const env = (k: string) => Deno.env.get(k);
  const client = createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    env,
    rpc: (fn, args) => client.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: RpcError | null }>,
    async getUser(token) {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data?.user) return null;
      return { id: data.user.id, app_metadata: (data.user.app_metadata ?? null) as Record<string, unknown> | null };
    },
    fetch: (input, init) => fetch(input, init),
    async dispatchPush(params) {
      const publicKey = env("VAPID_PUBLIC_KEY");
      const privateKey = env("VAPID_PRIVATE_KEY");
      const subject = env("VAPID_SUBJECT");
      if (!publicKey || !privateKey || !subject) {
        console.warn("[customer-booking-submit] 沒有推播金鑰設定，略過推播（鈴鐺已由資料庫寫好）");
        return null;
      }
      return dispatchPushForBooking(buildPushDispatchDeps(client, { publicKey, privateKey, subject }), params);
    },
    log: console,
  };
}

// =========================================================================
// 草稿驗證(C3-B01 / C3-F01):只留白名單欄位,其他一律丟掉(unit_price、status、member_id…)。
//   數量 1~20(跟第 1 批時段函式一致,「看得到 = 送得出」)。資料庫會再驗一次。
// =========================================================================
export interface SubmitDraft {
  items: { service_item_id: string; quantity: number }[];
  staff_id: string | null;
  date: string;
  time: string;
  name: string;
  address: string | null;
  notes: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  return t === "" ? null : t;
}

export function validateSubmitDraft(raw: unknown): SubmitDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > 50) return null;
  const items: SubmitDraft["items"] = [];
  for (const it of d.items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) return null;
    const r = it as Record<string, unknown>;
    if (typeof r.service_item_id !== "string" || !UUID_RE.test(r.service_item_id)) return null;
    if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 20) return null;
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
  return { items, staff_id: staffId, date: d.date, time: d.time, name, address, notes };
}

// =========================================================================
// 身分判斷:Authorization 是不是「已登入的客人」
//   帶的是 anon key / publishable key / 沒帶 ⇒ 訪客;JWT 的 role = authenticated ⇒ 會員(之後再用 getUser 驗)。
// =========================================================================
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function looksLikeUserToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(b64 + pad)) as Record<string, unknown>;
    return payload.role === "authenticated";
  } catch {
    return false;
  }
}

// =========================================================================
// C3-B03 Turnstile 伺服器驗證
// =========================================================================
/** Cloudflare 官方測試 secret(1x… 必過、2x… 必失敗、3x… 已用過)。 */
export function isTurnstileTestSecret(secret: string): boolean {
  return /^[123]x0+AA$/.test(secret);
}

export interface TurnstileCheck {
  secret: string;
  token: string;
  remoteIp: string | null;
  idempotencyKey: string;
  allowedHostnames: Set<string>;
  /** 本機 + 測試 secret:官方假回應的 action / hostname 不是我們的值,只看 success。 */
  relaxed: boolean;
}

export async function verifyTurnstile(f: typeof fetch, c: TurnstileCheck): Promise<boolean> {
  const form = new URLSearchParams({ secret: c.secret, response: c.token, idempotency_key: c.idempotencyKey });
  if (c.remoteIp) form.set("remoteip", c.remoteIp);
  let body: Record<string, unknown>;
  try {
    const res = await f(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return false;
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (body.success !== true) return false;
  if (c.relaxed) return true;
  if (body.action !== TURNSTILE_ACTION) return false;
  return typeof body.hostname === "string" && c.allowedHostnames.has(body.hostname.toLowerCase());
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

function phoneTail(phone: unknown): string {
  if (typeof phone !== "string") return "-";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 3 ? `***${digits.slice(-3)}` : "***";
}

export async function handleRequest(req: Request, deps?: SubmitDeps): Promise<Response> {
  const d = deps ?? buildDefaultDeps();
  const origin = req.headers.get("Origin");
  const site = siteOrigin(d.env);
  const allowed = isAllowedOrigin(origin, site);
  const cors = corsHeadersFor(origin, allowed);

  if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json({ state: "invalid_request" }, 405, cors);
  if (!allowed) return json({ state: "origin_not_allowed" }, 403, cors);
  if (!site) {
    d.log.error("[customer-booking-submit] 缺少或不正確的 PUBLIC_SITE_URL");
    return json({ state: "server_error" }, 500, cors);
  }

  // 1. 格式(整包 ≤ 8KB)
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ state: "invalid_request" }, 400, cors);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ state: "invalid_request" }, 400, cors);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ state: "invalid_request" }, 400, cors);
  }
  if (typeof body.slug !== "string" || body.slug.trim() === "" || body.slug.length > 100) {
    return json({ state: "invalid_request" }, 400, cors);
  }
  if (typeof body.submission_id !== "string" || !UUID_RE.test(body.submission_id)) {
    return json({ state: "invalid_request" }, 400, cors);
  }
  const slug = body.slug.trim().toLowerCase();
  const submissionId = body.submission_id.toLowerCase();
  const draft = validateSubmitDraft(body.draft);
  if (!draft) return json({ state: "invalid_request", hint: "invalid_draft" }, 400, cors);

  const token = bearerToken(req);
  const isMember = looksLikeUserToken(token);
  const hasGuest = body.guest !== undefined && body.guest !== null;
  if (isMember === hasGuest) return json({ state: "invalid_request" }, 400, cors);

  try {
    // 2. 頻率限制:同一 IP 10 分鐘 10 次(會員 + 訪客合計)
    const ip = clientIp(req);
    const ipHit = await d.rpc("internal_rate_limit_hit", {
      p_bucket: "customer_submit_ip",
      p_key: `ip:${ip}`,
      p_window_seconds: IP_WINDOW_SECONDS,
      p_max: IP_MAX,
    });
    if (ipHit.error) {
      d.log.error("[customer-booking-submit] 頻率限制查詢失敗");
      return json({ state: "server_error" }, 500, cors);
    }
    if (ipHit.data !== true) return json({ state: "rate_limited" }, 200, cors);

    let userId: string | null = null;
    let guestPhone: string | null = null;
    let agree = true;

    if (isMember) {
      // 3. 會員:service role 驗 token;app_metadata.account_type 必須是 customer
      const user = await d.getUser(token as string);
      if (!user || user.app_metadata?.account_type !== "customer") {
        return json({ state: "not_linked" }, 200, cors);
      }
      userId = user.id;
    } else {
      // 4. 訪客:先驗 Turnstile
      const g = body.guest as Record<string, unknown>;
      if (typeof g !== "object" || Array.isArray(g)) return json({ state: "invalid_request" }, 400, cors);
      if (typeof g.phone !== "string" || g.phone.length > 30 || typeof g.agree_policy !== "boolean") {
        return json({ state: "invalid_request" }, 400, cors);
      }
      guestPhone = g.phone;
      agree = g.agree_policy;

      const secret = d.env("TURNSTILE_SECRET_KEY");
      if (!secret) {
        d.log.warn("[customer-booking-submit] 沒有設定 TURNSTILE_SECRET_KEY，訪客送出一律不開放");
        return json({ state: "guest_unavailable" }, 200, cors);
      }
      const local = isLocalSupabaseUrl(d.env("SUPABASE_URL"));
      const testSecret = isTurnstileTestSecret(secret);
      if (testSecret && !local) {
        d.log.warn("[customer-booking-submit] 正式環境設定成 Turnstile 測試 secret，一律當驗證失敗");
        return json({ state: "bot_check_failed" }, 200, cors);
      }
      if (typeof g.turnstile_token !== "string" || g.turnstile_token === "" || g.turnstile_token.length > 2048) {
        return json({ state: "bot_check_failed" }, 200, cors);
      }
      const siteHost = new URL(site).hostname.toLowerCase();
      const passed = await verifyTurnstile(d.fetch, {
        secret,
        token: g.turnstile_token,
        remoteIp: ip === "unknown" ? null : ip,
        idempotencyKey: submissionId,
        allowedHostnames: new Set([siteHost, "localhost", "127.0.0.1"]),
        relaxed: testSecret && local,
      });
      if (!passed) {
        d.log.info("[customer-booking-submit] Turnstile 沒有通過");
        return json({ state: "bot_check_failed" }, 200, cors);
      }

      const shopHit = await d.rpc("internal_rate_limit_hit", {
        p_bucket: "customer_submit_guest_shop",
        p_key: `ip:${ip}|slug:${slug}`,
        p_window_seconds: GUEST_SHOP_WINDOW_SECONDS,
        p_max: GUEST_SHOP_MAX,
      });
      if (shopHit.error) {
        d.log.error("[customer-booking-submit] 頻率限制查詢失敗");
        return json({ state: "server_error" }, 500, cors);
      }
      if (shopHit.data !== true) return json({ state: "rate_limited" }, 200, cors);
    }

    // 5. 資料庫送出核心(service role)
    const { data, error } = await d.rpc("internal_customer_submit_booking", {
      p_slug: slug,
      p_user_id: userId,
      p_guest_phone: guestPhone,
      p_draft: draft,
      p_agree_policy: agree,
      p_submission_id: submissionId,
    });
    if (error) {
      const hint = typeof error.hint === "string" ? error.hint : "";
      if (INPUT_ERROR_HINTS.has(hint)) {
        d.log.info(`[customer-booking-submit] 輸入不正確：${hint}`);
        return json({ state: "invalid_request", hint }, 400, cors);
      }
      d.log.error(`[customer-booking-submit] 資料庫呼叫失敗（${error.code ?? "?"}）`);
      return json({ state: "server_error" }, 500, cors);
    }

    const result = { ...((data ?? {}) as Record<string, unknown>) };
    const internal = (result._internal ?? null) as
      | { replayed?: boolean; booking_id?: string; merchant_id?: string; push_title?: string; push_body?: string }
      | null;
    delete result._internal;
    const state = typeof result.state === "string" ? result.state : "server_error";
    d.log.info(`[customer-booking-submit] state=${state} guest=${!isMember} phone=${phoneTail(guestPhone)}`);

    // 6. 新建成功 ⇒ 推播(照店家既有推播設定;鈴鐺已由資料庫寫好)。推播成功與否不影響回應。
    if (state === "created" && internal && internal.replayed !== true && internal.booking_id && internal.merchant_id) {
      try {
        await d.dispatchPush({
          merchantId: internal.merchant_id,
          bookingId: internal.booking_id,
          eventType: "booking_created",
          skipInAppNotification: true,
          messageOverride:
            typeof internal.push_title === "string" && typeof internal.push_body === "string"
              ? { title: internal.push_title, body: internal.push_body }
              : null,
        });
      } catch {
        d.log.warn("[customer-booking-submit] 推播發送失敗（預約已成立，不影響回應）");
      }
    }

    // 7. 回傳資料庫結果(已刪掉 _internal,不加欄位)
    return json(result, 200, cors);
  } catch {
    d.log.error("[customer-booking-submit] 未預期的錯誤");
    return json({ state: "server_error" }, 500, cors);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
