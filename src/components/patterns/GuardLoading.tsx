/**
 * 路由守衛在「還不知道你有沒有權限」那段時間要顯示的東西 —— ui-overlay-patterns skill 二之八
 * 「載入中:灰色骨架方塊,不要用『載入中⋯』四個字」。
 *
 * 為什麼要獨立成一個共用元件(2026-09-30,SPECS-INDEX #832 收尾批):
 *   全站有 22 支路由守衛(`src/modules/**\/Require*.tsx` + PlatformAdminGuard.tsx),每一支都自己
 *   寫了一份一模一樣的
 *       <div className="flex min-h-screen items-center justify-center bg-surface">
 *         <p className="text-sm text-muted-foreground">載入中⋯</p>
 *       </div>
 *   複製 22 份的後果是:誰都不敢只改自己手上那幾支(改了就變成 22 支裡有幾支長得不一樣),
 *   於是前三批都繞過它。抽成一個元件之後,以後要調整守衛的等待畫面只有這一個地方。
 *
 * 🔴 骨架為什麼比「載入中⋯」好(不要改回去):
 *   1. 骨架讓人**覺得**比較快 —— 四個字等於告訴使用者「現在什麼都沒有」。
 *   2. 骨架的方塊位置跟真正的內容差不多,資料進來時版面不會整個跳一次。
 *   3. 原本那份是 `min-h-screen` + 上下置中,四個字浮在螢幕正中間,真內容一進來就從中間
 *      「彈」到頂端。骨架改成靠上排,不會有這個跳動。
 *
 * 📌 這個元件刻意不吃任何 prop:守衛的等待畫面就是要全站一致,不該讓 22 個呼叫點各自微調。
 *    頁面內部區塊的載入骨架請直接用 `LoadingSkeleton`(可以挑 cards / lines 跟列數)。
 */

import { Skeleton } from "@/components/ui/skeleton";

import { LoadingSkeleton } from "./PageScaffold";

export function GuardLoading() {
  return (
    <div
      className="mx-auto w-full max-w-3xl px-5 py-10"
      aria-busy="true"
      aria-live="polite"
      aria-label="載入中"
    >
      {/* 頁首骨架:標題一條(對應 PageHeader 的 19/22px 標題)+ 說明一條。 */}
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-5 w-40 rounded-sm bg-muted" />
        <Skeleton className="h-3 w-full max-w-[16rem] rounded-sm bg-muted/70" />
      </div>
      {/* 內容骨架:大部分守衛後面接的是列表或表單卡片。 */}
      <LoadingSkeleton className="mt-7" variant="cards" rows={3} />
    </div>
  );
}
