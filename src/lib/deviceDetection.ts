// 裝置判斷的純函式。放在 src/lib 而不是元件檔裡,有兩個理由:
//   1. 🔴 SPECS-INDEX #862 的要求就是「判斷邏輯抽成純函式,不要在元件裡塞一段 UA 正則」。
//   2. eslint 的 react-refresh/only-export-components:元件檔案再多匯出一個非元件的東西,
//      就會多一個 warning。這個專案的慣例本來就是「純函式放 src/lib」(validation.ts /
//      statusPillStyle.ts / bottomFixedLayers.ts 都是),跟著慣例走。

/** isMobileDevice 的輸入:只吃「值」不吃 navigator,才能當純函式測試。 */
export interface DeviceHints {
  userAgent: string;
  /** navigator.maxTouchPoints。讀不到時傳 0。 */
  maxTouchPoints: number;
}

/**
 * SPECS-INDEX #862(使用者裁決 A):這台裝置是不是「手機/平板」——只有它回 true 才顯示安裝提示。
 *
 * 為什麼需要這支:`beforeinstallprompt` **桌面版 Chrome 也會觸發**,所以不能拿「有沒有收到那個
 * 事件」當作「是不是手機」。這裡用「允許清單」的方式判斷,不是用「排除清單」——寧可少跳
 * (某台冷門手機沒被認出來,使用者少看到一條提示,沒有任何功能損失),也不要在電腦上誤跳
 * (那正是使用者這次要修掉的事)。
 *
 * 判斷順序與理由:
 *   1. iPhone / iPad / iPod → 一定是手機或平板。
 *   2. Android → Android 手機與平板都算(桌面版 Android 在實務上不存在)。
 *   3. 其他行動平台的既有特徵字:Windows Phone / IEMobile / BlackBerry / Opera Mini /
 *      Silk / Kindle,以及 UA 裡的 `Mobile` 或 `Tablet` 標記。
 *      ⚠️ `Mobile` 這個字不會出現在桌面版 Chrome / Edge / Firefox / Safari 的 UA 裡,
 *         所以拿它當行動裝置訊號是安全的。
 *   4. 🔴 iPadOS 13 以後的 Safari **預設用「桌面版」UA**(字串是 Macintosh,完全沒有 iPad),
 *      光看 UA 會把 iPad 判成 Mac。iPad 上 `maxTouchPoints` 是 5,Mac 是 0 ⇒ 用
 *      「UA 說 Macintosh 但有多點觸控」補判成平板。(有觸控螢幕的 Windows 筆電不會進這一條,
 *      它的 UA 是 Windows NT,而且它本來就是電腦,不該跳。)
 *   5. 其他一律 false(桌面 Windows / macOS / Linux 的各種瀏覽器都落在這裡)。
 */
export function isMobileDevice({ userAgent, maxTouchPoints }: DeviceHints): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  if (/Android/.test(userAgent)) return true;
  if (/Windows Phone|IEMobile|BlackBerry|Opera Mini|Silk|Kindle/.test(userAgent)) return true;
  if (/Mobile|Tablet/.test(userAgent)) return true;
  // iPadOS 13+ 的「桌面版 UA」iPad。
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return false;
}
