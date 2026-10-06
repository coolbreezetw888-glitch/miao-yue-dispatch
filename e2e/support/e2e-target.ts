// 第 6 批(SPECS-INDEX #849):預設 e2e(e2e/)的「目標切換」——**唯一**判斷現在是不是本機模式的地方。
//
// 背景:e2e/ 底下每一支 fixture 都會用 `.env` 的連線資訊**寫入資料**,而 `.env` 指向正式庫。
// 為了能驗證預設 e2e 又不碰正式庫,加了一個用環境變數開啟的「本機模式」:
//
//     E2E_TARGET=local npx playwright test           (PowerShell:$env:E2E_TARGET="local"; npx playwright test)
//
// 規則:
//   ・**沒設 E2E_TARGET(或空字串)⇒ 跟改版前完全一樣**(playwright.config.ts 走原本那份設定)。
//   ・E2E_TARGET=local ⇒ 本機模式:Supabase 網址/金鑰改取自 `npx supabase status -o env`,前端與 Supabase
//     網址任何一個不是本機就直接 throw(config 載入失敗,一條測試都不跑);`.env` 完全不讀(見 env-file.ts)。
//   ・E2E_TARGET 是其他任何值 ⇒ 直接 throw。理由:打錯字(例如 `locl`)時如果默默當成「沒設」,
//     就會在使用者以為是本機的情況下打到正式庫——寧可錯殺。
export const E2E_TARGET_ENV = "E2E_TARGET";

export type E2eTarget = "default" | "local";

/** 解析 E2E_TARGET。沒設/空字串 ⇒ "default";"local" ⇒ "local";其他值 ⇒ throw。 */
export function parseE2eTarget(raw: string | undefined): E2eTarget {
  if (raw === undefined || raw === "") return "default";
  if (raw === "local") return "local";
  throw new Error(
    `[e2e] ${E2E_TARGET_ENV} 只接受 "local"(或不設定),收到的是 "${raw}" ⇒ 中止,避免打錯字時誤連正式庫。`,
  );
}

/** 目前這個行程是不是預設 e2e 的本機模式。 */
export function isLocalE2eTarget(): boolean {
  return parseE2eTarget(process.env[E2E_TARGET_ENV]) === "local";
}

/** 本機模式下要跳過的測試,統一用這句開頭,方便從報表一眼認出「不是故障,是刻意跳過」。 */
export const LOCAL_SKIP_PREFIX = "[本機模式刻意跳過]";
