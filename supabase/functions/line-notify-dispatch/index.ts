// 模組 11:LINE 通知 — Edge Function line-notify-dispatch
// 對應規格書 3.14(判斷 1/10),規則 2.4(安靜跳過、絕不影響原本業務操作)。
//
// 流程:
//   1. 用呼叫者的 JWT 驗證 can_dispatch_line_notification(merchant_id, event_type)——
//      staff_leave_created 檢查 can_manage_team_leave,其餘事件檢查 can_manage_bookings。
//      防止任何已登入使用者對不相關的商家/訂單濫發通知呼叫。
//   2. 用 service role client 呼叫 resolve_line_notification_targets 取得目標清單
//      (跟 3.10 preview_line_notification_targets 共用同一份判斷邏輯,不重寫一次)。
//   3. 沒有任何目標(not_configured/event_disabled)→ 直接回 200,不寫入 line_notification_log。
//      有目標(即使全部落在 skipped)→ 正常依規則 2.4 寫入對應 skip_reason 的記錄。
//   4. 有實際會發送的目標 → 依 booking_id 呼叫 render_booking_notification_variables 或依
//      staff_leave_record_id 呼叫 render_staff_leave_notification_variables 取得變數,用範本
//      (merchant_line_event_settings.message_template)做字串替換,對每個目標呼叫 LINE push
//      API,依回應寫入 line_notification_log。
//
// bug fix(SPECS-INDEX 385):staff_leave_created 事件傳的是 staff_leave_record_id(沒有
// booking_id),原本這裡只在 body.booking_id 有值時才取變數,導致 staff_leave_created 的變數
// 永遠是空物件 {},文案裡的 {{staff_name}}/{{booking_date}} 沒有被替換、原樣送給收訊人看到。
// 修法見 resolveNotificationVariables:依實際傳入的是 booking_id 還是 staff_leave_record_id,
// 呼叫對應的變數組裝函式(20260920160600 migration 新增 render_staff_leave_notification_variables)。
//
// SPECS-INDEX #972(跨商家 IDOR 修補):授權只確認「呼叫者能管理 merchant_id」還不夠——booking_id /
// staff_leave_record_id 是呼叫者自己填的。現在授權通過之後、解析收件人之前,先確認那筆訂單/請假紀錄
// 真的屬於 merchant_id(_shared/notifySubjectOwnership.ts);不符回 404、查詢出錯回 500,兩者都不寫任何
// 發送記錄。資料庫那一層(resolve_line_notification_targets / render_*_notification_variables)
// 也有同樣的檢查(migration 20261001150000),兩層都擋。為了能用 Deno 測試驗證這個分支,
// handleRequest 比照 push-notify-dispatch 改成可注入 deps、環境變數改在執行當下讀取。
//
// 本模組最重要的邊界原則(對應規則 2.4 第 4 點):前端呼叫這支函式一律用「不等待、吞掉錯誤」的
// 方式(見 src/modules/line-notifications/api.ts dispatchLineNotification),即使這支函式
// 整個掛掉或逾時,原本的訂單/請假操作完全不受影響。這支函式本身的責任只是盡力而為地判斷/發送/
// 記錄,不需要對前端保證一定成功。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import {
  buildNotifySubjectOwnershipLookup,
  checkNotifySubjectsBelongToMerchant,
  NOTIFY_SUBJECT_LOOKUP_FAILED_MESSAGE,
  NOTIFY_SUBJECT_NOT_FOUND_MESSAGE,
  type NotifySubjectOwnershipLookup,
} from "../_shared/notifySubjectOwnership.ts";
import { checkStaffBookingDispatch } from "../_shared/staffBookingDispatch.ts";

// #972:環境變數改在 handleRequest 執行當下才讀(理由同 push-notify-dispatch:模組頂層讀成常數,
// Deno 測試在 import 之前 set 的值會讀不到)。
function readEnvConfig() {
  return {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
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

export type NotificationEventType =
  | "booking_created"
  | "booking_confirmed"
  | "booking_cancelled"
  | "booking_completed"
  | "staff_leave_created";

export interface DispatchRequestBody {
  merchant_id?: string;
  booking_id?: string;
  staff_leave_record_id?: string;
  event_type?: NotificationEventType;
}

export interface ResolvedTarget {
  type: "admin" | "agent" | "staff" | "member";
  id: string;
  name: string;
  line_user_id: string;
}

export interface SkippedTarget {
  type: "admin" | "agent" | "staff" | "member";
  id: string | null;
  // SPECS-INDEX #962:staff_inactive(服務人員已離職/停用)、staff_calendar_view_off(未開放行事曆檢視)
  // 由 resolve_line_notification_targets 判斷後原樣寫進 line_notification_log.skip_reason。
  reason: "target_not_bound" | "no_target" | "staff_inactive" | "staff_calendar_view_off";
}

export interface ResolveTargetsResult {
  connected: boolean;
  event_enabled: boolean;
  targets: ResolvedTarget[];
  skipped: SkippedTarget[];
}

// =========================================================================
// 判斷 11:文案範本變數替換的純函式。找 {{變數名稱}} 換成對應的值,前端(即時預覽)跟這裡
// (實際發送)各自各寫一份小型函式,這個專案的前端/Edge Function 執行環境彼此不共用程式碼
// (比照 invite-merchant-agent 的既有先例)。
// =========================================================================
export function renderMessageTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

export interface LinePushResult {
  ok: boolean;
  status: number;
  errorDetail: string | null;
}

/** 呼叫 LINE Push API,注入 fetch 方便測試。 */
export async function pushLineMessage(
  fetchImpl: typeof fetch,
  channelAccessToken: string,
  lineUserId: string,
  text: string,
): Promise<LinePushResult> {
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
    });
    if (res.ok) {
      return { ok: true, status: res.status, errorDetail: null };
    }
    const errorBody = await res.text().catch(() => "");
    return { ok: false, status: res.status, errorDetail: errorBody || `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 呼叫 RPC 拿變數用的最小介面,方便測試時傳入假的 client(不需要整個 supabase-js SupabaseClient)。 */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * bug fix(SPECS-INDEX 385):依實際傳入的是 booking_id 還是 staff_leave_record_id,呼叫對應的
 * 變數組裝函式。booking 事件呼叫 render_booking_notification_variables(3.9),staff_leave_created
 * 呼叫 render_staff_leave_notification_variables(20260920160600 migration)。兩者都沒有
 * (理論上不該發生)則維持空物件。任何一邊呼叫失敗都只記 log、回傳空物件,不往外拋(對應規則
 * 2.4 第 4 點——變數組裝失敗不該影響通知/原本業務操作的其餘流程)。
 */
export async function resolveNotificationVariables(
  adminClient: RpcClient,
  merchantId: string,
  bookingId: string | null | undefined,
  staffLeaveRecordId: string | null | undefined,
): Promise<Record<string, string>> {
  // #972:兩支變數組裝函式都必須帶 p_merchant_id,資料庫會再確認一次訂單/請假紀錄屬於這間商家。
  if (bookingId) {
    const { data, error } = await adminClient.rpc("render_booking_notification_variables", {
      p_booking_id: bookingId,
      p_merchant_id: merchantId,
    });
    if (error) {
      console.error("[line-notify-dispatch] render_booking_notification_variables 失敗", error);
      return {};
    }
    return (data as Record<string, string>) ?? {};
  }

  if (staffLeaveRecordId) {
    const { data, error } = await adminClient.rpc("render_staff_leave_notification_variables", {
      p_staff_leave_record_id: staffLeaveRecordId,
      p_merchant_id: merchantId,
    });
    if (error) {
      console.error("[line-notify-dispatch] render_staff_leave_notification_variables 失敗", error);
      return {};
    }
    return (data as Record<string, string>) ?? {};
  }

  return {};
}

/**
 * 3.14 步驟 3 純函式:依 resolve_line_notification_targets 的結果,判斷要不要寫入
 * line_notification_log。not_configured/event_disabled(targets 跟 skipped 都是空的且
 * connected/event_enabled 任一為 false)→ 完全不寫入任何記錄。有 targets 或 skipped
 * (代表商家已連線且事件已開啟,只是個別對象的綁定狀態不同)→ 都要各自寫入。
 */
export function shouldWriteAnyLogRow(result: ResolveTargetsResult): boolean {
  if (!result.connected || !result.event_enabled) return false;
  return result.targets.length > 0 || result.skipped.length > 0;
}

// deno-lint-ignore no-explicit-any
type AnyAdminClient = any;

/** #972:可注入的相依,Deno 測試傳入假的 client 驗證授權 / 歸屬檢查分支。 */
export interface HandleRequestDeps {
  createCallerClient: (authHeader: string) => RpcClient;
  createAdminClient: () => AnyAdminClient;
  /** 不帶 → 用真正查資料庫的 buildNotifySubjectOwnershipLookup(adminClient)。 */
  createOwnershipLookup?: (adminClient: AnyAdminClient) => NotifySubjectOwnershipLookup;
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
    console.error("[line-notify-dispatch] 缺少必要的環境變數");
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
  const eventType = body.event_type;
  if (!merchantId || !eventType) {
    return jsonResponse({ error: "缺少必要欄位(merchant_id/event_type)" }, 400);
  }
  // #972:之後每一處(歸屬檢查、解析收件人、變數組裝、寫記錄)都用同一份值,不再各自讀 body。
  const bookingId = body.booking_id?.trim() || null;
  const staffLeaveRecordId = body.staff_leave_record_id?.trim() || null;

  // 步驟 1:用呼叫者自己的 JWT 驗證授權,防止濫發。
  const callerClient = resolvedDeps.createCallerClient(authHeader);

  const { data: allowed, error: authCheckError } = await callerClient.rpc(
    "can_dispatch_line_notification",
    { p_merchant_id: merchantId, p_event_type: eventType },
  );

  if (authCheckError) {
    console.error("[line-notify-dispatch] can_dispatch_line_notification 呼叫失敗", authCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
  }
  if (!allowed) {
    // SPECS-INDEX #977 第 7 批(2026-10-07):服務人員本人(開了「新增編輯訂單」)自己建單 / 改單 / 取消 / 完成後,
    // 前端用他自己的身分呼叫這支 ⇒ 上面那道(管理員 / 客服)一定不過。只有「有帶訂單 id」時才**再**用呼叫者身分問
    // can_staff_dispatch_booking_notification:本人是這張單的主要服務人員、可以自己下單、事件符合訂單現況才放行。
    // 原本就放行的人完全不經過這一段(行為不變)。
    const staffAllowed = await checkStaffBookingDispatch(callerClient, merchantId, bookingId, eventType);
    if (staffAllowed === "error") {
      return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
    }
    if (!staffAllowed) {
      return jsonResponse({ error: "沒有權限對這個商家/訂單發送通知" }, 403);
    }
  }

  const adminClient = resolvedDeps.createAdminClient();

  // 步驟 1.5(#972):傳入的訂單/請假紀錄必須屬於 merchant_id。不符 → 404、查詢出錯 → 500,
  // 兩者都在解析收件人之前就結束,一筆發送記錄都不寫。
  const ownershipLookup = (resolvedDeps.createOwnershipLookup ?? buildNotifySubjectOwnershipLookup)(
    adminClient,
  );
  const ownership = await checkNotifySubjectsBelongToMerchant(ownershipLookup, merchantId, {
    bookingId,
    staffLeaveRecordId,
  });
  if (!ownership.ok) {
    return ownership.reason === "not_found"
      ? jsonResponse({ error: NOTIFY_SUBJECT_NOT_FOUND_MESSAGE }, 404)
      : jsonResponse({ error: NOTIFY_SUBJECT_LOOKUP_FAILED_MESSAGE }, 500);
  }

  // 步驟 2:共用邏輯,跟 3.10 preview_line_notification_targets 判斷「要不要發」完全一致。
  const { data: resolved, error: resolveError } = await adminClient.rpc(
    "resolve_line_notification_targets",
    {
      p_merchant_id: merchantId,
      p_event_type: eventType,
      p_booking_id: bookingId,
      p_staff_leave_record_id: staffLeaveRecordId,
    },
  );

  if (resolveError) {
    console.error(
      "[line-notify-dispatch] resolve_line_notification_targets 呼叫失敗",
      resolveError,
    );
    return jsonResponse({ error: "判斷通知對象時發生錯誤" }, 500);
  }

  const result = resolved as ResolveTargetsResult;

  // 步驟 3:沒有任何目標(not_configured/event_disabled)→ 直接回 200,不寫入任何記錄。
  if (!shouldWriteAnyLogRow(result)) {
    return jsonResponse(
      { dispatched: false, reason: !result.connected ? "not_configured" : "event_disabled" },
      200,
    );
  }

  // 寫入 skipped 對象的記錄。
  for (const skipped of result.skipped) {
    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      staff_leave_record_id: staffLeaveRecordId,
      target_type: skipped.type,
      target_id: skipped.id,
      status: "skipped",
      skip_reason: skipped.reason,
    });
  }

  if (result.targets.length === 0) {
    return jsonResponse({ dispatched: false, skippedCount: result.skipped.length }, 200);
  }

  // 步驟 4:有實際目標,取變數 + 範本渲染 + 逐一呼叫 LINE push API。
  const { data: configRow } = await adminClient
    .from("merchant_line_configs")
    .select("channel_access_token")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  const { data: settingsRow } = await adminClient
    .from("merchant_line_event_settings")
    .select("message_template")
    .eq("merchant_id", merchantId)
    .eq("event_type", eventType)
    .maybeSingle();

  const variables = await resolveNotificationVariables(
    adminClient,
    merchantId,
    bookingId,
    staffLeaveRecordId,
  );

  const messageTemplate = (settingsRow?.message_template as string) ?? "";
  const renderedMessage = renderMessageTemplate(messageTemplate, variables);
  const channelAccessToken = (configRow?.channel_access_token as string) ?? "";

  let sentCount = 0;
  let failedCount = 0;

  for (const target of result.targets) {
    const pushResult = await pushLineMessage(
      fetch,
      channelAccessToken,
      target.line_user_id,
      renderedMessage,
    );

    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      staff_leave_record_id: staffLeaveRecordId,
      target_type: target.type,
      target_id: target.id,
      target_line_user_id: target.line_user_id,
      status: pushResult.ok ? "sent" : "failed",
      error_detail: pushResult.ok ? null : pushResult.errorDetail,
      rendered_message: renderedMessage,
    });

    if (pushResult.ok) sentCount += 1;
    else failedCount += 1;
  }

  return jsonResponse(
    { dispatched: true, sentCount, failedCount, skippedCount: result.skipped.length },
    200,
  );
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
