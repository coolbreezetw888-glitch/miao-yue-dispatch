// 模組 11:LINE 通知 — Edge Function line-webhook
// 對應規格書 3.12,套用規則 2.2(簽章驗證)/2.3(冪等處理)/判斷 7(只處理綁定碼格式訊息)/
// 判斷 8(多租戶單一共用網址)。這是本模組風險最高的一步(安全性/簽章驗證),見第七節「Deno」。
//
// 流程:
//   1. 讀取「原始位元組」(規則 2.2 第 1 點:不能先 JSON.parse 再重新字串化)。
//   2. 解析 JSON 取出 destination(此時內容尚未驗證,不可信任,只拿來查表)。
//   3. 查 merchant_line_configs where line_bot_user_id = destination,查無資料 → 回 200 不處理
//      (安靜跳過,不洩漏「這個 destination 存不存在」的資訊)。
//      #1053:查表只取 merchant_id;secret / token 改從 Vault 取(_shared/lineCredentials.ts),讀不到同樣回 200。
//   4. 用查到的 channel_secret 對原始位元組計算 HMAC-SHA256,base64 編碼後跟 x-line-signature
//      比對(常數時間比較)。
//   5. 比對失敗 → 401,完全不處理任何事件。
//   6. 比對成功 → 對每個 events[] 元素依 webhookEventId 判斷是否已處理過(冪等),沒處理過的話:
//      文字訊息 + 6 碼數字格式 → 呼叫 consume_line_binding_code(service role),
//      成功用 replyToken 呼叫 LINE Reply API 回覆確認訊息;失敗一樣可以選擇性回覆錯誤訊息。
//      其他事件類型 → 只記錄 line_webhook_events,不做其他處理(判斷 7)。
//
// 客戶端第 5-A 批 C5-F01(2026-10-09):
//   ・follow / unfollow ⇒ 呼叫 internal_set_line_friendship 記「這個 LINE userId 是不是這間店官方帳號的好友」
//     (用事件的 timestamp 判斷先後,比現有紀錄舊的事件不覆蓋 ⇒ LINE 重送 / 亂序不會蓋掉新狀態)。不回覆任何訊息。
//   ・handleRequest 改成 handleRequest(req, deps) 可注入(比照 #972),環境變數改在執行當下讀。綁定碼處理不變。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { errorCode } from "../_shared/safeLog.ts";
import { checkMerchantFeature, FEATURE_LINE_NOTIFICATIONS } from "../_shared/featureGate.ts";
import { getLineMessagingCredentials } from "../_shared/lineCredentials.ts";


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
  /** 事件發生時間(毫秒)。C5-F01 用來判斷 follow / unfollow 的先後。 */
  timestamp?: number;
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
    console.error("[line-webhook] replyLineMessage 失敗(不影響綁定結果)", errorCode(err));
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** C5-F01:follow / unfollow 事件 ⇒ 好友狀態;其他事件 null。 */
export function friendshipChangeFromEvent(
  event: LineWebhookEvent,
): { lineUserId: string; isFriend: boolean; changedAt: string } | null {
  if (event.type !== "follow" && event.type !== "unfollow") return null;
  const lineUserId = event.source?.userId;
  if (!lineUserId) return null;
  const ms = typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
  return { lineUserId, isFriend: event.type === "follow", changedAt: new Date(ms).toISOString() };
}

// deno-lint-ignore no-explicit-any
type AnyAdminClient = any;

/** 可注入的相依(Deno 測試傳假的 client / fetch)。 */
export interface HandleRequestDeps {
  env?: (k: string) => string | undefined;
  createAdminClient?: () => AnyAdminClient;
  fetchImpl?: typeof fetch;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("只接受 POST 請求", { status: 405 });
  }
  const env = deps?.env ?? ((k: string) => Deno.env.get(k));
  const SUPABASE_URL = env("SUPABASE_URL") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!deps?.createAdminClient && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    console.error("[line-webhook] 缺少必要的環境變數");
    return new Response("伺服器設定不完整", { status: 500 });
  }
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // 規則 2.2 第 1 點:讀取原始位元組,不能先 JSON.parse 再重新字串化。
  const rawBody = new Uint8Array(await req.arrayBuffer());

  let payload: LineWebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as LineWebhookPayload;
  } catch {
    // 連 JSON 都解不開,不是合法的 LINE webhook 請求,安靜回 200(不洩漏任何資訊)。
    return new Response("OK", { status: 200 });
  }

  const adminClient = deps?.createAdminClient
    ? deps.createAdminClient()
    : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

  // 規則 8:靠 destination 反查商家。
  const { data: config, error: configError } = await adminClient
    .from("merchant_line_configs")
    .select("merchant_id")
    .eq("line_bot_user_id", payload.destination)
    .maybeSingle();

  if (configError) {
    console.error("[line-webhook] 查詢 merchant_line_configs 失敗", errorCode(configError));
    return new Response("OK", { status: 200 });
  }
  if (!config) {
    // 查無對應商家:安靜回 200,不處理(規則 2.2 第 3 點)。
    return new Response("OK", { status: 200 });
  }

  // #1053:金鑰改存 Vault,透過 service_role 專用 RPC 取。讀不到 ⇒ 視同這間店沒設定 LINE,安靜回 200。
  const merchantId = config.merchant_id as string;
  const credentials = await getLineMessagingCredentials(adminClient, merchantId, "[line-webhook]");
  if (!credentials) {
    return new Response("OK", { status: 200 });
  }

  const signatureHeader = req.headers.get("x-line-signature");
  const validSignature = await verifyLineSignature(
    rawBody,
    signatureHeader,
    credentials.channelSecret,
  );

  if (!validSignature) {
    // 規則 2.2 第 5 點:簽章驗證失敗,完全不處理內含的任何事件。
    return new Response("Invalid signature", { status: 401 });
  }

  const channelAccessToken = credentials.channelAccessToken;

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
      console.error("[line-webhook] 寫入 line_webhook_events 失敗,視為已處理過跳過", errorCode(insertEventError));
      continue;
    }

    // C5-F01:加好友 / 封鎖 ⇒ 記好友狀態(失敗只記 log,不影響其他事件;不印 LINE userId)。
    const friendship = friendshipChangeFromEvent(event);
    if (friendship) {
      const { error: friendError } = await adminClient.rpc("internal_set_line_friendship", {
        p_merchant_id: merchantId,
        p_line_user_id: friendship.lineUserId,
        p_is_friend: friendship.isFriend,
        p_changed_at: friendship.changedAt,
        p_source: "webhook",
      });
      if (friendError) console.error("[line-webhook] 記錄好友狀態失敗(不影響其他事件)");
      continue;
    }

    // 判斷 7:只處理「文字訊息且為 6 碼數字格式」,其他事件類型只記錄冪等紀錄,不做其他處理。
    if (
      event.type === "message" &&
      event.message?.type === "text" &&
      event.message.text &&
      isSixDigitBindingCode(event.message.text)
    ) {
      // #1051(H1-21):這間店的「LINE 通知」平台功能沒開 ⇒ 不綁定、不回覆(查詢失敗也當沒開)。
      const lineNotificationsGate = await checkMerchantFeature(adminClient, merchantId, FEATURE_LINE_NOTIFICATIONS);
      if (lineNotificationsGate !== true) {
        if (lineNotificationsGate === "error") console.error("[line-webhook] internal_merchant_has_feature 失敗");
        continue;
      }

      // #1051(H1-20):錯誤次數限制在資料庫 consume_line_binding_code 裡處理(同一 LINE 帳號 × 同一間店
      // 1 小時內錯 5 次 ⇒ 暫停受理 1 小時),回傳結果與「代碼無效或已過期」相同,這裡照舊回同一句。
      const { data: consumeResult, error: consumeError } = await adminClient.rpc(
        "consume_line_binding_code",
        {
          p_code: event.message.text.trim(),
          p_merchant_id: merchantId,
          p_line_user_id: event.source?.userId ?? "",
        },
      );

      if (consumeError) {
        console.error("[line-webhook] consume_line_binding_code 呼叫失敗", errorCode(consumeError));
        continue;
      }

      const success = Boolean((consumeResult as { success?: boolean } | null)?.success);

      if (event.replyToken) {
        const replyText = success
          ? "綁定成功，之後這個 LINE 帳號會收到通知。"
          : "代碼無效或已過期，請重新產生。";
        await replyLineMessage(fetchImpl, channelAccessToken, event.replyToken, replyText);
      }
    }
    // 其他事件類型(非綁定碼格式的文字訊息等):只記錄冪等紀錄,不做其他處理。
  }

  return new Response("OK", { status: 200 });
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
