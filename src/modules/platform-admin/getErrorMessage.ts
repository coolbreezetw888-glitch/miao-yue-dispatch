// 統一錯誤訊息擷取工具。
//
// 根本原因(這次品管抓到的 bug,已實際追查到 node_modules/@supabase/postgrest-js 原始碼確認,
// 不是 QA 初判的「打包環境 instanceof 原型鏈」問題):
// Supabase JS 用 `await supabase.rpc(...)` / `await supabase.from(...).xxx()` 這種
// 「不丟例外、回傳 { data, error }」的預設呼叫方式時,`error` 欄位其實「不是」
// `PostgrestError` 的實例——它只是照 PostgREST 回應 body 直接 `JSON.parse()` 出來的一般物件
// (見 PostgrestBuilder.ts 的 processResponse():只有明確呼叫 `.throwOnError()` 時,這個物件
// 才會被包成真正的 `new PostgrestError(error)` 拋出)。本模組 api.ts 原本的寫法是
// `if (error) throw error`,丟出去的就是那個「形狀對(有 message/details/hint/code)但不是
// Error 子類別」的一般物件。畫面上 catch 區塊原本寫
// `err instanceof Error ? err.message : "請稍後再試"`,這個一般物件 instanceof Error 一律是
// false,所以資料庫回傳的訊息(例如規則 2.4/2.5 的防呆訊息、3.4 的「查無此 email」訊息)
// 永遠被吞成通用文字。
//
// 修法:不要只認 instanceof Error,只要物件上有非空字串型別的 message 欄位就採用它
// (同時涵蓋真正的 Error 實例,以及 Supabase 回傳的這種一般物件)。
export function getErrorMessage(err: unknown, fallback = "請稍後再試"): string {
  if (err instanceof Error && err.message) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string" &&
    (err as { message: string }).message.length > 0
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}
