// e2e 測試要讀專案根目錄 `.env` 的值時,**唯一**該用的地方。
//
// =========================================================================
// 🔴 規則(SPECS-INDEX #714):**新寫的 e2e fixture / spec 一律 import 這個檔案,
//    不要再自己手刻一份 `.env` 解析,也不要直接寫 `process.env["X"]`。**
//
//    為什麼要立這條規則:2026-09-25 查證的結果是全 `e2e/` 有 **13 份逐字相同的區域
//    `function readEnvValue`**,解析邏輯一個字都不差,唯一差異只有 throw 出來的錯誤訊息中間那段描述。
//    那 13 份在 #714 當批刻意不動(每一支都會對正式資料庫建立資料,「把全部 e2e 跑一遍證明沒改壞」
//    這個驗證方式不能用)。
//    ✅ **2026-09-28(SPECS-INDEX #766)**:其中 12 份 fixture 的區域 `readEnvValue` 已經隨著
//       `isNewSupabaseApiKey` / `buildFetch` / `createFixtureSupabaseClient` 三連發一起收斂進
//       e2e/support/fixture-supabase-client.ts(那組三連發本來就是 readEnvValue 唯一的呼叫端),
//       fixture 現在全部走這裡的 readRequiredEnvValue。**剩下唯一一份區域解析器在
//       e2e/support/supabase-storage-key.ts**(#714 範圍,本批不動)。
// =========================================================================
//
// 為什麼需要這支:playwright.config.ts **刻意沒有掛 dotenv**,`package.json` 的 `test:e2e`
// 也是裸 `playwright test`,所以 **`.env` 裡的變數不會自動進到 `process.env`**。
//
// ⚠️ 這件事在 2026-09-25 一天之內被三位不同的 agent 各自重新發現一次,而且真的造成過事故:
//    ① 規格書「超級管理員商家詳情強化」#710 的 platform-admin-merchant-detail.spec.ts
//       要用 E2E_PLATFORM_ADMIN_EMAIL / E2E_PLATFORM_ADMIN_PASSWORD 登入;
//    ② e2e/mobile-overflow.spec.ts 的超級管理員區塊原本直接寫
//       `process.env["E2E_PLATFORM_ADMIN_EMAIL"]`,值永遠是 undefined ⇒ 那 3 條測試被
//       `test.skip` 靜默略過,終端機顯示「N skipped」而不是失敗——看起來像通過,其實從專案
//       建立至今一條都沒跑過(SPECS-INDEX #711 就是在修這件事)。
//    所以這裡的順序是:**先看真正的環境變數(CI 用這種方式注入),沒有才回頭讀 `.env`**。
//
// 兩種語意,依呼叫端需要挑一支用:
//   ・readOptionalEnvValue(key)  → 讀不到回 `undefined`,由呼叫端決定要 test.skip 還是丟錯。
//   ・readRequiredEnvValue(key)  → 讀不到就 throw(fixture 少了連線資訊時該當場爆掉)。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isLocalE2eTarget } from "./e2e-target";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 解析出 `.env` 裡某個 key 的值。找不到、或找到但值是空的,一律回 `undefined`。
 *
 * ⚠️ `split(/\r?\n/)` 的 `\r?` 不是多餘的:這個 repo 有大量 CRLF 換行的檔案
 * (見 .claude/skills/automated-testing/SKILL.md 第六節),`.env` 也可能是 CRLF。 */
function parseEnvValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.length > 0) return fromProcess;

  // 🔴 第 6 批(#849):預設 e2e 的本機模式(E2E_TARGET=local)**完全不讀 `.env`**——`.env` 裡是正式庫的
  //    網址與正式的超級管理員帳密。本機模式需要的值由 playwright.config.ts 事先放進 process.env;
  //    沒放的(例如 E2E_PLATFORM_ADMIN_*)一律當成「沒設定」,由呼叫端 skip 或丟錯。
  if (isLocalE2eTarget()) return undefined;

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

/** 讀一個「選用」的設定值:讀不到就回 `undefined`,不丟錯。
 *
 * ⚠️ 讀不到回 undefined,由呼叫端決定要 test.skip 還是丟錯——別人 clone 這個 repo 時
 *    `.env` 裡不會有 E2E_PLATFORM_ADMIN_* 這類值,不該讓整支測試爆掉。
 *    但**本機看到因此產生的 skipped,要當成故障去查,不能當成過關**(見 #711)。 */
export function readOptionalEnvValue(key: string): string | undefined {
  return parseEnvValue(key);
}

/** 讀一個「必要」的設定值:讀不到就 throw。fixture 要用來連 Supabase 的 URL / API key 走這支。
 *
 * @param purpose 用途描述,會被組進錯誤訊息裡,例如 `"payroll 這個 e2e 測試"`。
 *
 * 🔴 **刻意的行為決定(規格書 §四 4.2 裁決)**:「`.env` 裡有這一行、但值是空字串」也算
 *    讀不到,一律 throw,**不回傳空字串**。理由:呼叫端全部拿它去組 Supabase URL / API key,
 *    空字串一路往下傳只會在更遠的地方爆出看不懂的錯。
 *    ⚠️ 這跟舊的區域 `readEnvValue` 的行為有一處細微差異——那些在「有這一行但值是空的」
 *       時會回傳空字串。2026-09-28(#766)起 e2e fixture 全部改走這支,所以那個舊行為只剩
 *       e2e/support/supabase-storage-key.ts 自己那一份還在。 */
export function readRequiredEnvValue(key: string, purpose = "這個 e2e 測試"): string {
  const value = parseEnvValue(key);
  if (value === undefined) {
    throw new Error(`找不到 .env 裡的 ${key}——${purpose}需要它來建立 fixture 資料。`);
  }
  return value;
}
