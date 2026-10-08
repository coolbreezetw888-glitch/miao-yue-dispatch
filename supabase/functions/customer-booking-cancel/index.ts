// 客戶端第 4-A 批(模組 13)— Edge Function customer-booking-cancel
// 規格書 .project/specs/客戶端第4批-會員中心與自己取消.md:C4-D03、C4-D05、C4-F05(「零之零」優先)
// 介面文件(給前端):.project/notes/c4-contract.md 第 4 節
//
// POST JSON:{ slug, booking_id } + Authorization: Bearer <客人 access token>(客戶專用 client)
//
// 業務結果一律 HTTP 200 + { state, ... }:cancelled / already_cancelled / deadline_passed / not_cancellable /
//   not_found / not_linked / unavailable / rate_limited。格式錯 400、來源不允許 403、伺服器錯 500。
//
// 🔴 verify_jwt = false(寫在 supabase/config.toml [functions.customer-booking-cancel]):
//    沒帶 / 帶錯 token 要回自己的 { state:'not_linked' }(前端回會員中心登入頁),不能被閘道器擋成 401;
//    而且 CLI 部署沒寫這段會把 verify_jwt 打回 true(權限衛生規則 7)。token 由這裡用 service role 驗。
// 🔴 資料庫取消核心 internal_customer_cancel_booking 只給 service_role;回傳的 _internal 一定要刪掉再回客人。
// 🔴 log 永遠不印:token、訂單 id、姓名、電話。
// 🔴 所有外部相依(資料庫 RPC、Auth、推播、log)都可注入,測試見 index.test.ts。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { clientIp } from "../_shared/clientIp.ts";
import { isAllowedOrigin, siteOrigin } from "../_shared/customerOrigin.ts";
import { buildPushDispatchDeps } from "../_shared/pushDbAdapter.ts";
import { dispatchPushForBooking, type DispatchPushForBookingParams } from "../_shared/pushDispatchCore.ts";

// =========================================================================
// 常數
// =========================================================================
const MAX_BODY_BYTES = 4 * 1024;
/** C4-D03:同一 IP 10 分鐘最多 20 次。 */
export const IP_WINDOW_SECONDS = 600;
export const IP_MAX = 20;
export const RATE_LIMIT_BUCKET = "customer_cancel_ip";

/** 資料庫回的業務 state(其他值一律當伺服器錯)。 */
export const BUSINESS_STATES = new Set([
  "cancelled",
  "already_cancelled",
  "deadline_passed",
  "not_cancellable",
  "not_found",
  "not_linked",
  "unavailable",
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
export interface CancelDeps {
  env: (key: string) => string | undefined;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
  /** 用 service role 驗客人的 access token;無效回 null。 */
  getUser(token: string): Promise<CustomerUser | null>;
  /** C4-D05:沿用 _shared/pushDispatchCore.ts 的 dispatchPushForBooking。 */
  dispatchPush(params: DispatchPushForBookingParams): Promise<unknown>;
  log: Logger;
}

function buildDefaultDeps(): CancelDeps {
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
    async dispatchPush(params) {
      const publicKey = env("VAPID_PUBLIC_KEY");
      const privateKey = env("VAPID_PRIVATE_KEY");
      const subject = env("VAPID_SUBJECT");
      if (!publicKey || !privateKey || !subject) {
        console.warn("[customer-booking-cancel] 沒有推播金鑰設定，略過推播（鈴鐺已由資料庫寫好）");
        return null;
      }
      return dispatchPushForBooking(buildPushDispatchDeps(client, { publicKey, privateKey, subject }), params);
    },
    log: console,
  };
}

// =========================================================================
// HTTP
// =========================================================================
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

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

export async function handleRequest(req: Request, deps?: CancelDeps): Promise<Response> {
  const d = deps ?? buildDefaultDeps();
  const origin = req.headers.get("Origin");
  const site = siteOrigin(d.env);
  const allowed = isAllowedOrigin(origin, site);
  const cors = corsHeadersFor(origin, allowed);

  if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json({ state: "invalid_request" }, 405, cors);
  if (!allowed) return json({ state: "origin_not_allowed" }, 403, cors);

  // 1. 格式(整包 ≤ 4KB)
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
  if (typeof body.booking_id !== "string" || !UUID_RE.test(body.booking_id)) {
    return json({ state: "invalid_request" }, 400, cors);
  }
  const slug = body.slug.trim().toLowerCase();
  const bookingId = body.booking_id.toLowerCase();

  try {
    // 2. 頻率限制:同一 IP 10 分鐘 20 次(先算,沒帶 token 亂試也算進去)
    const ip = clientIp(req);
    const ipHit = await d.rpc("internal_rate_limit_hit", {
      p_bucket: RATE_LIMIT_BUCKET,
      p_key: `ip:${ip}`,
      p_window_seconds: IP_WINDOW_SECONDS,
      p_max: IP_MAX,
    });
    if (ipHit.error) {
      d.log.error("[customer-booking-cancel] 頻率限制查詢失敗");
      return json({ state: "server_error" }, 500, cors);
    }
    if (ipHit.data !== true) return json({ state: "rate_limited" }, 200, cors);

    // 3. 客人身分:沒帶 token / token 無效 / 不是客人帳號 ⇒ not_linked
    const token = bearerToken(req);
    if (!token) return json({ state: "not_linked" }, 200, cors);
    const user = await d.getUser(token);
    if (!user || user.app_metadata?.account_type !== "customer") {
      return json({ state: "not_linked" }, 200, cors);
    }

    // 4. 資料庫取消核心(service role)
    const { data, error } = await d.rpc("internal_customer_cancel_booking", {
      p_slug: slug,
      p_user_id: user.id,
      p_booking_id: bookingId,
    });
    if (error) {
      d.log.error(`[customer-booking-cancel] 資料庫呼叫失敗（${error.code ?? "?"}）`);
      return json({ state: "server_error" }, 500, cors);
    }

    const result = { ...((data ?? {}) as Record<string, unknown>) };
    const internal = (result._internal ?? null) as
      | { booking_id?: string; merchant_id?: string; push_title?: string; push_body?: string }
      | null;
    delete result._internal;
    const state = typeof result.state === "string" ? result.state : "";
    if (!BUSINESS_STATES.has(state)) {
      d.log.error("[customer-booking-cancel] 資料庫回傳格式不正確");
      return json({ state: "server_error" }, 500, cors);
    }
    d.log.info(`[customer-booking-cancel] state=${state}`);

    // 5. 取消成功 ⇒ 推播(照店家既有推播設定;鈴鐺已由資料庫寫好)。推播成功與否不影響回應。
    //    第 5 批接點:「LINE 通知客人 / 聯絡人:預約已取消」接在這裡旁邊(這批不做)。
    if (state === "cancelled" && internal?.booking_id && internal.merchant_id) {
      try {
        await d.dispatchPush({
          merchantId: internal.merchant_id,
          bookingId: internal.booking_id,
          eventType: "booking_cancelled",
          skipInAppNotification: true,
          messageOverride:
            typeof internal.push_title === "string" && typeof internal.push_body === "string"
              ? { title: internal.push_title, body: internal.push_body }
              : null,
        });
      } catch {
        d.log.warn("[customer-booking-cancel] 推播發送失敗（預約已取消，不影響回應）");
      }
    }

    // 6. 回傳資料庫結果(已刪掉 _internal,不加欄位)
    return json(result, 200, cors);
  } catch {
    d.log.error("[customer-booking-cancel] 未預期的錯誤");
    return json({ state: "server_error" }, 500, cors);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
