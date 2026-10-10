// SPECS-INDEX #1053:各店 LINE Messaging API 金鑰(Channel Secret / Channel Access Token)改存 Vault。
//
// Edge Function 一律透過這支 helper 取金鑰:呼叫 service_role 專用的
// public.internal_get_line_messaging_credentials(p_merchant_id),不再直接 select merchant_line_configs 的明文欄位。
//
// 規則:
//   ・讀不到(沒設定、Vault 沒有、RPC 失敗)⇒ 回 null,呼叫端當作「LINE 未設定」走既有分支。
//   ・log 只印固定文字 + 錯誤代碼(safeLog.errorCode),永遠不印金鑰、不印錯誤原文。
//
// 🔒 這支檔案不 import 任何 Deno / supabase-js 的東西(只要一個有 rpc 方法的 client),前端 Vitest 也能直接測。

import { errorCode } from "./safeLog.ts";

export const LINE_CREDENTIALS_RPC = "internal_get_line_messaging_credentials";

export interface LineMessagingCredentials {
  channelSecret: string;
  channelAccessToken: string;
}

/** 只需要 rpc 這一個方法;真的 supabase-js client 與測試用的假 client 都符合。 */
export interface LineCredentialsRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/** 把 RPC 回傳值轉成金鑰;任何一個欄位缺漏或不是非空字串 ⇒ null。 */
export function parseLineMessagingCredentials(data: unknown): LineMessagingCredentials | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { channel_secret?: unknown; channel_access_token?: unknown };
  const secret = typeof d.channel_secret === "string" ? d.channel_secret : "";
  const token = typeof d.channel_access_token === "string" ? d.channel_access_token : "";
  if (!secret || !token) return null;
  return { channelSecret: secret, channelAccessToken: token };
}

/**
 * 取某店的 LINE Messaging API 金鑰。讀不到 ⇒ null(不丟例外)。
 * @param logTag log 前綴,例如 "[line-webhook]"
 */
export async function getLineMessagingCredentials(
  client: LineCredentialsRpcClient,
  merchantId: string,
  logTag = "[line-credentials]",
): Promise<LineMessagingCredentials | null> {
  if (!merchantId) return null;
  try {
    const { data, error } = await client.rpc(LINE_CREDENTIALS_RPC, { p_merchant_id: merchantId });
    if (error) {
      console.error(`${logTag} 讀取 LINE 金鑰失敗`, errorCode(error));
      return null;
    }
    return parseLineMessagingCredentials(data);
  } catch (err) {
    console.error(`${logTag} 讀取 LINE 金鑰失敗`, errorCode(err));
    return null;
  }
}
