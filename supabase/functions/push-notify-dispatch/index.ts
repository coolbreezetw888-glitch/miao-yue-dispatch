// 模組 15(服務人員推播通知)— Edge Function push-notify-dispatch
// 對應規格書 7.6,規則 4.3(安靜跳過)、4.6(404/410 清除訂閱)、4.7(授權檢查,核心必測)。
//
// 流程:
//   1. 用呼叫者的 JWT 驗證 private.can_manage_bookings(merchant_id)(模組 6 既有函式,跟模組 11
//      3.14 完全一樣的檢查),防止任何已登入使用者對不相關的商家/訂單濫發推播。
//   2. 用 service role client 呼叫共用的 dispatchPushForBooking(_shared/pushDispatchCore.ts)
//      處理「要不要發、發給誰、發什麼內容、404/410 清除訂閱、寫入 push_notification_log」的
//      完整判斷邏輯——這支函式跟 push-notify-reminder-dispatch 共用同一套內部邏輯,不重寫一次。
//
// 本模組最重要的邊界原則(對應規則 4.3 第 4 點):前端呼叫這支函式一律用「不等待、吞掉錯誤」的
// 方式(見 src/modules/push-notifications/api.ts dispatchPushNotification),即使這支函式整個
// 掛掉或逾時,原本的訂單操作完全不受影響。
//
// 測試性設計(規則 4.7 核心必測「未授權呼叫被擋下」):handleRequest 接受一個可注入的 deps
// 參數(createCallerClient/createAdminClient),預設用真正的 supabase-js createClient,Deno 測試
// 可以傳入假的 client 驗證 401/403 分支,不需要真正的 Supabase 環境。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { dispatchPushForBooking, type PushDispatchEventType } from "../_shared/pushDispatchCore.ts";
import { buildPushDispatchDeps } from "../_shared/pushDbAdapter.ts";

// 環境變數一律在 handleRequest 執行當下才讀取(不在模組頂層算成常數)——ES module 的 import
// 陳述式會被提升到檔案最前面執行,如果這裡在模組頂層就讀一次 Deno.env.get 存成常數,Deno 測試
// 檔案裡「import 之前」寫的 Deno.env.set(...) 實際上會在 import 完成之後才真正執行,讀到的會是
// 空字串,導致每個測試都落入「缺少必要的環境變數」的 500 分支。改成執行期讀取,測試才能真的
// 控制這幾個環境變數的值。
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

export interface DispatchRequestBody {
  merchant_id?: string;
  booking_id?: string;
  event_type?: PushDispatchEventType;
  change_summary?: string;
}

const DISPATCHABLE_EVENT_TYPES: PushDispatchEventType[] = [
  "booking_created",
  "booking_cancelled",
  "booking_updated",
];

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export interface CallerRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface HandleRequestDeps {
  createCallerClient: (authHeader: string) => CallerRpcClient;
  createAdminClient: () => AnySupabaseClient;
}

function buildDefaultDeps(config: ReturnType<typeof readEnvConfig>): HandleRequestDeps {
  return {
    createCallerClient: (authHeader: string) =>
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      }),
    createAdminClient: () =>
      createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false } }),
  };
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

  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.supabaseServiceRoleKey) {
    console.error("[push-notify-dispatch] 缺少必要的環境變數");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }
  if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
    console.error("[push-notify-dispatch] 缺少 VAPID 環境變數,尚未完成規則 4.2 的一次性設定");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少登入憑證" }, 401);
  }

  let body: DispatchRequestBody;
  try {
    body = (await req.json()) as DispatchRequestBody;
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const merchantId = body.merchant_id?.trim();
  const bookingId = body.booking_id?.trim();
  const eventType = body.event_type;
  if (!merchantId || !bookingId || !eventType) {
    return jsonResponse({ error: "缺少必要欄位(merchant_id/booking_id/event_type)" }, 400);
  }
  if (!DISPATCHABLE_EVENT_TYPES.includes(eventType)) {
    return jsonResponse({ error: "不支援的 event_type" }, 400);
  }

  // 規則 4.7(核心必測):用呼叫者自己的 JWT 驗證授權,防止濫發。
  const callerClient = resolvedDeps.createCallerClient(authHeader);

  const { data: allowed, error: authCheckError } = await callerClient.rpc("can_manage_bookings", {
    p_merchant_id: merchantId,
  });

  if (authCheckError) {
    console.error("[push-notify-dispatch] can_manage_bookings 呼叫失敗", authCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
  }
  if (!allowed) {
    return jsonResponse({ error: "沒有權限對這個商家/訂單發送通知" }, 403);
  }

  const adminClient = resolvedDeps.createAdminClient();

  const pushDeps = buildPushDispatchDeps(adminClient, {
    subject: config.vapidSubject,
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
  });

  const result = await dispatchPushForBooking(pushDeps, {
    merchantId,
    bookingId,
    eventType,
    changeSummary: body.change_summary,
  });

  return jsonResponse({ ...result }, 200);
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
