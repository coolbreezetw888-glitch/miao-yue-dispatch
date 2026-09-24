// 從專案根目錄的 .env 讀一個「選用」的設定值(讀不到就回 undefined,不丟錯)。
//
// 為什麼需要這支:playwright.config.ts 刻意沒有掛 dotenv,所以 **`.env` 裡的變數不會自動
// 進到 `process.env`**。e2e 測試裡既有的做法是各自用 readFileSync 直接讀 .env
// (見 e2e/support/supabase-storage-key.ts 與 mobile-overflow-fixture.ts 裡的 readEnvValue)。
//
// ⚠️ 這件事踩過一次:規格書「超級管理員商家詳情強化」#710 要求新的
//    platform-admin-merchant-detail.spec.ts 用 E2E_PLATFORM_ADMIN_EMAIL /
//    E2E_PLATFORM_ADMIN_PASSWORD 來登入。這兩個值放在 .env 裡,如果只寫
//    `process.env["E2E_PLATFORM_ADMIN_EMAIL"]`,在本機跑起來永遠是 undefined ⇒ 整支測試
//    被 test.skip 靜默略過,終端機顯示「N skipped」而不是失敗——看起來像通過,其實一條都沒跑。
//    所以這裡的順序是:先看真正的環境變數(CI 會用這種方式注入),沒有才回頭讀 .env。
//
// ⚠️ 讀不到就回 undefined,由呼叫端決定要 test.skip 還是丟錯——別人 clone 這個 repo 時
//    .env 裡不會有這兩個值,不該讓整支測試爆掉。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function readOptionalEnvValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.length > 0) return fromProcess;

  let content: string;
  try {
    content = readFileSync(resolve(__dirname, "../../.env"), "utf-8");
  } catch {
    return undefined;
  }

  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) return undefined;

  const value = line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : undefined;
}
