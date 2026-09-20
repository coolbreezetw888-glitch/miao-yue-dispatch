// 模組 11:LINE 通知 — Edge Function line-webhook
// 對應規格書 3.12,套用規則 2.2(簽章驗證)/2.3(冪等處理)/判斷 7(只處理綁定碼格式訊息)/
// 判斷 8(多租戶單一共用網址)。這是本模組風險最高的一步(安全性/簽章驗證),見第七節「Deno」。
//
// 流程:
//   1. 讀取「原始位元組」(regla 2.2 第 1 點:不能先 JSON.parse 再重新字串化)。
//   2. 解析 JSON 取出 destination(此時內容尚未驗證,不可信任,只拿來查表)。
//   3. 查 merchant_line_configs where line_bot_user_id = destination,查無資料 → 回 200 不處理
//      (安靜跳過,不洩漏「這個 destination 存不存在」的資訊)。
//   4. 用查到的 channel_secret 對原始位元組計算 HMAC-SHA256,base64 編碼後跟 x-line-signature
//      比對(常數時間比較)。
//   5. 比對失敗 → 401,完全不處理任何事件。
//   6. 比對成功 → 對每個 events[] 元素依 webhookEventId 判斷是否已處理過(冪等),沒處理過的話:
//      文字訊息 + 6 碼數字格式 → 呼叫 consume_line_binding_code(service role),
//      成功用 replyToken 呼叫 LINE Reply API 回覆確認訊息;失敗一樣可以選擇性回覆錯誤訊息。
//      其他事件類型 → 只記錄 line_webhook_events,不做其他處理(判斷 7)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// =========================================================================
// 規則 2.2:簽章驗證。純函式,注入 crypto 相依方便測試(用已知密鑰+已知內容獨立算一組
// HMAC-SHA256 當作已知答案,見 index.test.ts)。
// =========================================================================

/** 對原始位元組計算 HMAC-SHA256,回傳 base64 編碼(對應 LINE 官方文件的簽章演算法)。 */
export async function computeLineSignature(
  rawBody: Uint8Array,
  channelSecret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // 型別註記:某些 TypeScript lib 版本對 BufferSource 泛型比對過嚴,Uint8Array 在執行期完全
  // 相容,這裡用 as BufferSource 明確標註,不影響任何實際行為。
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, rawBody as BufferSource);
  return base64Encode(new Uint8Array(signatureBuffer));
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** 常數時間字串比較,避免時序攻擊洩漏簽章片段是否正確(規則 2.2 第 4 點)。 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 規則 2.2 第 2~4 點:驗證某個 destination 對應商家的簽章是否正確。 */
export async function verifyLineSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const expected = await computeLineSignature(rawBody, channelSecret);
  return constantTimeEquals(expected, signatureHeader);
}

// =========================================================================
// 判斷 7:訊息內容是否為 6 碼數字綁定碼格式。
// =========================================================================
export function isSixDigitBindingCode(text: string): boolean {
  return /^[0-9]{6}$/.test(text.trim());
}

// =========================================================================
// LINE Webhook payload 型別(只取用到的欄位)。
// =========================================================================
export interface LineWebhookEvent {
  type: string;
  webhookEventId: string;
  deliveryContext?: { isRedelivery?: boolean };
  replyToken?: string;
  message?: { type: string; text?: string };
  /** 事件的發送來源,個人對話時 source.userId 就是這個人的 LINE userId(對應規則 2.8 要寫入
   * line_user_id 的值)。 */
  source?: { type?: string; userId?: string };
}

export interface LineWebhookPayload {
  destination: string;
  events: LineWebhookEvent[];
}

/** 呼叫 LINE Reply API(只在剛處理完 webhook、replyToken 仍有效時使用,對應 3.12 邊界情況)。 */
export async function replyLineMessage(
  fetchImpl: typeof fetch,
  channelAccessToken: string,
  replyToken: string,
  text: string,
): Promise<void> {
  try {
    await fetchImpl("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
  } catch (err) {
    // 3.12 邊界情況:回覆訊息失敗不影響綁定本身是否成功,只記錄 log,不往外拋。
    console.error("[line-webhook] replyLineMessage 失敗(不影響綁定結果)", err);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("只接受 POST 請求", { status: 405 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[line-webhook] 缺少必要的環境變數");
    return new Response("伺服器設定不完整", { status: 500 });
  }

  // 規則 2.2 第 1 點:讀取原始位元組,不能先 JSON.parse 再重新字串化。
  const rawBody = new Uint8Array(await req.arrayBuffer());

  let payload: LineWebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as LineWebhookPayload;
  } catch {
    // 連 JSON 都解不開,不是合法的 LINE webhook 請求,安靜回 200(不洩漏任何資訊)。
    return new Response("OK", { status: 200 });
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 規則 8:靠 destination 反查商家。
  const { data: config, error: configError } = await adminClient
    .from("merchant_line_configs")
    .select("merchant_id, channel_secret, channel_access_token")
    .eq("line_bot_user_id", payload.destination)
    .maybeSingle();

  if (configError) {
    console.error("[line-webhook] 查詢 merchant_line_configs 失敗", configError);
    return new Response("OK", { status: 200 });
  }
  if (!config) {
    // 查無對應商家:安靜回 200,不處理(規則 2.2 第 3 點)。
    return new Response("OK", { status: 200 });
  }

  const signatureHeader = req.headers.get("x-line-signature");
  const validSignature = await verifyLineSignature(
    rawBody,
    signatureHeader,
    config.channel_secret as string,
  );

  if (!validSignature) {
    // 規則 2.2 第 5 點:簽章驗證失敗,完全不處理內含的任何事件。
    return new Response("Invalid signature", { status: 401 });
  }

  const merchantId = config.merchant_id as string;
  const channelAccessToken = config.channel_access_token as string;

  for (const event of payload.events ?? []) {
    // 規則 2.3:冪等處理——已存在的 webhookEventId 直接跳過(不看 isRedelivery)。
    const { data: existing } = await adminClient
      .from("line_webhook_events")
      .select("webhook_event_id")
      .eq("webhook_event_id", event.webhookEventId)
      .maybeSingle();

    if (existing) {
      continue;
    }

    // 先寫入冪等紀錄,再處理事件內容(降低同時處理兩次相同事件的競態視窗)。
    const { error: insertEventError } = await adminClient.from("line_webhook_events").insert({
      webhook_event_id: event.webhookEventId,
      merchant_id: merchantId,
      line_event_type: event.type,
      note: event.deliveryContext?.isRedelivery ? "isRedelivery=true" : null,
    });

    if (insertEventError) {
      // 極少數情況下(例如真的同時處理兩次)插入會因為主鍵重複而失敗,視為已處理過,跳過即可。
      console.error("[line-webhook] 寫入 line_webhook_events 失敗,視為已處理過跳過", insertEventError);
      continue;
    }

    // 判斷 7:只處理「文字訊息且為 6 碼數字格式」,其他事件類型只記錄冪等紀錄,不做其他處理。
    if (
      event.type === "message" &&
      event.message?.type === "text" &&
      event.message.text &&
      isSixDigitBindingCode(event.message.text)
    ) {
      const { data: consumeResult, error: consumeError } = await adminClient.rpc(
        "consume_line_binding_code",
        {
          p_code: event.message.text.trim(),
          p_merchant_id: merchantId,
          p_line_user_id: event.source?.userId ?? "",
        },
      );

      if (consumeError) {
        console.error("[line-webhook] consume_line_binding_code 呼叫失敗", consumeError);
        continue;
      }

      const success = Boolean((consumeResult as { success?: boolean } | null)?.success);

      if (event.replyToken) {
        const replyText = success
          ? "綁定成功,之後這個 LINE 帳號會收到通知。"
          : "代碼無效或已過期,請重新產生。";
        await replyLineMessage(fetch, channelAccessToken, event.replyToken, replyText);
      }
    }
    // 其他事件類型(follow/unfollow/非綁定碼格式的文字訊息):只記錄冪等紀錄,不做其他處理。
  }

  return new Response("OK", { status: 200 });
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
