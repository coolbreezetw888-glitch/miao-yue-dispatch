// 模組 15(服務人員推播通知)7.6:實際呼叫 npm:web-push 套件發送推播的介接層。
// 已在 2026-09-22 用一個獨立的測試 Edge Function 實測確認 `npm:web-push@3.6.7` 在這個專案的
// Deno(Supabase Edge Function)執行環境可以正常運作(含 ECDH/HKDF/aes128gcm 加密、ES256 JWT
// 簽章的完整流程),不需要退回規格書提到的自行實作方案(第九節待確認事項第 5 點)。
//
// 這個檔案把 web-push 套件的呼叫包成 SendPushResult 形狀,供 pushDispatchCore.ts 的
// PushDispatchDeps.sendPush 使用,跟核心編排邏輯(可測試、不依賴真正的網路呼叫)分離。

import webpush from "npm:web-push@3.6.7";

import type { SendPushResult, StaffPushSubscriptionRow } from "./pushDispatchCore.ts";

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** WebPushError 的可用欄位(web-push 套件沒有匯出型別,這裡用結構型別描述用得到的欄位)。 */
interface WebPushErrorLike {
  statusCode?: number;
  body?: string;
  message?: string;
}

export async function sendWebPush(
  vapidDetails: VapidDetails,
  subscription: StaffPushSubscriptionRow,
  payload: { title: string; body: string; url: string },
): Promise<SendPushResult> {
  try {
    const res = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh_key, auth: subscription.auth_key },
      },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: vapidDetails.subject,
          publicKey: vapidDetails.publicKey,
          privateKey: vapidDetails.privateKey,
        },
      },
    );
    return { ok: true, status: res.statusCode, errorDetail: null };
  } catch (err) {
    const e = err as WebPushErrorLike;
    const status = typeof e.statusCode === "number" ? e.statusCode : 0;
    const errorDetail = e.body || e.message || String(err);
    return { ok: false, status, errorDetail };
  }
}
