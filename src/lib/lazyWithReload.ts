// SPECS-INDEX #1054(網站拆檔):頁面改成「用到才下載」之後,部署新版會讓舊版的分檔從伺服器上消失。
// 如果使用者的分頁還開著舊版主程式,之後切到一個還沒下載過的頁面,就會去要一個已經不存在的舊分檔
// (Vercel 對不存在的路徑回 index.html,瀏覽器拒絕把它當 JS 執行 ⇒ 動態載入失敗)。
//
// 這裡的做法:
//   ① 動態載入失敗,而且「最近 CHUNK_RELOAD_WINDOW_MS 內沒有自動重新整理過」⇒ 在 sessionStorage
//      記下現在的時間,然後整頁重新整理一次,拿到新版的 index.html 與新的分檔名稱。等待重新整理的這段
//      時間,回傳一個不會結束的 promise,讓畫面停在既有的骨架(Suspense fallback),不會閃錯誤。
//   ② 動態載入失敗,但記號的時間還在 CHUNK_RELOAD_WINDOW_MS 之內(代表剛剛才自動重整過)⇒ 不再重新
//      整理,照原本的錯誤往外丟。記號保留,不清掉。
//   ③ 載入成功 ⇒ **不碰記號**。
//      (QA 打回:原本「載入成功就清記號」會造成無限重整 —— 同一個網址要載兩包時,例如 /app/calendar
//       要外殼那包 + 行事曆那包,第一包成功把記號清掉,第二包一直失敗就永遠看不到記號,每次都再重整。
//       改成只看時間:不論中間有幾包成功,只要剛重整過不到 CHUNK_RELOAD_WINDOW_MS,就一定不會再自動重整,
//       所以最多每 CHUNK_RELOAD_WINDOW_MS 自動重整一次,不可能無限循環。)
//      記號過期後(例如隔了幾分鐘、甚至又部署了一次新版)再遇到失敗,可以再自動重整一次。
//   ④ 同一個頁面裡已經排定重新整理 ⇒ 其他同時失敗的載入一律只等重新整理,不再碰記號。
//   ⑤ sessionStorage 不能用(讀寫丟例外)⇒ 無法記住「剛重整過」,為了不陷入重整迴圈,直接照原本的
//      錯誤往外丟,不自動重新整理。
//
// sessionStorage 只存這一個記號(值是時間戳),不存任何使用者資料。

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** sessionStorage 記號的 key。 */
export const CHUNK_RELOAD_FLAG_KEY = "miaoyue:chunk-reload-attempted";

/** 兩次「自動重新整理」之間至少隔這麼久;這段時間內再失敗就不再自動重整。 */
export const CHUNK_RELOAD_WINDOW_MS = 60 * 1000;

export interface ChunkReloadEnvironment {
  /** 取得 sessionStorage;取不到(例如瀏覽器封鎖)時丟例外或回傳 null。 */
  getStorage: () => Pick<Storage, "getItem" | "setItem"> | null;
  /** 整頁重新整理。 */
  reload: () => void;
  /** 現在時間(毫秒)。 */
  now: () => number;
}

const browserEnvironment: ChunkReloadEnvironment = {
  getStorage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  now: () => Date.now(),
};

/** 這個頁面是否已經排定一次自動重新整理(模組層級;重新整理之後自然歸零)。 */
let reloadScheduled = false;

/** 只給單元測試用:把模組層級的狀態清回初始值。 */
export function __resetChunkReloadStateForTest(): void {
  reloadScheduled = false;
}

/** 記號是否還在有效期內(= 剛剛才自動重整過)。記號不存在、不是數字 ⇒ 視為沒有;
 * 時間差用絕對值,電腦時間被往回調時也只會「保守地不重整」,最多 CHUNK_RELOAD_WINDOW_MS 後恢復。 */
function isRecentReload(raw: string | null, now: number): boolean {
  if (raw === null) return false;
  const at = Number(raw);
  if (!Number.isFinite(at)) return false;
  return Math.abs(now - at) < CHUNK_RELOAD_WINDOW_MS;
}

/**
 * 包住一個動態 import:失敗時自動整頁重新整理一次;剛重整過(CHUNK_RELOAD_WINDOW_MS 內)又失敗,
 * 就把錯誤往外丟。規則見檔頭 ①~⑤。
 */
export function loadWithReloadOnce<T>(
  loader: () => Promise<T>,
  env: ChunkReloadEnvironment = browserEnvironment,
): Promise<T> {
  return loader().catch((error: unknown) => {
    if (reloadScheduled) return new Promise<T>(() => {});

    const now = env.now();
    try {
      const storage = env.getStorage();
      if (!storage) throw error;
      if (isRecentReload(storage.getItem(CHUNK_RELOAD_FLAG_KEY), now)) throw error;
      storage.setItem(CHUNK_RELOAD_FLAG_KEY, String(now));
    } catch {
      // 讀不到 / 寫不進 sessionStorage,或剛重整過 ⇒ 不自動重整,照原本的錯誤往外丟。
      throw error;
    }

    reloadScheduled = true;
    env.reload();
    return new Promise<T>(() => {});
  });
}

/**
 * `React.lazy` 的替代品:載入失敗時自動重新整理一次(見 loadWithReloadOnce)。
 * `pick` 從載入回來的模組挑出要顯示的元件(同一個分組檔匯出好幾頁,用名字挑)。
 */
export function lazyWithReload<M, P extends object>(
  loader: () => Promise<M>,
  pick: (loaded: M) => ComponentType<P>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => loadWithReloadOnce(loader).then((loaded) => ({ default: pick(loaded) })));
}
