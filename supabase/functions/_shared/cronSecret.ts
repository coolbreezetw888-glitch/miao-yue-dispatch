// SPECS-INDEX #1051(H1-22):排程呼叫 Edge Function 時的 X-Cron-Secret 比對,所有 cron 型 Edge 共用。
//
// 固定時間比對:不論哪一個字元不同、長度是否相同,都會把整段跑完才回答,
// 回應時間不會因為「猜對前幾個字」而改變。環境變數沒設(空字串)時一律擋下,
// 避免「空字串比對空字串」意外放行。
//
// 🔒 這支檔案不 import 任何 Deno / supabase-js 的東西,前端 Vitest 也能直接測。

export function isValidCronSecret(headerValue: string | null, expected: string): boolean {
  if (!expected) return false;
  const given = headerValue ?? "";
  const len = Math.max(given.length, expected.length);
  // 長度不同本身就算不同,但仍把整段跑完。
  let diff = given.length ^ expected.length;
  for (let i = 0; i < len; i++) {
    const a = i < given.length ? given.charCodeAt(i) : 0;
    const b = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0 && headerValue !== null;
}
