// 模組 3:人員與權限管理 — Edge Function invite-merchant-agent
// 對應規格書 3.5:接收 { merchant_id, email, name, nickname?, phone? },流程:
//   1. 用呼叫者的 JWT 建立 anon-key client,呼叫 am_i_merchant_admin(merchant_id)(3.2)——
//      回傳 false 就直接拒絕(403)。這是規格書明確要求的「第一步先驗證權限」,不是收到請求就
//      無條件執行特權操作。
//   2. 用 service_role key 建立另一個 client,查詢這個 email 的 auth.users 帳號與開通狀態(規則 2.6)。
//      - 已開通:略過寄信,取得該帳號的 user_id。
//      - 不存在:呼叫 auth.admin.inviteUserByEmail(...),取得新建立的 user_id。
//      - 第 13 批 #1002:存在但還沒開通(別家商家邀請過、對方還沒設密碼):重寄邀請信,狀態 invited。
//   3. 呼叫 record_invited_merchant_agent(...)(3.6,用 service_role client 呼叫),
//      依步驟 2 的結果決定 status 是 'active' 還是 'invited'。
//   4. 回傳成功/失敗結果給前端,失敗訊息要清楚。
//
// 金鑰安全(規格書 3.5 邊界情況,呼應開發流程紀錄第九章):SUPABASE_SERVICE_ROLE_KEY 只從
// Supabase 專案的 Edge Function 環境變數讀取,不寫死在程式碼裡,也絕對不會回傳給前端。
//
// 2026-09-21 修正(對應規格書「服務人員管理優化與硬刪除」§1.2.3):整個處理邏輯包進
// try/catch,任何沒被預期到的例外一律回傳結構化的 JSON 500 錯誤,不會讓 Deno runtime
// 預設的非 JSON 錯誤格式害前端 `context.clone().json()` 解析失敗、只看到 Supabase SDK
// 的通用包裝訊息。這一層是保底,不取代已知失敗分支原本就有的明確錯誤訊息。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isValidTaiwanMobilePhone } from "../_shared/phoneValidation.ts";
import {
  resolveInviteAccount,
  supabaseInviteAccountDeps,
} from "../_shared/inviteAccountResolver.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// 客服點邀請信連結、設定密碼後導回的轉場頁(3.8 mark_agent_active_if_self 在這頁被呼叫)。
// 可用 Edge Function 環境變數 PUBLIC_SITE_URL 覆寫(例如本機測試時指向 localhost),
// 沒有設定就 fallback 到正式網址,不是機密資訊,寫死在程式碼裡沒有安全疑慮。
const PUBLIC_SITE_URL = Deno.env.get("PUBLIC_SITE_URL") ?? "https://miao-yue-dispatch.vercel.app";

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

interface InviteRequestBody {
  merchant_id?: string;
  email?: string;
  name?: string;
  nickname?: string | null;
  phone?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    return await handleInviteMerchantAgent(req);
  } catch (err) {
    console.error("[invite-merchant-agent] 未預期的例外", err);
    return jsonResponse({ error: "系統發生非預期錯誤，請稍後再試或聯絡系統管理員" }, 500);
  }
});

async function handleInviteMerchantAgent(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[invite-merchant-agent] 缺少必要的環境變數(SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY)",
    );
    return jsonResponse({ error: "伺服器設定不完整，請聯絡系統管理員" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少登入憑證，請重新登入後再試" }, 401);
  }

  let body: InviteRequestBody;
  try {
    body = (await req.json()) as InviteRequestBody;
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const merchantId = body.merchant_id?.trim();
  const rawEmail = body.email?.trim();
  const name = body.name?.trim();
  const nickname = body.nickname?.trim() || null;
  const phone = body.phone?.trim() || "";

  if (!merchantId || !rawEmail || !name || !phone) {
    return jsonResponse({ error: "缺少必要欄位(商家、Email、姓名、電話為必填)" }, 400);
  }

  // 規格書 §8.2:電話這次改為必填,Edge Function 內部也要用跟前端同一套正規表示式再驗證一次
  // (§8.3 的 isValidTaiwanMobilePhone,不能只信任前端已經檢查過),不符合格式直接回傳 400,
  // 不寄出邀請信、不寫入 merchant_agents。
  if (!isValidTaiwanMobilePhone(phone)) {
    return jsonResponse(
      { error: "電話格式不正確，請輸入正確的台灣手機號碼(09 開頭共 10 碼)，例如 0912345678" },
      400,
    );
  }

  const email = rawEmail.toLowerCase();

  // 步驟 1:用呼叫者自己的 JWT 驗證權限,不是收到請求就無條件執行特權操作。
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("am_i_merchant_admin", {
    p_merchant_id: merchantId,
  });

  if (adminCheckError) {
    console.error("[invite-merchant-agent] am_i_merchant_admin 呼叫失敗", adminCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤，請稍後再試" }, 500);
  }

  if (!isAdmin) {
    return jsonResponse({ error: "沒有權限執行此操作，僅限該商家管理員使用" }, 403);
  }

  // 步驟 2:service_role client,只在通過權限檢查後才建立/使用。
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 第 13 批 #1002:不能只看「auth 有沒有這個帳號」——別家商家寄過邀請、對方還沒開通時帳號也已經存在。
  // 判斷與寄信邏輯集中在 _shared/inviteAccountResolver.ts(跟 invite-merchant-staff 共用):
  //   查無帳號 → 寄邀請信(invited);已開通 → 規則 2.6 直接加入(active);
  //   有帳號但還沒開通 → 重寄邀請信 / 設定密碼信(invited),對方設好密碼後所有商家一起轉 active。
  const resolved = await resolveInviteAccount(
    email,
    `${PUBLIC_SITE_URL}/app/agent-invite-complete`,
    supabaseInviteAccountDeps(adminClient),
  );

  if (resolved.kind === "lookup_error") {
    console.error("[invite-merchant-agent] lookup_auth_account_by_email 呼叫失敗", resolved.error);
    return jsonResponse({ error: "查詢帳號時發生錯誤，請稍後再試" }, 500);
  }

  if (resolved.kind === "send_error") {
    return jsonResponse(
      {
        error: `邀請信寄送失敗：${resolved.message}(見規則 2.5，Supabase 免費方案寄信額度較低，若短時間內邀請多人可能會碰到這個限制)`,
      },
      502,
    );
  }

  const userId = resolved.userId;
  const status = resolved.status;
  // 只有「直接加入」時才是 true(前端據此顯示「已加為客服」而不是「邀請信已寄出」)。刻意不再用
  // 「auth 有沒有這個帳號」:那會讓呼叫者知道這個信箱是不是被別家商家邀請過還沒開通。
  const alreadyHadAccount = status === "active";

  // 步驟 3:寫入 merchant_agents(record_invited_merchant_agent 只授權給 service_role)。
  const { data: agentId, error: recordError } = await adminClient.rpc(
    "record_invited_merchant_agent",
    {
      p_merchant_id: merchantId,
      p_user_id: userId,
      p_invited_email: email,
      p_name: name,
      p_nickname: nickname,
      p_phone: phone,
      p_status: status,
    },
  );

  if (recordError) {
    console.error("[invite-merchant-agent] record_invited_merchant_agent 失敗", recordError);
    return jsonResponse({ error: recordError.message || "寫入客服資料失敗，請稍後再試" }, 500);
  }

  return jsonResponse(
    {
      agent_id: agentId,
      status,
      already_had_account: alreadyHadAccount,
    },
    200,
  );
}
