// 客戶端第 5-B 批 — Edge Function line-quota-status(C5-Q02 ⚠️範圍 第 4 點)
// 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md C5-Q02、K02 第 2 點「額度區」。
//
// 後台「LINE 通知事件」頁「通知客人」卡的額度區用:
//   「本月已用 132／200 則(客人通知 80、員工通知 40、行銷 12)」+ 每月上限 + 停發狀態。
//
// 流程:
//   1. verify_jwt = true(config.toml 明寫);用呼叫者自己的 JWT 呼叫 get_customer_line_usage(p_merchant_id)
//      ⇒ 資料庫裡擋權限(private.can_manage_line_notification:管理員 + 有「LINE 通知」權限的客服),
//        沒權限 ⇒ 42501 ⇒ 這裡回 403。同時拿到本系統本月統計、每月上限、停發到哪天。
//   2. 店家已接上官方帳號 ⇒ 用 service role 讀該店 channel access token(只在記憶體),
//      呼叫 LINE GET /v2/bot/message/quota(上限)與 /v2/bot/message/quota/consumption(本月已用)。
//      這兩支查詢不算訊息則數。LINE 查詢失敗 ⇒ plan_limit / used 回 null、line_status = 'unavailable'。
//   3. 回應:{ line_status, quota_type, plan_limit, used, month, by_category, total_sent, cap, blocked_until }。
//      **不回 token、不回 LINE userId**。
//
// fetchLineQuota 跟 customer-line-notify-dispatch 裡的同名函式一樣——刻意各寫一份(每個 function 是獨立
// 部署單位,不跨 function 目錄 import;見 line-send-marketing 檔頭)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { isLocalSupabaseUrl } from "../_shared/customerOrigin.ts";
import { getLineMessagingCredentials } from "../_shared/lineCredentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export interface LineQuota {
  type: "none" | "limited";
  limit: number | null;
  used: number;
}

/** 查官方帳號本月額度與已用則數;任一失敗 ⇒ null(不丟例外、不回錯誤內容)。 */
export async function fetchLineQuota(fetchImpl: typeof fetch, apiBase: string, channelAccessToken: string): Promise<LineQuota | null> {
  try {
    const headers = { Authorization: `Bearer ${channelAccessToken}` };
    const [q, c] = await Promise.all([
      fetchImpl(`${apiBase}/v2/bot/message/quota`, { method: "GET", headers }),
      fetchImpl(`${apiBase}/v2/bot/message/quota/consumption`, { method: "GET", headers }),
    ]);
    if (!q.ok || !c.ok) return null;
    const quota = (await q.json()) as { type?: unknown; value?: unknown };
    const consumption = (await c.json()) as { totalUsage?: unknown };
    const used = Number(consumption?.totalUsage);
    if (!Number.isFinite(used) || used < 0) return null;
    if (quota?.type === "none") return { type: "none", limit: null, used };
    const limit = Number(quota?.value);
    if (quota?.type !== "limited" || !Number.isFinite(limit) || limit <= 0) return null;
    return { type: "limited", limit, used };
  } catch {
    return null;
  }
}

/** LINE API 網址:正式一律官方;只有 SUPABASE_URL 是本機 + LINE_MOCK_MODE=1 才用假端點(比照 C2-F08)。 */
export function resolveLineApiBase(env: (k: string) => string | undefined): string {
  const official = "https://api.line.me";
  if (env("LINE_MOCK_MODE") !== "1" || !isLocalSupabaseUrl(env("SUPABASE_URL"))) return official;
  return (env("LINE_MOCK_API_BASE") || official).replace(/\/+$/, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UsageRow {
  connected: boolean;
  month: string;
  by_category: { customer: number; store: number; marketing: number; birthday: number };
  total_sent: number;
  cap: number | null;
  blocked_until: string | null;
}

export interface Deps {
  env?: (k: string) => string | undefined;
  fetchImpl?: typeof fetch;
  /** 用呼叫者的 JWT 呼叫 get_customer_line_usage(權限在資料庫擋)。 */
  getUsage?: (authHeader: string, merchantId: string) => Promise<{ data: UsageRow | null; error: { code?: string } | null }>;
  /** service role 讀該店 channel access token;沒接上 ⇒ null。 */
  getToken?: (merchantId: string) => Promise<string | null>;
  log?: { error: (...a: unknown[]) => void };
}

export async function handleRequest(req: Request, deps?: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "只接受 POST 請求" }, 405);

  const env = deps?.env ?? ((k: string) => Deno.env.get(k));
  const log = deps?.log ?? console;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "缺少登入憑證" }, 401);

  let merchantId = "";
  try {
    const body = (await req.json()) as { merchant_id?: unknown };
    merchantId = typeof body?.merchant_id === "string" ? body.merchant_id.trim() : "";
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }
  if (!UUID_RE.test(merchantId)) return jsonResponse({ error: "請求格式錯誤" }, 400);

  let getUsage = deps?.getUsage;
  let getToken = deps?.getToken;
  if (!getUsage || !getToken) {
    const url = env("SUPABASE_URL") ?? "";
    const anon = env("SUPABASE_ANON_KEY") ?? "";
    const service = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !anon || !service) {
      log.error("[line-quota-status] 缺少必要的環境變數");
      return jsonResponse({ error: "伺服器設定不完整" }, 500);
    }
    getUsage ??= async (auth, mid) => {
      const caller = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
      const { data, error } = await caller.rpc("get_customer_line_usage", { p_merchant_id: mid });
      return { data: (data ?? null) as UsageRow | null, error: error ? { code: (error as { code?: string }).code } : null };
    };
    getToken ??= async (mid) => {
      const admin = createClient(url, service, { auth: { persistSession: false } });
      const { data } = await admin
        .from("merchant_line_configs")
        .select("is_connected")
        .eq("merchant_id", mid)
        .maybeSingle();
      if (!data?.is_connected) return null;
      // #1053:金鑰改存 Vault,透過 service_role 專用 RPC 取;讀不到 ⇒ null(回 line_status unavailable 的既有分支)。
      const credentials = await getLineMessagingCredentials(admin, mid, "[line-quota-status]");
      return credentials?.channelAccessToken ?? null;
    };
  }

  const usage = await getUsage(authHeader, merchantId).catch(() => ({ data: null, error: { code: "fetch" } }));
  if (usage.error) {
    if (usage.error.code === "42501") return jsonResponse({ error: "沒有權限查看這間商家的 LINE 用量" }, 403);
    log.error("[line-quota-status] 查詢本月統計失敗");
    return jsonResponse({ error: "查詢失敗" }, 500);
  }
  const row = usage.data;
  if (!row) return jsonResponse({ error: "查詢失敗" }, 500);

  let lineStatus: "ok" | "unavailable" | "not_connected" = "not_connected";
  let quota: LineQuota | null = null;
  if (row.connected) {
    const token = await getToken(merchantId).catch(() => null);
    if (token) {
      quota = await fetchLineQuota(deps?.fetchImpl ?? fetch, resolveLineApiBase(env), token);
    }
    lineStatus = quota ? "ok" : "unavailable";
  }

  return jsonResponse({
    line_status: lineStatus,
    quota_type: quota?.type ?? null,
    plan_limit: quota?.type === "limited" ? quota.limit : null,
    used: quota ? quota.used : null,
    month: row.month,
    by_category: row.by_category,
    total_sent: row.total_sent,
    cap: row.cap,
    blocked_until: row.blocked_until,
  }, 200);
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
