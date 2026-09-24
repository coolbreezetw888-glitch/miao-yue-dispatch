// 模組 11:LINE 通知 — Edge Function line-test-connection
// 對應規格書 3.13(第〇節判斷 2、判斷 9):本模組唯一「一旦有真實憑證就能直接動」的外部整合點。
// 流程:
//   1. 用呼叫者的 JWT(anon client)呼叫 am_i_merchant_admin(merchant_id)——回傳 false 就 403。
//      比照 invite-merchant-agent 既有寫法(第一步先驗證權限,不是收到請求就無條件執行特權操作)。
//   2. 通過後用 service_role client 讀取 merchant_line_configs,呼叫
//      GET https://api.line.me/v2/bot/info(header Authorization: Bearer <channel_access_token>)。
//   3. 成功:更新 is_connected=true/line_bot_user_id/line_bot_basic_id/display_name/
//      last_tested_at/last_test_result,回傳成功結果。
//   4. 失敗:更新 last_tested_at/last_test_result(白話錯誤),is_connected 設為 false,回傳失敗訊息。
//
// 這次沒有真實 LINE 憑證可以實際觸發一次成功呼叫(見規格書第〇節)——buildTestResultUpdate/
// callLineBotInfo 這兩個純函式用 Deno 測試搭配 mock fetch 驗證邏輯正確(見 index.test.ts),
// 不依賴任何真實 LINE 帳號。一旦有真實憑證,這支函式本身不需要改一行程式碼就能直接動。

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

/** LINE `/v2/bot/info` 成功回應的欄位(只取用到的部分,官方文件還有 pictureUrl 等欄位)。 */
export interface LineBotInfo {
  userId: string;
  basicId: string;
  displayName: string;
}

export interface LineBotInfoResult {
  ok: boolean;
  status: number;
  body: LineBotInfo | null;
  /** 呼叫本身失敗(逾時/網路錯誤)時的訊息,跟 HTTP 層級的失敗(401 等)分開記錄。 */
  networkErrorMessage: string | null;
}

/**
 * 3.13 核心呼叫:注入 fetch 實作方便測試(見 index.test.ts 用假的 fetch 模擬成功/401/逾時)。
 * 這支函式本身「一旦有真實憑證就能直接動」,不是假裝的空殼。
 */
export async function callLineBotInfo(
  fetchImpl: typeof fetch,
  channelAccessToken: string,
): Promise<LineBotInfoResult> {
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, networkErrorMessage: null };
    }
    const body = (await res.json()) as LineBotInfo;
    return { ok: true, status: res.status, body, networkErrorMessage: null };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      networkErrorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MerchantLineConfigUpdate {
  is_connected: boolean;
  line_bot_user_id: string | null;
  line_bot_basic_id: string | null;
  display_name: string | null;
  last_tested_at: string;
  last_test_result: string;
}

/**
 * 3.13 純函式:依 callLineBotInfo 的結果組出要寫回 merchant_line_configs 的內容 + 要回傳給
 * 前端的結果。跟實際的 fetch/資料庫呼叫完全分離,方便逐一測試各種情境(成功/401/逾時)。
 */
export function buildTestResultUpdate(
  result: LineBotInfoResult,
  nowIso: string,
): { update: MerchantLineConfigUpdate; response: { success: boolean; message: string } } {
  if (result.ok && result.body) {
    return {
      update: {
        is_connected: true,
        line_bot_user_id: result.body.userId,
        line_bot_basic_id: result.body.basicId,
        display_name: result.body.displayName,
        last_tested_at: nowIso,
        last_test_result: "連線成功",
      },
      response: { success: true, message: "連線成功" },
    };
  }

  let message: string;
  if (result.status === 401) {
    message = "Channel Access Token 無效或已過期,請確認是否正確複製";
  } else if (result.status === 0) {
    message = `無法連線到 LINE 伺服器,請稍後再試(${result.networkErrorMessage ?? "網路錯誤"})`;
  } else {
    message = `連線失敗(LINE 回應狀態碼 ${result.status}),請確認憑證是否正確`;
  }

  return {
    update: {
      is_connected: false,
      line_bot_user_id: null,
      line_bot_basic_id: null,
      display_name: null,
      last_tested_at: nowIso,
      last_test_result: message,
    },
    response: { success: false, message },
  };
}

interface TestConnectionRequestBody {
  merchant_id?: string;
}

/**
 * `import.meta.main` 只有在這支檔案被 Deno 直接當作程式進入點執行時才是 true(Supabase 部署
 * Edge Function 時就是這樣執行的)——被 index.test.ts import 進去做單元測試時是 false,
 * 避免測試檔案一 import 就意外啟動一個真正在監聽的 HTTP server(deno test 的資源清理檢查
 * 會因為有未關閉的 listener 而報錯,而且也沒有必要在跑純函式測試時真的監聽網路埠)。
 */
if (import.meta.main) {
  Deno.serve(handleRequest);
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[line-test-connection] 缺少必要的環境變數");
    return jsonResponse({ error: "伺服器設定不完整,請聯絡系統管理員" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "缺少登入憑證,請重新登入後再試" }, 401);
  }

  let body: TestConnectionRequestBody;
  try {
    body = (await req.json()) as TestConnectionRequestBody;
  } catch {
    return jsonResponse({ error: "請求格式錯誤" }, 400);
  }

  const merchantId = body.merchant_id?.trim();
  if (!merchantId) {
    return jsonResponse({ error: "缺少必要欄位(商家 id)" }, 400);
  }

  // 步驟 1:用呼叫者自己的 JWT 驗證權限。
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("am_i_merchant_admin", {
    p_merchant_id: merchantId,
  });

  if (adminCheckError) {
    console.error("[line-test-connection] am_i_merchant_admin 呼叫失敗", adminCheckError);
    return jsonResponse({ error: "驗證權限時發生錯誤,請稍後再試" }, 500);
  }
  if (!isAdmin) {
    return jsonResponse({ error: "沒有權限執行此操作,僅限該商家管理員使用" }, 403);
  }

  // 步驟 2:service_role client,只在通過權限檢查後才建立/使用。
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: config, error: configError } = await adminClient
    .from("merchant_line_configs")
    .select("channel_access_token")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (configError) {
    console.error("[line-test-connection] 讀取 merchant_line_configs 失敗", configError);
    return jsonResponse({ error: "查詢串接設定時發生錯誤,請稍後再試" }, 500);
  }
  if (!config) {
    return jsonResponse({ error: "尚未設定 LINE 串接憑證,請先儲存憑證再測試連線" }, 400);
  }

  const result = await callLineBotInfo(fetch, config.channel_access_token as string);
  const { update, response } = buildTestResultUpdate(result, new Date().toISOString());

  const { error: updateError } = await adminClient
    .from("merchant_line_configs")
    .update(update)
    .eq("merchant_id", merchantId);

  if (updateError) {
    console.error("[line-test-connection] 更新 merchant_line_configs 失敗", updateError);
    return jsonResponse({ error: "寫入測試結果時發生錯誤,請稍後再試" }, 500);
  }

  return jsonResponse(response, 200);
}
