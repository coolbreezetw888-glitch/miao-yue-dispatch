// e2e fixture 要建立 Supabase client 時,**唯一**該用的地方(SPECS-INDEX #766)。
//
// =========================================================================
// 🔴 規則:**新寫的 e2e fixture / spec 一律 import 這支的 `createFixtureSupabaseClient`,
//    不要再自己複製 isNewSupabaseApiKey / buildFetch / createFixtureSupabaseClient 這組三連發。**
//
//    這支檔案出現之前(2026-09-28),這組三連發在 e2e/support/ 底下有 **15 份**複製
//    (#766 登記時是 13 份,之後 #756/#765/#802 又各加了一份)。收斂前用 md5 逐函式比對過
//    (CRLF→LF、剝註解、剝空白之後):
//      ・isNewSupabaseApiKey:15 份 **1 個變體**(完全相同)
//      ・buildFetch:15 份 **1 個變體**(完全相同)
//      ・createFixtureSupabaseClient:createClient(...) 的參數 15 份完全相同,唯一差異是
//        「用哪支 .env 讀取器」與「找不到 key 時錯誤訊息裡的用途描述」——
//        12 份用區域 `readEnvValue(key)`、3 份用 env-file.ts 的 `readRequiredEnvValue(key, purpose)`。
//    所以這裡的 `purpose` 參數就是為了讓每一支 fixture 原本的錯誤訊息**一個字都不變**
//    (兩邊的訊息模板本來就是同一句:`找不到 .env 裡的 ${key}——${purpose}需要它來建立 fixture 資料。`)。
//
// ⚠️ 跟舊的 12 份區域 `readEnvValue` 相比,改走 env-file.ts 之後有兩處**刻意的**細微差異
//    (都只影響「讀不到設定」這種本來就會失敗的路徑,成功路徑完全等價):
//      ① 會先看 process.env、沒有才讀 `.env`(CI 是用環境變數注入的,舊版在 CI 上根本讀不到);
//      ② `.env` 有這一行但值是空字串 ⇒ 直接 throw(舊版會回傳空字串,然後在 createClient 裡
//         爆出 "supabaseUrl is required." 這種離現場很遠的錯)。這是 #714 規格書 §四 4.2 的裁決。
// =========================================================================
//
// 為什麼 fetch 要包一層(比照 src/integrations/supabase/client.ts):新格式 publishable key
// (sb_publishable_...)不是合法的 JWT,supabase-js 在還沒登入時仍可能塞一個
// `Authorization: Bearer <publishable key>` 標頭,要在真正送出的 fetch 裡拿掉,否則伺服器會判斷成
// 一組格式錯誤的 JWT。已登入之後 Authorization 帶的是使用者 JWT(不等於 publishable key),
// 這層包裝**不會**動它——所以條件是「等於 `Bearer ${supabaseKey}`」,不是「有 Authorization 就刪」。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readRequiredEnvValue } from "./env-file";

/** 新格式的 Supabase API key(sb_publishable_... / sb_secret_...),不是舊的 JWT 格式 anon key。 */
export function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

/** 回傳一個包過的 fetch:一律補上 `apikey` 標頭;如果 key 是新格式、而且 Authorization 剛好就是
 *  這把 key 本身(還沒登入時 supabase-js 的預設行為),就把 Authorization 拿掉。
 *  ⚠️ 內部呼叫的是**全域** `fetch`(每次呼叫時才查),不在 buildFetch 當下綁定——跟舊的 15 份一致。 */
export function buildFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

/** 用 `.env` 的 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 建一個 Node 端(非瀏覽器)用的
 *  Supabase client:不保存 session、不自動續期——fixture 只拿它做一次性的 setup/teardown。
 *
 *  @param purpose 用途描述,只用在「找不到 .env 設定」的錯誤訊息裡,例如 `"payroll 這個 e2e 測試"`。
 *                 不傳就是 env-file.ts 的預設描述 `"這個 e2e 測試"`。 */
export function createFixtureSupabaseClient(purpose = "這個 e2e 測試"): SupabaseClient {
  const url = readRequiredEnvValue("VITE_SUPABASE_URL", purpose);
  const key = readRequiredEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY", purpose);
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
