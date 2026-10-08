// 模組 7(排班與休假管理)§6.4:PWA service worker 更新生命週期(主腦裁示補充,規格書原文
// 只提到「快取靜態資源」,沒有講「新版本上線後,已經開著分頁的使用者要怎麼拿到新版本」)。
//
// **2026-09-20 主腦複查後修正,取代原本「偵測到新版本就靜默自動 reload」的做法**:原本的實作
// 一偵測到新版本裝好、且目前分頁已經有舊版本在跑,就立刻送出 SKIP_WAITING 讓新 worker 接管,
// 觸發 controllerchange 後直接 `window.location.reload()`,完全沒有預告。這是真實的資料遺失
// 風險——如果客服正在填一份很長的新增預約表單,填到一半剛好遇到後端推送新版本上線,畫面會被
// 強制重新整理,表單內容全部消失、沒有存檔。改成:偵測到新版本 → 只記錄「有新版本待套用」這個
// 狀態、通知訂閱者(給 UpdateAvailableHint.tsx 顯示不擋畫面的提示條)→ 使用者自己按下提示條的
// 「重新整理」按鈕,才呼叫 applyPendingServiceWorkerUpdate() 送出 SKIP_WAITING、進而觸發
// controllerchange → reload。使用者如果不理會這個提示,新版本會在他們下次自然重新整理/重新
// 開啟分頁時生效——這是可以接受的行為,比起未經同意就蓋掉別人正在填的表單,晚一點拿到新版本是
// 小很多的代價。
//
// **為什麼不用 vite-plugin-pwa 的 `virtual:pwa-register` 高階封裝**:2026-09-20 實測(用
// Playwright 模擬「build 兩次、版本不同」的情境)發現,即使搭配 `registerType: "autoUpdate"`,
// `virtual:pwa-register` 的 `registerSW()` 在這個專案的建置產物上,`onNeedRefresh` 回呼並沒有
// 在偵測到新的 service worker 時確實觸發(透過 `registration.update()` 主動觸發檢查後,
// `registration.waiting` 確實出現了新版本,但 `onNeedRefresh` 從未被呼叫)——原因無法在有限
// 時間內完全排除是這個套件版本的行為、還是這個專案建置設定的某種互動效應,但既然核心目的只是
// 「偵測到新 service worker 就通知使用者、使用者同意後才讓它生效」,直接用瀏覽器原生
// Service Worker API 手刻這一段邏輯更明確、更容易驗證行為是否正確,不依賴任何第三方套件的
// 內部黑盒判斷。
//
// vite.config.ts 已經設定 `injectRegister: false`,避免 vite-plugin-pwa 另外注入一段
// 陽春的註冊腳本,跟這裡的手動註冊重複註冊兩次 service worker。
// vite.config.ts 的 workbox 設定 `inlineWorkboxRuntime: true`(務必保留,見該檔案的踩坑記錄):
// 這讓產出的 sw.js 監聽 `{ type: "SKIP_WAITING" }` 這個 postMessage 來呼叫 self.skipWaiting()
// (workbox 標準的「訊息觸發式」skip waiting,對應 `registerType: "autoUpdate"`——這個設定值只
// 影響 sw.js 內建的訊息監聽器,不代表「自動」skip waiting,skipWaiting 什麼時候真的被觸發,
// 完全由這裡的 `applyPendingServiceWorkerUpdate()` 什麼時候被呼叫決定),這裡的
// `applyPendingServiceWorkerUpdate` 就是負責送出這個訊息的那一端。

/** 目前偵測到、卡在 `installed`(waiting)狀態、尚未取得使用者同意套用的新 service worker。
 * null 代表目前沒有待套用的新版本。 */
let pendingWorker: ServiceWorker | null = null;

/** 2026-10-01(#966 更新提示改成可按「稍後」收起的浮動卡片)新增:回呼時一併告訴訂閱者
 * 「這是不是一個**剛剛才偵測到**的新版本」。
 *   - `true`:這個分頁開著的期間,`updatefound` 真的裝好了一個新版本 —— 就算使用者剛才按過「稍後」,
 *     這也是**又一個**新版本,卡片要再跳出來。
 *   - `false`:只是「早就在等待中」的那一個 —— 訂閱當下立刻補發的那一次,或頁面載入時發現
 *     `registration.waiting` 已經有東西(使用者上次按了「稍後」之後重新整理頁面)。
 *     使用者在這次瀏覽期間已經按過「稍後」的話,這種不該再跳。
 * 既有的呼叫端不看這個參數也完全不受影響。 */
export interface UpdateAvailableInfo {
  isNewDetection: boolean;
}

type UpdateAvailableListener = (info: UpdateAvailableInfo) => void;
const updateAvailableListeners = new Set<UpdateAvailableListener>();

/** 訂閱「有新版本待套用」這個狀態。訂閱當下如果已經有一個在等待中的新版本(例如元件是在
 * updatefound 事件觸發之後才掛載的),立刻回呼一次(`isNewDetection: false`),不會漏接。
 * 回傳取消訂閱函式。 */
export function onServiceWorkerUpdateAvailable(listener: UpdateAvailableListener): () => void {
  updateAvailableListeners.add(listener);
  if (pendingWorker) listener({ isNewDetection: false });
  return () => {
    updateAvailableListeners.delete(listener);
  };
}

/** 使用者在 UpdateAvailableHint.tsx 按下「重新整理」之後呼叫:把待套用的新 worker 標記清空,
 * 送出 SKIP_WAITING 訊息讓它 `self.skipWaiting()`,之後觸發的 `controllerchange` 事件會負責
 * 真正的 `window.location.reload()`(見下方 `registerServiceWorkerAutoUpdate`)。沒有待套用的
 * 新版本時安全地什麼都不做(避免元件重複點擊時重複送出/丟例外)。 */
export function applyPendingServiceWorkerUpdate(): void {
  if (!pendingWorker) return;
  const worker = pendingWorker;
  pendingWorker = null;
  worker.postMessage({ type: "SKIP_WAITING" });
}

function markUpdateAvailable(worker: ServiceWorker, isNewDetection: boolean): void {
  pendingWorker = worker;
  updateAvailableListeners.forEach((listener) => listener({ isNewDetection }));
}

// ─── SPECS-INDEX #1014(第 19 批,2026-10-08):下拉刷新 / 切回前景時也主動檢查一次新版本 ─────────
// 使用者回報:手機下拉重新整理不會出現「有新版本」提示,要關掉 App 再開才會。根因:原本只有
// 「頁面載入時瀏覽器自己檢查」跟「每小時 setInterval」兩個時機會呼叫 `registration.update()`;
// 下拉刷新(PullToRefresh.tsx)只重抓 react-query 資料,手機 App 切到背景再切回來也不會重新載入頁面
// ⇒ 新版本上線後,使用者怎麼下拉都看不到提示。
// 補兩個時機(都走下面同一個 checkForServiceWorkerUpdate,共用節流):
//   ① 下拉刷新放開時(PullToRefresh.tsx 呼叫)。
//   ② App 從背景切回前景(document visibilitychange → visible,主腦補上的決定,可單獨退:
//      把 registerServiceWorkerAutoUpdate 裡那段 visibilitychange 監聽刪掉即可)。
// 檢查到新版本之後走的是**原本那條** updatefound → installed → markUpdateAvailable(..., true) 路徑,
// 提示卡外觀、「稍後」規則(#966 isNewDetection)完全不變;**不會**強制 reload、也不會自動套用。

/** 兩次主動檢查之間至少間隔這麼久(主腦補上的決定:避免連續下拉、頻繁切換 App 時一直打伺服器)。 */
export const SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS = 30 * 1000;

/** 註冊完成後拿到的 registration;還沒註冊好(或瀏覽器不支援)時是 null,檢查直接略過。 */
let activeRegistration: ServiceWorkerRegistration | null = null;
/** 上一次「真的送出」檢查的時間(performance.now());null = 還沒檢查過。 */
let lastUpdateCheckAt: number | null = null;
/** 檢查進行中就不再疊一個新的。 */
let updateCheckInFlight = false;
/** registerServiceWorkerAutoUpdate 只准生效一次(避免重複註冊 visibilitychange / controllerchange 監聽)。 */
let autoUpdateRegistered = false;
/** 掛上去的監聽 / 計時器的拆除函式。正式環境整個頁面生命週期只掛一次、不需要拆;
 * 留著是讓測試能完整清乾淨(也確保每一個監聽都「拆得掉」)。 */
const autoUpdateTeardowns: Array<() => void> = [];

/** 主動檢查一次有沒有新版本(`registration.update()`)。
 *   ・30 秒內已經檢查過、或上一次還沒結束 ⇒ 直接略過(節流)。節流是從「送出檢查」那一刻算,
 *     失敗(離線)也算一次,離線時連續下拉不會一直重試。
 *   ・**永遠不會 reject**:任何錯誤(離線、伺服器錯誤、還沒註冊好、瀏覽器不支援)都安靜吞掉,
 *     呼叫端(下拉刷新)不需要也不應該等它、更不會因此報錯或卡住。
 *   ・只負責「戳一下」;偵測到新版本之後怎麼通知,一律交給既有的 updatefound 監聽。
 * 回傳 true = 這次真的送出了檢查;false = 被節流或沒有 registration 而略過(給測試看,呼叫端可忽略)。 */
export function checkForServiceWorkerUpdate(now: number = performance.now()): Promise<boolean> {
  const registration = activeRegistration;
  if (!registration) return Promise.resolve(false);
  if (updateCheckInFlight) return Promise.resolve(false);
  if (
    lastUpdateCheckAt !== null &&
    now - lastUpdateCheckAt < SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS
  ) {
    return Promise.resolve(false);
  }
  lastUpdateCheckAt = now;
  updateCheckInFlight = true;
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(registration.update());
  } catch {
    pending = Promise.resolve();
  }
  return pending.then(
    () => {
      updateCheckInFlight = false;
      return true;
    },
    () => {
      // 網路離線或其他暫時性錯誤,靜默忽略,下一次(下拉 / 切回前景 / 每小時)還會再檢查。
      updateCheckInFlight = false;
      return true;
    },
  );
}

/** 只給單元測試用:把模組層級的狀態清回初始值。 */
export function __resetServiceWorkerUpdateStateForTest(): void {
  autoUpdateTeardowns.splice(0).forEach((teardown) => teardown());
  pendingWorker = null;
  updateAvailableListeners.clear();
  activeRegistration = null;
  lastUpdateCheckAt = null;
  updateCheckInFlight = false;
  autoUpdateRegistered = false;
}

/** App 切回前景時檢查一次新版本(#1014 ②)。具名函式,確保只會被註冊一次、需要時也能移除。 */
function handleVisibilityChangeForUpdateCheck(): void {
  if (document.visibilityState === "visible") {
    void checkForServiceWorkerUpdate();
  }
}

export function registerServiceWorkerAutoUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  // #1014:防止被呼叫兩次時重複掛 load / visibilitychange / controllerchange 監聽與 setInterval。
  if (autoUpdateRegistered) return;
  autoUpdateRegistered = true;

  const serviceWorkerContainer = navigator.serviceWorker;
  const handleLoad = () => {
    serviceWorkerContainer.register("/sw.js", { scope: "/" }).then((registration) => {
      activeRegistration = registration;
      // 頁面載入當下如果剛好已經有一個新版本卡在 waiting(例如上一次分頁關閉前使用者還沒按下
      // 「重新整理」),視同「偵測到新版本」,通知訂閱者顯示提示條——不再像舊版一樣立刻自動送出
      // SKIP_WAITING。
      if (registration.waiting) {
        markUpdateAvailable(registration.waiting, false);
      }

      // 監聽這個 registration 之後偵測到的任何新版本(不論是瀏覽器自己在導覽時檢查到的,
      // 還是下面 setInterval 主動戳出來的)。
      registration.addEventListener("updatefound", () => {
        const installingWorker = registration.installing;
        if (!installingWorker) return;
        installingWorker.addEventListener("statechange", () => {
          // state 變成 'installed' 且目前已經有一個 controller 在控制這個分頁,代表這不是
          // 「第一次安裝」,而是「已經有舊版本在跑,新版本裝好了」——這才是需要提示使用者更新的
          // 情境。只記錄狀態、通知訂閱者,不自動套用。
          if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
            markUpdateAvailable(installingWorker, true);
          }
        });
      });

      // 瀏覽器本身會在每次導覽時自動檢查一次新版本,但如果使用者整天開著同一個分頁完全不做
      // 任何導覽,永遠不會觸發那個檢查——這裡額外每小時主動戳一次,確保這種情境也能在合理時間
      // 內偵測到新版本(偵測到之後一樣只顯示提示條,不會自動整理)。
      // #1014:改走 checkForServiceWorkerUpdate(共用節流、錯誤一律靜默忽略),行為跟原本一樣。
      const intervalId = window.setInterval(
        () => {
          void checkForServiceWorkerUpdate();
        },
        60 * 60 * 1000,
      );
      autoUpdateTeardowns.push(() => window.clearInterval(intervalId));
    });
  };
  window.addEventListener("load", handleLoad, { once: true });
  autoUpdateTeardowns.push(() => window.removeEventListener("load", handleLoad));

  // #1014 ②:手機 App 從背景切回前景(或電腦切回這個分頁)⇒ 檢查一次新版本(受 30 秒節流)。
  // 整個頁面生命週期只掛這一次(上面 autoUpdateRegistered 擋住重複呼叫),不會累積。
  document.addEventListener("visibilitychange", handleVisibilityChangeForUpdateCheck);
  autoUpdateTeardowns.push(() =>
    document.removeEventListener("visibilitychange", handleVisibilityChangeForUpdateCheck),
  );

  // 新版本 skipWaiting 後會觸發 controllerchange——這是真正「新版本已經接管這個分頁」的訊號,
  // 這時候重新整理拿到新的 JS/CSS/HTML。**只有使用者主動按下 UpdateAvailableHint.tsx 的
  // 「重新整理」按鈕、呼叫 applyPendingServiceWorkerUpdate() 送出 SKIP_WAITING 之後,才會走到
  // 這裡**——不會有「使用者還沒同意,畫面卻自己跳掉」的情況。用 refreshing 旗標避免重複觸發
  // 造成無限重新整理迴圈(標準的 workbox/PWA 教學都會提醒這個防護,不能省略)。
  let refreshing = false;
  const handleControllerChange = () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  };
  serviceWorkerContainer.addEventListener("controllerchange", handleControllerChange);
  autoUpdateTeardowns.push(() =>
    serviceWorkerContainer.removeEventListener("controllerchange", handleControllerChange),
  );
}
