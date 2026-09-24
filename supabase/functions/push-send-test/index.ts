// 模組 15 擴充(手機推播擴及三種角色)— Edge Function push-send-test
// 對應規格書 §6.1(測試推播)、§6.2(權限靠 RLS 不靠前端誠實)、§6.3(ack token)、§6.6(頻率限制)。
// 需求編號 #737、#738、#739、#742。
//
// ⚠️ 部署時 verify_jwt = true。
//
// 為什麼不是擴充既有的 push-notify-dispatch:
//   那一支的第一道關卡是 private.can_manage_bookings(merchant_id) —— **服務人員沒有這個權限**,
//   所以他永遠無法用那一支測試;而且那一支必須帶 booking_id(測試推播沒有訂單)。兩件事都不成立,
//   硬塞進去只會讓一支已經驗收過的函式長出一堆 if-else 分支。
//
// 🔴 §6.2 的核心安全設計(這三條是這支函式最重要的部分,不要改):
//   1. 裝置清單一律用**呼叫者自己的 JWT client** 查(anon key + Authorization 標頭),
//      RLS 政策 `user_id = auth.uid()` 就是權限檢查本身。
//   2. service role client **只用來做三件事**:寫 log、實際發送(需要 VAPID 私鑰)、刪除失效裝置。
//      **絕對不用它查「要發給誰」**——那就是一個「幫任何人發推播」的洞。
//   3. 請求 body 只收 { merchant_id, endpoint? }。**沒有 target_id、沒有 user_id、沒有 target_type**,
//      多餘的欄位一律忽略(§4.1)。管理員不能對服務人員發測試推播,這是刻意的。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import {
  shouldDeleteSubscriptionOnFailure,
  type PushSubscriptionRow,
} from "../_shared/pushDispatchCore.ts";
import { sendWebPush } from "../_shared/webpushAdapter.ts";

// 環境變數一律在 handleRequest 執行當下才讀取(理由同 push-notify-dispatch 的檔頭註解:
// module 層級的常數會在 Deno 測試 import 之前就定案,測試無法控制)。
function readEnvConfig() {
  return {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    vapidSubject: Deno.env.get("VAPID_SUBJECT") ?? "",
    vapidPublicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    vapidPrivateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** §6.6:60 秒內最多 3 次。3 次的理由:一次自動(開啟時)+ 兩次手動重試。 */
export const TEST_PUSH_RATE_LIMIT = 3;

/** §6.5 的誠實界線:測試推播的內容本身也不能承諾「已生效」,只能陳述「這是一則測試通知」。 */
export const TEST_PUSH_TITLE = "秒約測試通知";
export const TEST_PUSH_BODY = "這是一則測試通知。看得到這則訊息,代表通知有送到這台裝置。";

export interface SendTestRequestBody {
  merchant_id?: string;
  endpoint?: string;
}

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export interface CallerClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: string): {
    // deno-lint-ignore no-explicit-any
    select(columns: string): any;
  };
}

export interface HandleRequestDeps {
  createCallerClient: (authHeader: string) => CallerClient;
  createAdminClient: () => AnySupabaseClient;
  /** 測試可以注入假的發送器,避免真的打 FCM。 */
  sendPush?: typeof sendWebPush;
  /** 測試可以注入固定的 token,方便斷言。 */
  newAckToken?: () => string;
}

function buildDefaultDeps(config: ReturnType<typeof readEnvConfig>): HandleRequestDeps {
  return {
    createCallerClient: (authHeader: string) =>
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      }) as unknown as CallerClient,
    createAdminClient: () =>
      createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { persistSession: false },
      }),
  };
}

interface PushIdentity {
  target_type: "admin" | "agent" | "staff";
  target_id: string;
  display_name: string;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }

  const config = readEnvConfig();
  const resolvedDeps = deps ?? buildDefaultDeps(config);
  const sendPush = resolvedDeps.sendPush ?? sendWebPush;
  const newAckToken = resolvedDeps.newAckToken ?? (() => crypto.randomUUID());

  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.supabaseServiceRoleKey) {
    console.error("[push-send-test] 缺少必要的環境變數");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }
  if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
    console.error("[push-send-test] 缺少 VAPID 環境變數");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少登入憑證" }, 401);
  }

  let body: SendTestRequestBody;
  try {
    body = (await req.json()) as SendTestRequestBody;
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const merchantId = body.merchant_id?.trim();
  if (!merchantId) {
    return jsonResponse({ error: "缺少必要欄位(merchant_id)" }, 400);
  }
  // ⚠️ body 裡如果還夾帶 user_id / target_id / target_type,到這裡就結束了 —— 下面一行都不會用到
  //    它們。身分一律由資料庫從 auth.uid() 自己解析(§4.1)。
  const endpointFilter = body.endpoint?.trim() || null;

  const callerClient = resolvedDeps.createCallerClient(authHeader);

  // §6.1 第 5 步:解析呼叫者在這間商家的身份與姓名。不屬於這間商家 → 42501 → 403。
  const { data: identityData, error: identityError } = await callerClient.rpc(
    "get_my_push_identity",
    { p_merchant_id: merchantId },
  );
  if (identityError) {
    console.error("[push-send-test] get_my_push_identity 失敗", identityError);
    return jsonResponse({ error: "你不是這間商家的成員,無法發送測試通知" }, 403);
  }
  const identity = identityData as PushIdentity | null;
  if (!identity) {
    return jsonResponse({ error: "你不是這間商家的成員,無法發送測試通知" }, 403);
  }

  // §6.6:頻率限制。放在裝置查詢之後、實際發送之前都可以,這裡先擋掉比較省。
  const { data: recentCount, error: rateError } = await callerClient.rpc(
    "count_my_recent_test_pushes",
    { p_merchant_id: merchantId },
  );
  if (rateError) {
    console.error("[push-send-test] count_my_recent_test_pushes 失敗", rateError);
    return jsonResponse({ error: "檢查發送頻率時發生錯誤" }, 500);
  }
  if (typeof recentCount === "number" && recentCount >= TEST_PUSH_RATE_LIMIT) {
    return jsonResponse({ error: "測試通知發太多次了,請等一分鐘再試" }, 429);
  }

  // 🔴 §6.2 第 1 點:用呼叫者的 JWT 查裝置,RLS 自動只回傳他自己的。
  let query = callerClient
    .from("push_subscriptions")
    .select("id, endpoint, p256dh_key, auth_key");
  if (endpointFilter) query = query.eq("endpoint", endpointFilter);
  const { data: subscriptionsData, error: subscriptionsError } = await query;
  if (subscriptionsError) {
    console.error("[push-send-test] 查詢裝置失敗", subscriptionsError);
    return jsonResponse({ error: "查詢裝置時發生錯誤" }, 500);
  }
  const subscriptions = (subscriptionsData as PushSubscriptionRow[] | null) ?? [];
  if (subscriptions.length === 0) {
    // 不是錯誤,就是他還沒開通。
    return jsonResponse({ sent: 0, failed: 0, reason: "no_subscription", ack_tokens: [] }, 200);
  }

  const adminClient = resolvedDeps.createAdminClient();

  // §6.3:ack_url 必須是完整絕對網址 —— public/push-sw.js 是不經過 Vite 編譯的靜態檔案,
  // 裡面拿不到 import.meta.env,網址與 token 只能從 payload 帶進去。
  const ackBaseUrl = `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/push-test-ack`;

  const ackTokens: string[] = [];
  let sent = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const ackToken = newAckToken();
    ackTokens.push(ackToken);

    const result = await sendPush(
      {
        subject: config.vapidSubject,
        publicKey: config.vapidPublicKey,
        privateKey: config.vapidPrivateKey,
      },
      subscription,
      {
        title: TEST_PUSH_TITLE,
        body: TEST_PUSH_BODY,
        // §4.7 第 4 點:/app 這個路由一定存在,而且 HomePage 會依角色自動導到正確落點。
        url: "/app",
        // §6.3:service worker 看到 kind='test' 才會回報。
        kind: "test",
        ack_url: `${ackBaseUrl}?token=${ackToken}`,
      },
    );

    if (result.ok) sent += 1;
    else failed += 1;

    const { error: logError } = await adminClient.from("push_notification_log").insert({
      merchant_id: merchantId,
      event_type: "test",
      booking_id: null,
      target_type: identity.target_type,
      target_id: identity.target_id,
      status: result.ok ? "sent" : "failed",
      skip_reason: null,
      device_count: 1,
      success_count: result.ok ? 1 : 0,
      error_detail: result.ok ? null : result.errorDetail,
      rendered_title: TEST_PUSH_TITLE,
      rendered_body: TEST_PUSH_BODY,
      ack_token: ackToken,
      // §6.4 第 3 點:記下這一列是發給哪一台裝置,ack 進來時才能精準更新那一台的 last_seen_at。
      ack_subscription_id: subscription.id,
    });
    if (logError) console.error("[push-send-test] 寫入 push_notification_log 失敗", logError);

    // 規則 4.6:404/410 代表這個 endpoint 已經失效,刪掉它(沿用既有判斷函式,不重寫)。
    if (!result.ok && shouldDeleteSubscriptionOnFailure(result.status)) {
      const { error: deleteError } = await adminClient
        .from("push_subscriptions")
        .delete()
        .eq("id", subscription.id);
      if (deleteError) console.error("[push-send-test] 刪除失效裝置失敗", deleteError);
    }
  }

  return jsonResponse({ sent, failed, ack_tokens: ackTokens }, 200);
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
