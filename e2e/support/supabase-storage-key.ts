// 算出 supabase-js 預設用來存 session 的 localStorage key,格式固定是
// `sb-${projectRef}-auth-token`(見 @supabase/supabase-js 內部 defaultStorageKey 的算法)。
// 不要把專案 ref 直接寫死在測試檔案裡(那等於在版控裡明寫一份可辨識的專案資訊),
// 改成執行當下讀 VITE_SUPABASE_URL 現算,測試永遠跟目前實際連的專案一致。
//
// 第 6 批(#849):改走 env-file.ts 的 readRequiredEnvValue(先看 process.env,沒有才讀 `.env`),
// 不再自己讀 `.env`。理由:預設 e2e 的本機模式(E2E_TARGET=local)把本機網址放在 process.env,
// fixture(createFixtureSupabaseClient)也是先看 process.env——這裡如果還直接讀 `.env`,算出來的
// 會是正式庫的 key(`sb-<正式 ref>-auth-token`),跟瀏覽器實際連的本機對不起來,而且等於在本機模式讀了 `.env`。
// 這是 SPECS-INDEX #714/#766 登記的「最後一份區域 .env 解析器」,這次一併收斂。
// 行為差異:`.env` 有這一行但值是空字串時,舊版回空字串(之後 new URL 爆掉),新版直接 throw——都是失敗路徑。
import { readRequiredEnvValue } from "./env-file";

export function getSupabaseAuthStorageKey(): string {
  const url = readRequiredEnvValue(
    "VITE_SUPABASE_URL",
    "這個 e2e 測試(算出 Supabase 的 localStorage key)",
  );
  const ref = new URL(url).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}
