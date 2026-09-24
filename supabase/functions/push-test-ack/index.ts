// 模組 15 擴充(手機推播擴及三種角色)— Edge Function push-test-ack
// 對應規格書 §6.3(送達回報)、§6.4(公開端點與 token 規則)。需求編號 #739、#740。
//
// ⚠️ 部署時 **verify_jwt = false**(這是刻意的,理由見下)。
//
// 為什麼必須是公開的:service worker 在背景執行時**拿不到頁面的登入 session**,沒有 JWT 可以帶。
// 所以只能用「不可猜測的一次性 token」當憑證。
//
// 🔴 §6.4 的四條安全設計(每一條都是實作要求,不是建議):
//   1. token 是 gen_random_uuid(),存在 push_notification_log.ack_token(UNIQUE)。
//   2. 一次性 + 10 分鐘有效:update ... where ack_token = ? and acked_at is null
//      and attempted_at > now() - interval '10 minutes'。已回報過、或超過 10 分鐘,都不再更新。
//   3. 同時更新對應裝置的 push_subscriptions.last_seen_at(§2.1 —— 這個欄位從模組 15 上線以來
//      從來沒有任何程式碼寫過它,這次才真的有值)。
//   4. **回應永遠是 204 No Content,不回傳任何內容。** 不論 token 有效、無效、過期、已用過,
//      回應完全一樣。理由:這是一個沒有登入保護的端點,任何差異化的回應都是一個可以拿來
//      窮舉 token 的訊號。
//
// 最壞情況評估(誠實說明):如果有人猜中一個有效 token(uuid v4,10 分鐘有效期內,實際上不可能),
// 他能做的就是「讓一列記錄被標記成已送達」。**沒有任何資料會被讀到、沒有任何推播會被發出、
// 沒有任何設定會被改動。**

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function readEnvConfig() {
  return {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export interface HandleRequestDeps {
  createAdminClient: () => AnySupabaseClient;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §6.4 第 4 點:所有路徑都回這一個完全一樣的回應。抽成常數,避免有人不小心在某個分支多回了東西。 */
function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** 從 querystring 或 JSON body 取出 token。純函式,方便測試。 */
export function extractAckToken(url: string, body: unknown): string | null {
  try {
    const fromQuery = new URL(url).searchParams.get("token");
    if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  } catch {
    // 網址解析失敗就當成沒有 token,不拋錯(回應一律 204)。
  }
  if (body && typeof body === "object") {
    const value = (body as Record<string, unknown>)["token"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // 即使是 GET 之類的其他方法,也回 204(不透露任何訊息)。
  if (req.method !== "POST") {
    return noContentResponse();
  }

  const config = readEnvConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    console.error("[push-test-ack] 缺少必要的環境變數");
    return noContentResponse();
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const token = extractAckToken(req.url, body);
  if (!token) return noContentResponse();
  // 這是一個沒有登入保護的公開端點,先在這裡擋掉「連格式都不對」的 token,不要每一次亂打都
  // 送進資料庫撞一次 uuid 轉型錯誤(徒增 log 雜訊與資料庫負擔)。回應仍然是一模一樣的 204。
  if (!UUID_PATTERN.test(token)) return noContentResponse();

  const adminClient =
    deps?.createAdminClient() ??
    createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

  const { data, error } = await adminClient.rpc("ack_push_test_notification", {
    p_ack_token: token,
  });
  if (error) {
    // 連錯誤都不透露給呼叫端,只留伺服器端的記錄。
    console.error("[push-test-ack] ack_push_test_notification 失敗", error);
  } else if (data === false) {
    console.log("[push-test-ack] token 無效/過期/已使用過(回應仍然是 204)");
  }

  return noContentResponse();
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
