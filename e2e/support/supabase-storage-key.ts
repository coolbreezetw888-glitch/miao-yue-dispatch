// 算出 supabase-js 預設用來存 session 的 localStorage key,格式固定是
// `sb-${projectRef}-auth-token`(見 @supabase/supabase-js 內部 defaultStorageKey 的算法)。
// 不要把專案 ref 直接寫死在測試檔案裡(那等於在版控裡明寫一份可辨識的專案資訊),
// 改成執行當下從 .env 讀 VITE_SUPABASE_URL 現算,測試永遠跟目前實際連的專案一致。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));

  if (!line) {
    throw new Error(
      `找不到 .env 裡的 ${key}——這個 e2e 測試需要它來算出 Supabase 的 localStorage key。` +
        `請確認 .env 檔案存在且包含這個變數(見 supabase-best-practice SKILL)。`,
    );
  }

  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^["']|["']$/g, "");
}

export function getSupabaseAuthStorageKey(): string {
  const url = readEnvValue("VITE_SUPABASE_URL");
  const ref = new URL(url).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}
