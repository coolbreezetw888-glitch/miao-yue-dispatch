// 模組 11:LINE 通知 — Edge Function line-send-marketing
// 對應規格書 3.15,規則 2.6(核心必測:不透過 line_notification 權限開放)。
// SPECS-INDEX #976 第 3 批(2026-10-06):新增客服權限「再行銷通知」(line_marketing)。允許對象從
// 「只有商家管理員」改成「商家管理員,或 line_marketing 權限開啟的在職客服」—— 仍然**不**因為
// line_notification 權限放行(那是另一把鑰匙)。
//
// 流程:
//   1. 驗證呼叫者是 private.can_send_line_marketing(merchant_id)(用 am_i_allowed_line_marketing 這支
//      公開包裝函式,以呼叫者自己的 JWT 執行;改前用 am_i_merchant_admin)。
//   2. 對每個 member_id 查 members.line_bound,true 的才實際呼叫 push API(逐一呼叫,不用
//      multicast——理由:逐一呼叫才能取得每個對象各自的成功/失敗狀態,寫入獨立的
//      line_notification_log 記錄)。
//   3. message 支援 {{member_name}} 變數替換。event_type='marketing_manual',
//      created_by_user_id 記錄觸發的管理員。
//
// 客戶端第 5-B 批 C5-P01(#1047):照客人的「優惠通知」開關發。
//   ・會員資料改由 internal_line_marketing_candidates(service_role)一次取回:會員 + 每位聯絡人
//     (這間店 LINE 登入 channel 的身分、notify_promo、好友狀態)。
//   ・有聯絡人 ⇒ 每位「優惠通知」開著的聯絡人各發一則;關掉的寫 skipped / customer_opted_out;
//     沒有這間店 LINE 身分 ⇒ target_not_bound;已知沒加好友 ⇒ not_friend。
//   ・沒有聯絡人、用舊綁定碼綁過的會員 ⇒ 照舊發 members.line_user_id(已知非好友 ⇒ not_friend)。
//   ・黑名單仍然優先擋(伺服器端第二道防線)。發送前確認窗的則數由 preview_line_marketing_recipients 算,規則同這裡。
//   ・一次最多 5000 位會員。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import {
  checkMerchantFeature,
  FEATURE_LINE_MARKETING,
  MERCHANT_FEATURE_DISABLED_MESSAGE,
} from "../_shared/featureGate.ts";
import { errorCode } from "../_shared/safeLog.ts";
import { getLineMessagingCredentials } from "../_shared/lineCredentials.ts";

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

// #1051(H1-25):handleRequest 改成可注入相依(比照 line-webhook),環境變數改在執行當下讀。
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** 可注入的相依(Deno 測試傳假的 client / fetch)。 */
export interface HandleRequestDeps {
  env?: (k: string) => string | undefined;
  /** 以呼叫者自己的 JWT 建立的 client(權限檢查用)。 */
  createCallerClient?: (authHeader: string) => AnyClient;
  /** service role client。 */
  createAdminClient?: () => AnyClient;
  fetchImpl?: typeof fetch;
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

export interface MarketingRequestBody {
  merchant_id?: string;
  member_ids?: string[];
  message?: string;
}

/** C5-P01:會員的一位聯絡人(由 internal_line_marketing_candidates 取回)。 */
export interface MarketingContactRow {
  user_id: string;
  /** 這間店 LINE 登入 channel 的身分;沒有 ⇒ null。 */
  line_user_id: string | null;
  notify_promo: boolean;
  friend_status: "friend" | "not_friend" | "unknown";
}

export interface MarketingMemberRow {
  id: string;
  name: string;
  /** 沒有聯絡人時才可能是 true(舊綁定碼會員)。 */
  line_bound: boolean;
  line_user_id: string | null;
  /** C5-P01:active 聯絡人;沒有 / 空陣列 ⇒ 走舊綁定碼規則。 */
  contacts?: MarketingContactRow[];
  /** 舊綁定碼會員的好友狀態。 */
  legacy_friend_status?: "friend" | "not_friend" | "unknown";
  // §10.2(SPECS-INDEX #612 問題 2):黑名單「無例外」規則的伺服器端第二道防線——不能只信任
  // 前端已經把黑名單會員從勾選名單濾掉,這裡查回會員資料時一併帶出 is_blacklisted,
  // buildMarketingDispatchPlan 會用這個欄位強制擋下,不管呼叫端(不管是不是正常的前端畫面)
  // 傳了哪些 member_id 進來。
  is_blacklisted: boolean;
}

export interface MarketingDispatchPlanItem {
  memberId: string;
  status: "will_send" | "skipped_not_bound" | "skipped_blacklisted" | "skipped_opted_out" | "skipped_not_friend";
  name: string;
  lineUserId: string | null;
  /** C5-P01:收到 / 被略過的聯絡人帳號(舊綁定碼會員、黑名單、找不到會員 ⇒ null)。 */
  targetUserId: string | null;
}

export const MARKETING_MAX_MEMBERS = 5000;

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
  const plan: MarketingDispatchPlanItem[] = [];
  for (const memberId of requestedMemberIds) {
    const member = byId.get(memberId);
    // §10.2(SPECS-INDEX #612 問題 2):黑名單「無例外」——這個判斷放在最前面,優先權高於
    // 「有沒有綁定 LINE」,不管前端傳了什麼進來都一律擋下,不會被標記成 will_send。
    if (member?.is_blacklisted) {
      plan.push({ memberId, status: "skipped_blacklisted", name: member.name, lineUserId: null, targetUserId: null });
      continue;
    }
    if (!member) {
      plan.push({ memberId, status: "skipped_not_bound", name: "", lineUserId: null, targetUserId: null });
      continue;
    }
    const contacts = member.contacts ?? [];
    if (contacts.length > 0) {
      // C5-P01:每位聯絡人自己的「優惠通知」開關。
      for (const c of contacts) {
        const base = { memberId, name: member.name, targetUserId: c.user_id };
        if (!c.notify_promo) {
          plan.push({ ...base, status: "skipped_opted_out", lineUserId: null });
        } else if (!c.line_user_id) {
          plan.push({ ...base, status: "skipped_not_bound", lineUserId: null });
        } else if (c.friend_status === "not_friend") {
          plan.push({ ...base, status: "skipped_not_friend", lineUserId: null });
        } else {
          plan.push({ ...base, status: "will_send", lineUserId: c.line_user_id });
        }
      }
      continue;
    }
    if (!member.line_bound || !member.line_user_id) {
      plan.push({ memberId, status: "skipped_not_bound", name: member.name, lineUserId: null, targetUserId: null });
      continue;
    }
    if (member.legacy_friend_status === "not_friend") {
      plan.push({ memberId, status: "skipped_not_friend", name: member.name, lineUserId: null, targetUserId: null });
      continue;
    }
    plan.push({ memberId, status: "will_send", name: member.name, lineUserId: member.line_user_id, targetUserId: null });
  }
  return plan;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }
  const env = deps?.env ?? ((k: string) => Deno.env.get(k));
  const SUPABASE_URL = env("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const injected = Boolean(deps?.createCallerClient && deps?.createAdminClient);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  if (!injected && (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)) {
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
  if (!Array.isArray(memberIds) || memberIds.length > MARKETING_MAX_MEMBERS) {
    return jsonResponse({ error: `一次最多選 ${MARKETING_MAX_MEMBERS} 位會員` }, 400);
  }

  // 規則 2.6(核心必測)+ #976 第 3 批:商家管理員或 line_marketing 客服才放行;
  // 只有 line_notification 權限的客服照樣擋下。
  const callerClient = deps?.createCallerClient
    ? deps.createCallerClient(authHeader)
    : createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

  const { data: isAllowed, error: permissionCheckError } = await callerClient.rpc(
    "am_i_allowed_line_marketing",
    { p_merchant_id: merchantId },
  );

  if (permissionCheckError) {
    console.error("[line-send-marketing] am_i_allowed_line_marketing 呼叫失敗", errorCode(permissionCheckError));
    return jsonResponse({ error: "驗證權限時發生錯誤" }, 500);
  }
  if (isAllowed !== true) {
    return jsonResponse(
      { error: "沒有權限執行此操作，僅限該商家管理員或已開啟「再行銷通知」權限的客服使用" },
      403,
    );
  }

  const { data: userData } = await callerClient.auth.getUser();
  const createdByUserId = userData?.user?.id ?? null;

  const adminClient = deps?.createAdminClient
    ? deps.createAdminClient()
    : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

  // SPECS-INDEX #1025 FG2-F01:平台沒開「再行銷通知」(或它的主功能「LINE 通知」;細部功能在主功能關時
  // 自動為關)⇒ 403「這個功能目前沒有開放。」。放在權限檢查之後:沒權限的人照舊拿到原本的 403。
  // service role 呼叫 internal_merchant_has_feature 自己檢查(X7);查詢失敗 ⇒ 500,一則都不發。
  const marketingFeature = await checkMerchantFeature(adminClient, merchantId, FEATURE_LINE_MARKETING);
  if (marketingFeature === "error") {
    console.error("[line-send-marketing] internal_merchant_has_feature 呼叫失敗");
    return jsonResponse({ error: "檢查功能開關時發生錯誤" }, 500);
  }
  if (!marketingFeature) {
    return jsonResponse({ error: MERCHANT_FEATURE_DISABLED_MESSAGE }, 403);
  }

  // §10.2(SPECS-INDEX #612 問題 2):一併查 is_blacklisted,不能只信任前端已經把黑名單會員
  // 濾掉——見 buildMarketingDispatchPlan 的強制擋下邏輯。
  // C5-P01:連同每位聯絡人(LINE 身分、優惠通知開關、好友狀態)一起取回;只回這間店的會員。
  const { data: members, error: membersError } = await adminClient.rpc("internal_line_marketing_candidates", {
    p_merchant_id: merchantId,
    p_member_ids: memberIds,
  });

  if (membersError) {
    console.error("[line-send-marketing] 查詢會員資料失敗");
    return jsonResponse({ error: "查詢會員資料時發生錯誤" }, 500);
  }

  const plan = buildMarketingDispatchPlan(memberIds, (members ?? []) as MarketingMemberRow[]);

  // #1053:金鑰改存 Vault,透過 service_role 專用 RPC 取。讀不到 ⇒ 當作 LINE 未設定,一則都不發、不寫記錄。
  const credentials = await getLineMessagingCredentials(adminClient, merchantId, "[line-send-marketing]");
  if (!credentials) {
    return jsonResponse({ error: "尚未設定 LINE 串接憑證，無法發送" }, 400);
  }
  const channelAccessToken = credentials.channelAccessToken;

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
        error_detail: "黑名單客戶，系統自動排除，不會發送(伺服器端強制擋下，不論前端是否已經濾掉)",
        created_by_user_id: createdByUserId,
      });
      continue;
    }
    if (item.status !== "will_send") {
      // skipped_not_bound / skipped_opted_out(C5-P01 客人關掉優惠通知)/ skipped_not_friend(已知沒加好友)
      skippedCount += 1;
      await adminClient.from("line_notification_log").insert({
        merchant_id: merchantId,
        event_type: "marketing_manual",
        target_type: "member",
        target_id: item.memberId,
        target_user_id: item.targetUserId,
        status: "skipped",
        skip_reason: item.status === "skipped_opted_out"
          ? "customer_opted_out"
          : item.status === "skipped_not_friend"
          ? "not_friend"
          : "target_not_bound",
        created_by_user_id: createdByUserId,
      });
      continue;
    }

    const renderedMessage = renderMessageTemplate(message, { member_name: item.name });
    const pushResult = await pushLineMessage(
      fetchImpl,
      channelAccessToken,
      item.lineUserId as string,
      renderedMessage,
    );

    await adminClient.from("line_notification_log").insert({
      merchant_id: merchantId,
      event_type: "marketing_manual",
      target_type: "member",
      target_id: item.memberId,
      target_user_id: item.targetUserId,
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
  Deno.serve((req) => handleRequest(req));
}
