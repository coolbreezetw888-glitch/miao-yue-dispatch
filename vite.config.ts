import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
    // 模組 7(排班與休假管理)§6.4:PWA service worker,只做 app shell 靜態資源快取
    // (CacheFirst),不快取任何 Supabase API 請求。已實測 vite-plugin-pwa 1.3.0 跟這個專案的
    // Vite 8.1.5 相容(npm run build 正常產出 dist/sw.js 等建置產物,見 6.4 邊界情況)。
    //
    // ⚠️ 2026-09-20 主腦複查後修正(取代這裡原本的說明,務必以這段為準):原本的設計是「偵測到
    // 新版本就自動 skipWaiting + reload,不需要使用者確認」,理由是「核心資料一律即時打 API、
    // 不快取,自動更新不會有操作到一半被打斷的風險」——這個理由只考慮了「資料」層面,漏算了
    // 「畫面上還沒送出的表單內容」:如果客服正在填一份很長的新增預約表單,填到一半剛好遇到新版本
    // 上線,畫面會被強制重新整理,表單內容全部消失、沒有存檔,這是真實會發生的資料遺失情境。
    // 現在改成「偵測到新版本 → 顯示不擋畫面的提示條 → 使用者自己按下重新整理按鈕才套用」(見
    // src/pwaUpdate.ts、src/components/UpdateAvailableHint.tsx)。
    // `registerType: "autoUpdate"` 維持不變,繼續保留——這個設定值只影響 workbox 產出的 sw.js
    // 內建「監聽 `{type:"SKIP_WAITING"}` 這個 postMessage 才呼叫 self.skipWaiting()」的訊息
    // 監聽器,不代表 sw.js 自己會「自動」skipWaiting(已用 Playwright 對建置產物實測確認過:
    // sw.js 裡是 `self.addEventListener("message", ...)` 訊息觸發式寫法,不是安裝完就自己呼叫)。
    // skipWaiting 什麼時候真的被觸發,完全由 `applyPendingServiceWorkerUpdate()` 什麼時候被
    // 使用者主動呼叫決定,跟這個設定值本身無關,不需要為了這次修正改掉這個值。
    VitePWA({
      registerType: "autoUpdate",
      // 已經手刻 public/manifest.json + index.html 的 <link rel="manifest">,不需要這個外掛
      // 重複產生/注入一份 manifest.webmanifest,避免同一個頁面出現兩份 manifest 互相打架。
      manifest: false,
      // 不用預設的 injectRegister(那只會注入一段「單純呼叫 register()」的陽春腳本,無法客製化
      // 「偵測到新版本後怎麼處理」的邏輯)。改成 injectRegister:false,自己在 src/pwaUpdate.ts
      // 用原生 Service Worker API 手刻註冊/偵測新版本邏輯(不用 vite-plugin-pwa 的
      // `virtual:pwa-register` 高階封裝,見 src/pwaUpdate.ts 檔頭「為什麼不用」的說明),偵測到
      // 新版本後只通知 UpdateAvailableHint.tsx 顯示提示條,不自動套用。
      injectRegister: false,
      workbox: {
        // 只精確快取建置產物(JS/CSS/字型/圖示這些不常變動的檔案),預設的 globPatterns 已經
        // 只涵蓋 dist 底下的建置產物,不會意外連 Supabase API 請求都快取住——這個系統的資料
        // (訂單/排班/行事曆)必須永遠即時,API 請求一律不進入這份 precache 清單,也不額外設定
        // runtimeCaching 規則去攔截 *.supabase.co 的請求,維持「一律直接打網路」。
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // 不設定 navigateFallback:SPA 的路由 fallback 已經由 vercel.json 的 rewrites 在 CDN
        // 層級處理,不需要 service worker 也做一次,避免兩層 fallback 邏輯互相打架。
        cleanupOutdatedCaches: true,
        // 模組 15(服務人員推播通知)§7.1:在產出的 sw.js 最上方插入一行
        // `importScripts('/push-sw.js')`,讓 public/push-sw.js 裡的 push/notificationclick
        // 事件監聽器註冊在同一個 service worker 執行環境下。這是 workbox generateSW 模式官方
        // 支援的設定項,不需要改成 injectManifest 模式自己完全手刻 service worker,不會影響上面
        // 這段自動更新偵測邏輯(已用 `npm run build` 實際確認 dist/sw.js 內容正確包含這行,
        // 見 §7.1 邊界情況、6.4 節既有的建置產物實測習慣)。
        importScripts: ["/push-sw.js"],
        // ⚠️ 實測踩坑記錄(2026-09-20,務必保留這個設定跟這段說明):預設(false)會把
        // workbox 執行時期程式碼拆成獨立的 workbox-xxxx.js,sw.js 用一段自製的 shim 透過
        // importScripts 非同步載入它,`self.skipWaiting()` 因此被延後到一個 microtask 裡才真正
        // 執行——實測發現這個時間差會讓 Chrome 把這次安裝永遠卡在 registration.waiting(installed)
        // 狀態,新版本完全不會自動生效,即使搭配 src/main.tsx 的 onNeedRefresh/updateSW(true) 也
        // 一樣卡住(用 Playwright 實際重現過:build 兩次版本不同、已開啟的分頁呼叫
        // registration.update() 後,新 worker 卡在 installed 狀態超過 15 秒都不會轉成
        // activated)。改成 true(整個 workbox 執行時期直接內嵌進 sw.js 這單一檔案),
        // `self.skipWaiting()` 變成在 sw.js 頂層同步執行,新版本會立刻正確 activate 並透過
        // clientsClaim() 接管已開啟的分頁——已用同樣的 Playwright 腳本重新驗證通過(見交付報告)。
        inlineWorkboxRuntime: true,
      },
    }),
  ],
});
