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
//   4. 有實際會發送的目標 → 呼叫 render_booking_notification_variables 取得變數(booking 事件),
//      用範本(merchant_line_event_settings.message_template)做字串替換,對每個目標呼叫
//      LINE push API,依回應寫入 line_notification_log。
//
// 本模組最重要的邊界原則(對應規則 2.4 第 4 點):前端呼叫這支函式一律用「不等待、吞掉錯誤」的
// 方式(見 src/modules/line-notifications/api.ts dispatchLineNotification),即使這支函式
// 整個掛掉或逾時,原本的訂單/請假操作完全不受影響。這支函式本身的責任只是盡力而為地判斷/發送/
// 記錄,不需要對前端保證一定成功。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  reason: "target_not_bound" | "no_target";
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

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
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

  // 步驟 1:用呼叫者自己的 JWT 驗證授權,防止濫發。
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: allowed, error: authCheckError } = await callerClient.rpc(
    "can_dispatch_line_notification",
    { p_merchant_id: merchantId, p_event_type: eventType },
  );

  if (authCheckError) {
    console.error("[line-notify-dispatch] can_dispatch_line_notification 呼叫失敗", authCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
  }
  if (!allowed) {
    return jsonResponse({ error: "沒有權限對這個商家/訂單發送通知" }, 403);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 步驟 2:共用邏輯,跟 3.10 preview_line_notification_targets 判斷「要不要發」完全一致。
  const { data: resolved, error: resolveError } = await adminClient.rpc(
    "resolve_line_notification_targets",
    {
      p_merchant_id: merchantId,
      p_event_type: eventType,
      p_booking_id: body.booking_id ?? null,
      p_staff_leave_record_id: body.staff_leave_record_id ?? null,
    },
  );

  if (resolveError) {
    console.error("[line-notify-dispatch] resolve_line_notification_targets 呼叫失敗", resolveError);
    return jsonResponse({ error: "判斷通知對象時發生錯誤" }, 500);
  }

  const result = resolved as ResolveTargetsResult;

  // 步驟 3:沒有任何目標(not_configured/event_disabled)→ 直接回 200,不寫入任何記錄。
  if (!shouldWriteAnyLogRow(result)) {
    return jsonResponse({ dispatched: false, reason: !result.connected ? "not_configured" : "event_disabled" }, 200);
  }

  // 寫入 skipped 對象的記錄。
  for (const skipped of result.skipped) {
    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: body.booking_id ?? null,
      staff_leave_record_id: body.staff_leave_record_id ?? null,
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

  let variables: Record<string, string> = {};
  if (body.booking_id) {
    const { data: vars, error: varsError } = await adminClient.rpc(
      "render_booking_notification_variables",
      { p_booking_id: body.booking_id },
    );
    if (varsError) {
      console.error("[line-notify-dispatch] render_booking_notification_variables 失敗", varsError);
    } else {
      variables = (vars as Record<string, string>) ?? {};
    }
  }

  const messageTemplate = (settingsRow?.message_template as string) ?? "";
  const renderedMessage = renderMessageTemplate(messageTemplate, variables);
  const channelAccessToken = (configRow?.channel_access_token as string) ?? "";

  let sentCount = 0;
  let failedCount = 0;

  for (const target of result.targets) {
    const pushResult = await pushLineMessage(fetch, channelAccessToken, target.line_user_id, renderedMessage);

    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: body.booking_id ?? null,
      staff_leave_record_id: body.staff_leave_record_id ?? null,
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

  return jsonResponse({ dispatched: true, sentCount, failedCount, skippedCount: result.skipped.length }, 200);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
