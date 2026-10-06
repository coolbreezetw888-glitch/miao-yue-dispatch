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
import {
  buildNotifySubjectOwnershipLookup,
  checkNotifySubjectsBelongToMerchant,
  NOTIFY_SUBJECT_LOOKUP_FAILED_MESSAGE,
  NOTIFY_SUBJECT_NOT_FOUND_MESSAGE,
  type NotifySubjectOwnershipLookup,
} from "../_shared/notifySubjectOwnership.ts";
import {
  checkStaffBookingDispatch,
  resolveStaffSafeDispatchFields,
} from "../_shared/staffBookingDispatch.ts";

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
  /** SPECS-INDEX #823:被換掉的主服務人員 id(只有 booking_updated 會帶)。詳見 pushDispatchCore.ts。 */
  previous_staff_id?: string;
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
  /** #972:不帶 → 用真正查資料庫的 buildNotifySubjectOwnershipLookup(adminClient)。 */
  createOwnershipLookup?: (adminClient: AnySupabaseClient) => NotifySubjectOwnershipLookup;
}

function buildDefaultDeps(config: ReturnType<typeof readEnvConfig>): HandleRequestDeps {
  return {
    createCallerClient: (authHeader: string) =>
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      }),
    createAdminClient: () =>
      createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { persistSession: false },
      }),
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
  // #977 第 7 批:這次是不是走「服務人員本人」那條放行路(決定下面要不要採信呼叫端自由填的欄位)。
  let viaStaffPath = false;
  if (!allowed) {
    // SPECS-INDEX #977 第 7 批(2026-10-07):服務人員本人(開了「新增編輯訂單」)自己建單 / 改單 / 取消 / 拖拉後,
    // 用他自己的身分呼叫這支 ⇒ 上面那道 can_manage_bookings 一定不過。這裡**再**問一次
    // can_staff_dispatch_booking_notification:本人是這張單的主要服務人員、可以自己下單、事件符合訂單現況才放行。
    // 原本就放行的人完全不經過這一段(行為不變)。
    const staffAllowed = await checkStaffBookingDispatch(
      callerClient,
      merchantId,
      bookingId,
      eventType,
    );
    if (staffAllowed === "error") {
      return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
    }
    if (!staffAllowed) {
      return jsonResponse({ error: "沒有權限對這個商家/訂單發送通知" }, 403);
    }
    viaStaffPath = true;
  }

  const adminClient = resolvedDeps.createAdminClient();

  // SPECS-INDEX #972(跨商家 IDOR 修補):授權只確認「呼叫者能管理 merchant_id」,booking_id 是呼叫者
  // 自己填的。這裡確認那筆訂單真的屬於 merchant_id;不符 → 404、查詢出錯 → 500,兩者都在
  // dispatchPushForBooking 之前結束 —— 推播紀錄、站內通知一筆都不寫(dispatchPushForBooking 連
  // event_disabled 那種跳過也會寫一列紀錄,所以這道檢查一定要放在它前面)。
  const ownershipLookup = (resolvedDeps.createOwnershipLookup ?? buildNotifySubjectOwnershipLookup)(
    adminClient,
  );
  const ownership = await checkNotifySubjectsBelongToMerchant(ownershipLookup, merchantId, {
    bookingId,
  });
  if (!ownership.ok) {
    return ownership.reason === "not_found"
      ? jsonResponse({ error: NOTIFY_SUBJECT_NOT_FOUND_MESSAGE }, 404)
      : jsonResponse({ error: NOTIFY_SUBJECT_LOOKUP_FAILED_MESSAGE }, 500);
  }

  const pushDeps = buildPushDispatchDeps(adminClient, {
    subject: config.vapidSubject,
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
  });

  // 🔴 #977 第 7 批(資安):服務人員路徑**不採信**呼叫端自由填的欄位 ——
  //   ・previous_staff_id 一律忽略:服務人員不能換主要服務人員,帶了只會讓別人收到「已從你的行程移除」的假通知。
  //   ・change_summary 一律改用伺服器端固定文字(STAFF_PATH_CHANGE_SUMMARY),不能讓服務人員自訂推播內容送給別人。
  //   管理員 / 客服路徑完全照舊。
  const staffSafe = resolveStaffSafeDispatchFields(viaStaffPath, body);
  const result = await dispatchPushForBooking(pushDeps, {
    merchantId,
    bookingId,
    eventType,
    changeSummary: staffSafe.changeSummary,
    // #823:空字串視同沒帶,不要讓 "" 走進去被當成一個 staff id 去查。
    previousStaffId: staffSafe.previousStaffId,
    // #986 第 9 批(使用者裁決):服務人員改單 / 拖拉不通知客戶 ⇒ 收件人硬過濾只留商家內部。
    internalRecipientsOnly: viaStaffPath && eventType === "booking_updated",
  });

  return jsonResponse({ ...result }, 200);
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
