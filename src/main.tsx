import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { Toaster } from "./components/ui/sonner";
import { registerServiceWorkerAutoUpdate } from "./pwaUpdate";
import "./styles.css";

// 模組 7(排班與休假管理)§6.4:PWA service worker 更新生命週期(主腦裁示補充,規格書原文
// 只提到快取靜態資源,沒有講更新機制)。抽成 pwaUpdate.ts 獨立檔案,見該檔案開頭說明——
// 實測發現 vite-plugin-pwa 的 `virtual:pwa-register` 高階封裝在某些情境下不會正確觸發
// onNeedRefresh,改成直接呼叫原生 Service Worker API 手動實作,行為更明確、也更容易驗證。
// 2026-09-20 主腦複查後修正:偵測到新版本不再靜默自動 reload,改成通知
// UpdateAvailableHint.tsx 顯示提示條,使用者自己按下按鈕才套用(見 pwaUpdate.ts 檔頭說明)。
registerServiceWorkerAutoUpdate();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="top-center" />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
