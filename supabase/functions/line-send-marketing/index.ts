// 模組 11:LINE 通知 — Edge Function line-send-marketing
// 對應規格書 3.15,規則 2.6(核心必測:只給商家管理員,不透過 line_notification 權限開放)。
//
// 流程:
//   1. 驗證呼叫者是 private.is_merchant_admin(merchant_id)(用 am_i_merchant_admin 這支既有
//      公開包裝函式,比照 invite-merchant-agent/line-test-connection 既有寫法)。
//   2. 對每個 member_id 查 members.line_bound,true 的才實際呼叫 push API(逐一呼叫,不用
//      multicast——理由:逐一呼叫才能取得每個對象各自的成功/失敗狀態,寫入獨立的
//      line_notification_log 記錄)。
//   3. message 支援 {{member_name}} 變數替換。event_type='marketing_manual',
//      created_by_user_id 記錄觸發的管理員。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// pushLineMessage/renderMessageTemplate 這兩支小函式跟 line-notify-dispatch/index.ts 裡的
// 完全一樣——刻意不用跨 function 的相對路徑 import 共用,因為 Supabase Edge Function 是每個
// function 目錄各自獨立部署的單位,跨目錄 import 會讓部署變得脆弱(部署其中一個 function 時
// 容易漏帶另一個目錄的檔案)。這兩支函式邏輯很單純、重複維護成本低,比照判斷 11「前端/Edge
// Function 各自各寫一份」的同一套理由,這裡是「Edge Function 之間也各自各寫一份」。

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

/** 判斷 11:文案範本變數替換的純函式。找 {{變數名稱}} 換成對應的值。 */
export function renderMessageTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

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

export interface MarketingRequestBody {
  merchant_id?: string;
  member_ids?: string[];
  message?: string;
}

export interface MarketingMemberRow {
  id: string;
  name: string;
  line_bound: boolean;
  line_user_id: string | null;
}

export interface MarketingDispatchPlanItem {
  memberId: string;
  status: "will_send" | "skipped_not_bound";
  name: string;
  lineUserId: string | null;
}

/**
 * 3.15 純函式:依查回來的會員資料,決定每個 member_id 的處理計畫(要發送/因未綁定而跳過)。
 * 跟實際的資料庫/LINE API 呼叫分離,方便測試(未綁定會員被跳過且記錄 skip_reason='target_not_bound')。
 */
export function buildMarketingDispatchPlan(
  requestedMemberIds: string[],
  members: MarketingMemberRow[],
): MarketingDispatchPlanItem[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return requestedMemberIds.map((memberId) => {
    const member = byId.get(memberId);
    if (!member || !member.line_bound || !member.line_user_id) {
      return {
        memberId,
        status: "skipped_not_bound",
        name: member?.name ?? "",
        lineUserId: null,
      };
    }
    return {
      memberId,
      status: "will_send",
      name: member.name,
      lineUserId: member.line_user_id,
    };
  });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[line-send-marketing] 缺少必要的環境變數");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少登入憑證" }, 401);
  }

  let body: MarketingRequestBody;
  try {
    body = (await req.json()) as MarketingRequestBody;
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const merchantId = body.merchant_id?.trim();
  const memberIds = body.member_ids ?? [];
  const message = body.message?.trim();

  if (!merchantId || memberIds.length === 0 || !message) {
    return jsonResponse({ error: "缺少必要欄位(merchant_id/member_ids/message)" }, 400);
  }

  // 規則 2.6(核心必測):只給商家管理員,不接受客服呼叫(即使有 line_notification 權限)。
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc(
    "am_i_merchant_admin",
    { p_merchant_id: merchantId },
  );

  if (adminCheckError) {
    console.error("[line-send-marketing] am_i_merchant_admin 呼叫失敗", adminCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
  }
  if (!isAdmin) {
    return jsonResponse({ error: "沒有權限執行此操作,僅限該商家管理員使用" }, 403);
  }

  const { data: userData } = await callerClient.auth.getUser();
  const createdByUserId = userData?.user?.id ?? null;

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: members, error: membersError } = await adminClient
    .from("members")
    .select("id, name, line_bound, line_user_id")
    .eq("merchant_id", merchantId)
    .in("id", memberIds);

  if (membersError) {
    console.error("[line-send-marketing] 查詢 members 失敗", membersError);
    return jsonResponse({ error: "查詢會員資料時發生錯誤" }, 500);
  }

  const plan = buildMarketingDispatchPlan(memberIds, (members ?? []) as MarketingMemberRow[]);

  const { data: configRow } = await adminClient
    .from("merchant_line_configs")
    .select("channel_access_token")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  const channelAccessToken = (configRow?.channel_access_token as string) ?? "";

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const item of plan) {
    if (item.status === "skipped_not_bound") {
      skippedCount += 1;
      await adminClient.from("line_notification_log").insert({
        merchant_id: merchantId,
        event_type: "marketing_manual",
        target_type: "member",
        target_id: item.memberId,
        status: "skipped",
        skip_reason: "target_not_bound",
        created_by_user_id: createdByUserId,
      });
      continue;
    }

    const renderedMessage = renderMessageTemplate(message, { member_name: item.name });
    const pushResult = await pushLineMessage(
      fetch,
      channelAccessToken,
      item.lineUserId as string,
      renderedMessage,
    );

    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: "marketing_manual",
      target_type: "member",
      target_id: item.memberId,
      target_line_user_id: item.lineUserId,
      status: pushResult.ok ? "sent" : "failed",
      error_detail: pushResult.ok ? null : pushResult.errorDetail,
      rendered_message: renderedMessage,
      created_by_user_id: createdByUserId,
    });

    if (pushResult.ok) sentCount += 1;
    else failedCount += 1;
  }

  return jsonResponse({ sentCount, failedCount, skippedCount }, 200);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
