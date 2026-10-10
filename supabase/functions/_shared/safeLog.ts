// SPECS-INDEX #1051(H1-23):Edge Function 寫 log 時,不印整個錯誤物件。
//
// 資料庫 / Auth 的錯誤物件(message、details、hint)可能帶出欄位值(例如唯一鍵衝突會帶出 email),
// 所以 log 一律只印「固定字串 + 錯誤代碼」:呼叫端寫 console.error("[xxx] 某某失敗", errorCode(err))。
// 不印 email / 電話 / token / LINE userId。
//
// 🔒 這支檔案不 import 任何 Deno / supabase-js 的東西,前端 Vitest 也能直接測。

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** 從錯誤物件取出「代碼」:PostgREST/Postgres 的 code、Auth 的 code/status、或 Error 的 name。取不到就回 "unknown"。 */
export function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof e.code === "string" && SAFE_CODE.test(e.code)) return e.code;
    if (typeof e.code === "number") return String(e.code);
    if (typeof e.status === "number") return `status_${e.status}`;
    if (typeof e.name === "string" && SAFE_CODE.test(e.name)) return e.name;
  }
  return "unknown";
}
