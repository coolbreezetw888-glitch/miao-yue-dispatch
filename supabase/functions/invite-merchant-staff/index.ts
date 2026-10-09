// 模組 14:服務人員端 — Edge Function invite-merchant-staff
// 對應規格書 3.10:接收 { merchant_id, staff_id, login_email },流程:
//   1. 用呼叫者的 JWT 建立 anon-key client,呼叫 am_i_merchant_admin(merchant_id)(規則 2.11——
//      邀請服務人員登入只有商家管理員能做,不透過 merchant_agent_permissions 開放給客服)——
//      回傳 false 就直接拒絕(403)。
//   2. 查 merchant_staff 確認 staff_id 屬於這間商家、status='active'、user_id is null
//      (還沒開通過登入,避免重複邀請已經有帳號的人),否則回傳明確錯誤。
//   3. 用 service_role key 建立另一個 client,查詢這個 login_email 是否已有 auth.users 帳號
//      (複用既有 lookup_user_id_by_email,只給 service_role 呼叫)。
//      - 已開通:略過寄信,取得該帳號的 user_id,login_status 直接是 active。
//      - 不存在:呼叫 auth.admin.inviteUserByEmail(...),取得新建立的 user_id,login_status 是 invited。
//      - 第 13 批 #1002:存在但還沒開通(別家商家邀請過、對方還沒設密碼):重寄邀請信,login_status 是 invited。
//      (改用 lookup_auth_account_by_email,見 _shared/inviteAccountResolver.ts)
//   4. 呼叫 record_invited_staff_login(...)(3.11,用 service_role client 呼叫,內部會緊接著呼叫
//      seed_default_staff_permissions 種入預設權限)。
//   5. 回傳成功/失敗結果給前端。
//
// 完全比照既有 supabase/functions/invite-merchant-agent/index.ts 的結構改寫(規格書 3.10 明講
// 「直接參考既有實作結構改寫,不要重新設計一套流程骨架」)。
//
// 金鑰安全(呼應開發流程紀錄第九章):SUPABASE_SERVICE_ROLE_KEY 只從 Supabase 專案的 Edge
// Function 環境變數讀取,不寫死在程式碼裡,也絕對不會回傳給前端。
//
// 2026-09-21 修正(對應規格書「服務人員管理優化與硬刪除」§1.2.3):整個處理邏輯包進
// try/catch,任何沒被預期到的例外(網路逾時、回傳格式意外改變等)一律回傳結構化的 JSON
// 500 錯誤,不會讓 Deno runtime 預設的非 JSON 錯誤格式害前端 `context.clone().json()`
// 解析失敗、只看到 Supabase SDK 的通用包裝訊息。這一層是保底,不取代已知失敗分支原本就有的
// 明確錯誤訊息(見規格書 §1.2.3 邊界情況)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  resolveInviteAccount,
  supabaseInviteAccountDeps,
} from "../_shared/inviteAccountResolver.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// 服務人員點邀請信連結、設定密碼後導回的轉場頁(4.8 StaffInviteCompletePage.tsx,
// 3.12 mark_staff_login_active_if_self 在這頁被呼叫)。
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
  staff_id?: string;
  login_email?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    return await handleInviteMerchantStaff(req);
  } catch (err) {
    console.error("[invite-merchant-staff] 未預期的例外", err);
    return jsonResponse({ error: "系統發生非預期錯誤，請稍後再試或聯絡系統管理員" }, 500);
  }
});

async function handleInviteMerchantStaff(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[invite-merchant-staff] 缺少必要的環境變數(SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY)",
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
  const staffId = body.staff_id?.trim();
  const rawEmail = body.login_email?.trim();

  if (!merchantId || !staffId || !rawEmail) {
    return jsonResponse({ error: "缺少必要欄位(商家、服務人員、登入 Email 為必填)" }, 400);
  }

  const loginEmail = rawEmail.toLowerCase();

  // 步驟 1:用呼叫者自己的 JWT 驗證權限(規則 2.11),不是收到請求就無條件執行特權操作。
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("am_i_merchant_admin", {
    p_merchant_id: merchantId,
  });

  if (adminCheckError) {
    console.error("[invite-merchant-staff] am_i_merchant_admin 呼叫失敗", adminCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤，請稍後再試" }, 500);
  }

  if (!isAdmin) {
    return jsonResponse({ error: "沒有權限執行此操作，僅限該商家管理員使用" }, 403);
  }

  // 步驟 2:service_role client,只在通過權限檢查後才建立/使用。
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // SPECS-INDEX #1025 FG3-F01(X7):service role 沒有 RLS 保護,這裡自己明確檢查平台功能開關,
  // 不假設上游(畫面)擋過。這間店的「服務人員登入端」沒開 ⇒ 403,固定一句、不帶任何資料。
  const { data: staffPortalOn, error: featureCheckError } = await adminClient.rpc(
    "internal_merchant_has_feature",
    { p_merchant_id: merchantId, p_feature_key: "staff_portal" },
  );

  if (featureCheckError) {
    console.error("[invite-merchant-staff] internal_merchant_has_feature 呼叫失敗", featureCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤，請稍後再試" }, 500);
  }

  if (staffPortalOn !== true) {
    return jsonResponse({ error: "這個功能目前沒有開放。" }, 403);
  }

  const { data: staffRow, error: staffLookupError } = await adminClient
    .from("merchant_staff")
    .select("id, merchant_id, status, user_id")
    .eq("id", staffId)
    .maybeSingle();

  if (staffLookupError) {
    console.error("[invite-merchant-staff] 查詢服務人員失敗", staffLookupError);
    return jsonResponse({ error: "查詢服務人員資料時發生錯誤，請稍後再試" }, 500);
  }

  if (!staffRow || staffRow.merchant_id !== merchantId || staffRow.status !== "active") {
    return jsonResponse({ error: "找不到這位服務人員，或這位服務人員已被移除" }, 404);
  }

  if (staffRow.user_id) {
    return jsonResponse({ error: "這位服務人員已經開通登入了" }, 409);
  }

  // 第 13 批 #1002:不能只看「auth 有沒有這個帳號」——別家商家寄過邀請、對方還沒開通時帳號也已經存在。
  // 判斷與寄信邏輯集中在 _shared/inviteAccountResolver.ts(跟 invite-merchant-agent 共用):
  //   查無帳號 → 寄邀請信(invited);已開通 → 規則 2.6 直接開通(active);
  //   有帳號但還沒開通 → 重寄邀請信 / 設定密碼信(invited),對方設好密碼後所有商家一起轉 active。
  const resolved = await resolveInviteAccount(
    loginEmail,
    `${PUBLIC_SITE_URL}/app/staff-invite-complete`,
    supabaseInviteAccountDeps(adminClient),
  );

  if (resolved.kind === "lookup_error") {
    console.error("[invite-merchant-staff] lookup_auth_account_by_email 呼叫失敗", resolved.error);
    return jsonResponse({ error: "查詢帳號時發生錯誤，請稍後再試" }, 500);
  }

  if (resolved.kind === "send_error") {
    return jsonResponse(
      {
        error: `邀請信寄送失敗：${resolved.message}(Supabase 免費方案寄信額度較低，若短時間內邀請多人可能會碰到這個限制)`,
      },
      502,
    );
  }

  const userId = resolved.userId;
  const loginStatus = resolved.status;
  // 只有「直接開通」時才是 true(前端據此顯示「已直接開通登入」而不是「邀請信已寄出」)。刻意不再用
  // 「auth 有沒有這個帳號」:那會讓呼叫者知道這個信箱是不是被別家商家邀請過還沒開通。
  const alreadyHadAccount = loginStatus === "active";

  // 步驟 3:寫入 merchant_staff 的登入身份欄位(record_invited_staff_login 只授權給 service_role,
  // 內部會緊接著呼叫 seed_default_staff_permissions 種入四項自助功能的預設權限,判斷 1)。
  const { error: recordError } = await adminClient.rpc("record_invited_staff_login", {
    p_staff_id: staffId,
    p_user_id: userId,
    p_invited_login_email: loginEmail,
    p_login_status: loginStatus,
  });

  if (recordError) {
    console.error("[invite-merchant-staff] record_invited_staff_login 失敗", recordError);
    return jsonResponse(
      { error: recordError.message || "寫入服務人員登入資料失敗，請稍後再試" },
      500,
    );
  }

  return jsonResponse(
    {
      staff_id: staffId,
      login_status: loginStatus,
      already_had_account: alreadyHadAccount,
    },
    200,
  );
}
