// 客戶端 Edge Function 共用:網站網址 / CORS 來源 / 本機判斷。
// 第 2 批 customer-line-login 原本寫在自己的 index.ts,第 3 批 customer-booking-submit 也要用同一套
// (規格 C3-B「CORS 只允許網站網域與本機開發網址(沿用 customer-line-login 的做法)」),搬到這裡共用;
// customer-line-login 仍以同名 export 轉出,既有測試不用改。內容逐字沿用第 2 批。

export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "kong", "host.docker.internal"]);

export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function siteOrigin(env: (k: string) => string | undefined): string | null {
  const raw = env("PUBLIC_SITE_URL");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && !LOCAL_HOSTS.has(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string | null, site: string | null): boolean {
  if (origin === null) return true; // 非瀏覽器呼叫(沒有 Origin 標頭)不受 CORS 管
  if (site && origin === site) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}
