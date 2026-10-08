// 客戶端第 3 批(C3-D04 / C3-F02 / C3-F07):Cloudflare Turnstile(訪客送出的防機器人檢查)。
//
// ・腳本**只在 ⑥-4 不登入預約畫面載入**(TurnstileWidget 掛上時才呼叫 loadTurnstile),其他頁面一律不載
//   (減少對外連線與追蹤)。`render=explicit`:我們自己決定什麼時候畫、什麼時候執行。
// ・Managed 模式 + `appearance: 'interaction-only'`(只在需要時顯示勾選框)+ `execution: 'execute'`
//   (按「送出預約」才執行)。語言 zh-tw;action 固定 guest_booking(伺服器會比對)。
// ・sitekey 是公開資訊:正式 / 預覽環境由 Vercel 環境變數 VITE_TURNSTILE_SITE_KEY 提供
//   (預覽環境設官方測試 sitekey,C3-F07)。本機開發沒設 ⇒ 用官方「必過」測試 sitekey。
//   🔴 secret 只在 Supabase Edge secret(TURNSTILE_SECRET_KEY),前端永遠不會有。
// ・正式 build 沒設 sitekey ⇒ 回 null,畫面顯示「目前無法不登入預約」(不偷偷用測試金鑰:測試 token 會被正式
//   secret 拒絕,客人只會一直看到失敗)。

/** Cloudflare 官方測試 sitekey:任何網域(含 localhost)必過。 */
export const TURNSTILE_TEST_SITEKEY_PASS = "1x00000000000000000000AA";
/** Cloudflare 官方測試 sitekey:必失敗(e2e 測失敗畫面用)。 */
export const TURNSTILE_TEST_SITEKEY_FAIL = "2x00000000000000000000AB";

export const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ACTION = "guest_booking";

export function resolveTurnstileSiteKey(
  env: { key?: string | undefined; dev: boolean } = {
    key: import.meta.env["VITE_TURNSTILE_SITE_KEY"] as string | undefined,
    dev: Boolean(import.meta.env.DEV),
  },
): string | null {
  const key = env.key?.trim();
  if (key) return key;
  return env.dev ? TURNSTILE_TEST_SITEKEY_PASS : null;
}

/** Turnstile 全域物件(只列我們用到的)。 */
export interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** 載入 Turnstile 腳本(整個分頁只載一次;載入失敗下次可以再試)。 */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.dataset["miaoyue"] = "turnstile";
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else {
        loading = null;
        reject(new Error("turnstile-missing"));
      }
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile-load-failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** 測試用:清掉載入狀態。 */
export function resetTurnstileLoaderForTest(): void {
  loading = null;
}
