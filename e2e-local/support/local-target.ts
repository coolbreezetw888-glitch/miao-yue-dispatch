// 「只連本機」e2e 模式(紅利系統重構批次 8)的目標檢查——**唯一**決定這個模式連到哪裡的地方。
//
// 為什麼要有這支:預設的 playwright.config.ts 與 e2e/support 的 fixture 都讀根目錄 `.env`,
// 而 `.env` 指向**正式庫**。規格書規定 e2e 絕對不可以在正式庫上跑,所以另外做一個只連本機
// Docker(`supabase start`)的模式:`npm run test:e2e:local`(playwright.local.config.ts)。
//
// 三道保證「100% 只打本機」(任何一道都會讓測試直接中止,不會「悄悄改連正式庫」):
//   ① 啟動時:目標網址的主機必須是 127.0.0.1 / localhost / ::1,而且整串網址不可以含 `supabase.co`,
//      否則 assertLocalSupabaseUrl 直接 throw(config 載入就失敗,一條測試都不會跑)。
//   ② Node 端(fixture 建資料用的 supabase-js):installLoopbackOnlyFetchGuard 把全域 fetch 包一層,
//      打到非本機主機一律 throw。playwright.local.config.ts 在每個 worker 載入 config 時就裝上。
//   ③ 瀏覽器端:Chromium 啟動參數 `--host-resolver-rules` 讓除了 localhost / 127.0.0.1 以外的網域
//      全部解析失敗;spec 另外記錄每一個請求,afterEach 斷言「打到 supabase.co 的請求 = 0」。
//
// ⚠️ 這支**不讀 `.env`**。本機的網址與金鑰一律由 `supabase status -o env` 取得(playwright.local.config.ts
//    負責呼叫),再透過 E2E_LOCAL_* 環境變數交給 worker。金鑰是本機 Docker 的示範金鑰,不是正式金鑰。

export const LOCAL_ENV_KEYS = {
  url: "E2E_LOCAL_SUPABASE_URL",
  publishableKey: "E2E_LOCAL_SUPABASE_PUBLISHABLE_KEY",
  serviceRoleKey: "E2E_LOCAL_SUPABASE_SERVICE_ROLE_KEY",
} as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 主機名稱是不是本機迴路位址(127.0.0.1 / localhost / ::1)。 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** 確認一個 Supabase 網址一定是本機;不是就 throw(訊息寫清楚為什麼中止)。回傳解析後的 URL。 */
export function assertLocalSupabaseUrl(raw: string | undefined): URL {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "[本機 e2e] 拿不到本機 Supabase 網址。請先在 秒約/ 底下執行 `npx supabase start`,確認 `npx supabase status` 正常。",
    );
  }
  if (/supabase\.co/i.test(raw)) {
    throw new Error(
      `[本機 e2e] 目標網址含 supabase.co(${raw}),這是雲端專案,不是本機 ⇒ 中止,一條測試都不跑。`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[本機 e2e] 目標網址格式不正確(${raw})⇒ 中止。`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `[本機 e2e] 目標主機是 ${url.hostname},不是 127.0.0.1 / localhost ⇒ 中止,一條測試都不跑。`,
    );
  }
  return url;
}

/**
 * SPECS-INDEX #874(規格風險 4 / #904 第三層):WebSocket 也只准連本機。
 * 傳入瀏覽器開過的所有 WebSocket 網址,回傳「不是本機」的那些(空陣列 = 全部合格)。
 * 判斷規則跟 HTTP 一樣:主機必須是 127.0.0.1 / localhost / ::1,而且整串網址不可以含 supabase.co;
 * 協定只接受 ws: / wss:,解析不了的網址一律算不合格(寧可錯殺)。
 */
export function nonLoopbackWebSocketUrls(urls: readonly string[]): string[] {
  return urls.filter((raw) => {
    if (/supabase\.co/i.test(raw)) return true;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return true;
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return true;
    return !isLoopbackHost(url.hostname);
  });
}

/** 解析 `supabase status -o env` 的輸出(KEY="value" 一行一個)。 */
export function parseSupabaseStatusEnv(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).trim().replace(/^"|"$/g, "");
    result[key] = value;
  }
  return result;
}

export interface LocalSupabaseTarget {
  url: string;
  publishableKey: string;
  serviceRoleKey: string;
}

/** worker 端讀取本機目標(由 playwright.local.config.ts 事先放進環境變數),順便再檢查一次。 */
export function readLocalSupabaseTarget(): LocalSupabaseTarget {
  const url = process.env[LOCAL_ENV_KEYS.url];
  assertLocalSupabaseUrl(url);
  const publishableKey = process.env[LOCAL_ENV_KEYS.publishableKey];
  const serviceRoleKey = process.env[LOCAL_ENV_KEYS.serviceRoleKey];
  if (!publishableKey || !serviceRoleKey) {
    throw new Error(
      "[本機 e2e] 拿不到本機金鑰。請用 `npm run test:e2e:local` 執行(不要直接 `playwright test`)。",
    );
  }
  return { url: url as string, publishableKey, serviceRoleKey };
}

/** supabase-js 存 session 的 localStorage key(`sb-${hostname 第一段}-auth-token`),用本機網址現算。 */
export function localAuthStorageKey(url: string): string {
  const ref = new URL(url).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}

function requestUrlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

const GUARD_MARK = Symbol.for("miaoyue.e2eLocal.fetchGuard");

/** 把全域 fetch 換成「只准打本機」的版本。重複呼叫只會裝一次。 */
export function installLoopbackOnlyFetchGuard(): void {
  const g = globalThis as typeof globalThis & { [GUARD_MARK]?: true };
  if (g[GUARD_MARK]) return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = requestUrlOf(input);
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      host = "";
    }
    if (!isLoopbackHost(host) || /supabase\.co/i.test(raw)) {
      return Promise.reject(
        new Error(
          `[本機 e2e] 擋下一個打到非本機的請求(${host || raw})——本機模式只准連 127.0.0.1。`,
        ),
      );
    }
    return original(input, init);
  }) as typeof fetch;
  g[GUARD_MARK] = true;
}
