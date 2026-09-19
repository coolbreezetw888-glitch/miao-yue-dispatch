// 模組 7(排班與休假管理)§6.4:PWA service worker 更新提示條。
// 2026-09-20 主腦複查後新增(取代原本「偵測到新版本就靜默自動重新整理」的做法,見
// src/pwaUpdate.ts 檔頭說明)——不擋畫面的小提示條,使用者自己按下「重新整理」按鈕才真的套用
// 新版本,不會在使用者填表單填到一半時未經同意就把畫面蓋掉、造成資料遺失。
//
// 邏輯:
// 1. 掛載時訂閱 onServiceWorkerUpdateAvailable——訂閱當下如果已經有一個待套用的新版本
//    (例如元件是在 updatefound 事件觸發之後才掛載),會立刻收到一次回呼,不會漏接。
// 2. 顯示提示條後,按下「重新整理」呼叫 applyPendingServiceWorkerUpdate(),送出
//    SKIP_WAITING 訊息;實際的 window.location.reload() 由 pwaUpdate.ts 的
//    controllerchange 監聽器負責,不在這個元件裡直接呼叫(避免這個元件自己猜測時機)。
// 3. 按下按鈕後把按鈕改成「更新中⋯」並停用,避免使用者重複點擊;不提供「稍後再說」的關閉選項
//    ——跟 InstallPwaHint(單純的安裝建議,可以無限期忽略)不同,這裡忽略不影響任何功能、
//    新版本會在下次自然重新整理時生效,所以不需要額外的節流/關閉狀態,提示條本身不擋畫面,
//    留著也不影響操作。
//
// 顯示位置刻意放在畫面「頂部」,跟 InstallPwaHint(畫面底部,底部導覽列上方)分開,避免兩個
// 提示條同時出現時互相重疊、蓋住彼此。

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { applyPendingServiceWorkerUpdate, onServiceWorkerUpdateAvailable } from "@/pwaUpdate";

export default function UpdateAvailableHint() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    return onServiceWorkerUpdateAvailable(() => setUpdateAvailable(true));
  }, []);

  function handleRefreshClick() {
    setApplying(true);
    applyPendingServiceWorkerUpdate();
  }

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-b-lg border border-t-0 border-border bg-background px-4 py-3 shadow-lg"
    >
      <p className="min-w-0 flex-1 text-sm text-foreground">有新版本可用,點擊重新整理套用</p>
      <Button size="sm" onClick={handleRefreshClick} disabled={applying}>
        {applying ? "更新中⋯" : "重新整理"}
      </Button>
    </div>
  );
}
