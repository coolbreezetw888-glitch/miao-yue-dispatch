// SPECS-INDEX #1051(H1-24):邀請客服 / 服務人員失敗時,回給前端的訊息一律是固定白話句。
// 資料庫或寄信服務的錯誤原文只進 log(而且只印錯誤代碼,見 safeLog.ts),不回給前端。
//
// 唯一例外:資料庫函式裡我們自己寫給店家看的那幾句(已知、固定、不含任何其他人的資料),
// 原句回給前端,店家才知道該怎麼處理。
//
// 🔒 這支檔案不 import 任何 Deno / supabase-js 的東西,前端 Vitest 也能直接測。

/** 寄信服務(Supabase Auth)失敗時回給前端的固定句(不含原文)。 */
export const INVITE_SEND_FAILED_MESSAGE = "目前無法寄出邀請信，請稍後再試";

/** record_invited_* 裡寫給店家看的固定句;只有這幾句會原樣回給前端。 */
const KNOWN_RECORD_MESSAGES = new Set<string>([
  "這個人已經是這間店的客服了",
  "這個 Email 目前已經是本店另一位在職服務人員的登入帳號，不能重複綁定。如果是同一個人，請先確認是否選錯了服務人員，或聯絡系統管理員協助處理。",
  "這個信箱可能曾經被移除的服務人員使用過，系統應該要能自動處理，如果看到這個訊息代表發生了非預期的資料衝突，請聯絡系統管理員。",
]);

/** 寫入邀請資料失敗時回給前端的訊息:已知的店家用句原樣回,其他一律回 fallback。 */
export function inviteRecordErrorMessage(err: unknown, fallback: string): string {
  const message = err && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
  if (typeof message === "string" && KNOWN_RECORD_MESSAGES.has(message)) return message;
  return fallback;
}

/** 邀請信寄送失敗時回給前端的完整句子(resolved.message 一律是本專案寫的固定句)。 */
export function inviteSendErrorMessage(reason: string): string {
  return `邀請信寄送失敗：${reason}。短時間內邀請多人時，可能會碰到寄信次數上限，請稍等幾分鐘再試。`;
}
