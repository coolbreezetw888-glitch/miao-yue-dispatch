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
//
// 2026-09-24(頁首吸頂改版)重要調整:這條提示條原本是 `fixed inset-x-0 top-0 z-40`,自己脫離
// 文件流貼在畫面最上緣。頁首改成吸頂(sticky top-0)之後,兩個東西就會搶同一塊位置 ——
// 而這個元件刻意**沒有**「稍後再說」的關閉按鈕(見上面第 3 點),所以一旦它蓋住頁首,使用者就
// 再也按不到頁首上的「登出」跟「切換商家」,直到他願意按下重新整理為止。那正是
// src/lib/fixedLayers.ts 開頭記錄的那次事故(提示條蓋掉「儲存變更」按鈕)的同一類問題。
//
// ⇒ 改成**排在正常文件流裡**的一整條橫幅,由 AppLayout.tsx 放在頁首正下方、跟頁首共用同一個
//   sticky 容器(所以照樣「永遠看得到」,不會被捲走)。一個排在文件流裡的元件不可能蓋住別人,
//   這比「小心挑一個 z-index」更根本,也讓這個元件不再需要任何 top-*/z-* class
//   (所以它不需要在 src/lib/fixedLayers.ts 登記層級)。
// 外觀改成跟頁首/雙重身分橫幅同一套版型(整條滿版、內層 mx-auto max-w-5xl px-5),而不是原本的
// 置中小卡片 —— 排在文件流裡的置中小卡片旁邊會露出背景,視覺上會像浮在半空中。
// ⚠️ 這個元件只有一個使用端(src/routes/AppLayout.tsx),所以不用擔心別的地方仰賴它的 fixed 定位。

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
    // flex-wrap + min-w-0 是刻意的(比照 DualRoleViewSwitchBar):320px 窄螢幕上說明文字跟按鈕
    // 會自動換成兩行,不會把整個頁面撐出橫向捲軸(e2e/mobile-overflow.spec.ts 有在檢查這件事)。
    <div role="status" className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-5 py-2">
        <p className="min-w-0 text-sm text-foreground">有新版本可用,點擊重新整理套用</p>
        <Button size="sm" className="shrink-0" onClick={handleRefreshClick} disabled={applying}>
          {applying ? "更新中⋯" : "重新整理"}
        </Button>
      </div>
    </div>
  );
}
