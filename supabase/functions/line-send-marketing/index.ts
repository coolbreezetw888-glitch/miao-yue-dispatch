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
  // §10.2(SPECS-INDEX #612 問題 2):黑名單「無例外」規則的伺服器端第二道防線——不能只信任
  // 前端已經把黑名單會員從勾選名單濾掉,這裡查回會員資料時一併帶出 is_blacklisted,
  // buildMarketingDispatchPlan 會用這個欄位強制擋下,不管呼叫端(不管是不是正常的前端畫面)
  // 傳了哪些 member_id 進來。
  is_blacklisted: boolean;
}

export interface MarketingDispatchPlanItem {
  memberId: string;
  status: "will_send" | "skipped_not_bound" | "skipped_blacklisted";
  name: string;
  lineUserId: string | null;
}

/**
 * 3.15 純函式:依查回來的會員資料,決定每個 member_id 的處理計畫(要發送/因未綁定而跳過/
 * 因黑名單而跳過)。跟實際的資料庫/LINE API 呼叫分離,方便測試(未綁定會員被跳過且記錄
 * skip_reason='target_not_bound';§10.2 黑名單會員一律跳過,而且優先權比「有沒有綁定」更高
 * ——即使黑名單會員剛好也已經綁定 LINE,一樣不會被標記成 will_send)。
 */
export function buildMarketingDispatchPlan(
  requestedMemberIds: string[],
  members: MarketingMemberRow[],
): MarketingDispatchPlanItem[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return requestedMemberIds.map((memberId) => {
    const member = byId.get(memberId);
    // §10.2(SPECS-INDEX #612 問題 2):黑名單「無例外」——這個判斷放在最前面,優先權高於
    // 「有沒有綁定 LINE」,不管前端傳了什麼進來都一律擋下,不會被標記成 will_send。
    if (member?.is_blacklisted) {
      return {
        memberId,
        status: "skipped_blacklisted",
        name: member.name,
        lineUserId: null,
      };
    }
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

  // §10.2(SPECS-INDEX #612 問題 2):一併查 is_blacklisted,不能只信任前端已經把黑名單會員
  // 濾掉——見 buildMarketingDispatchPlan 的強制擋下邏輯。
  const { data: members, error: membersError } = await adminClient
    .from("members")
    .select("id, name, line_bound, line_user_id, is_blacklisted")
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
    if (item.status === "skipped_blacklisted") {
      // §10.2(SPECS-INDEX #612 問題 2):黑名單「無例外」規則的伺服器端第二道防線——不管
      // 前端傳了什麼進來,is_blacklisted=true 的會員一律不會被發送。skip_reason 的 CHECK
      // 約束目前只允許 not_configured/event_disabled/target_not_bound/no_target 四種列舉值,
      // 沒有『黑名單』這個選項(新增列舉值需要另外一次資料庫 migration,這次先只做「絕對擋下
      // 發送」這件事本身,不擅自更動 schema),所以這裡 skip_reason 留 null(CHECK 允許
      // null),可讀的原因改寫進沒有額外限制的 error_detail,確保這筆跳過依然留下稽核紀錄。
      skippedCount += 1;
      await adminClient.from("line_notification_log").insert({
        merchant_id: merchantId,
        event_type: "marketing_manual",
        target_type: "member",
        target_id: item.memberId,
        status: "skipped",
        error_detail: "黑名單客戶,系統自動排除,不會發送(伺服器端強制擋下,不論前端是否已經濾掉)",
        created_by_user_id: createdByUserId,
      });
      continue;
    }
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
