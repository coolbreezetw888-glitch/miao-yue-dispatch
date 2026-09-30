import { Link } from "react-router-dom";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-5">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-16">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}

/**
 * 「還在驗證這個連結有沒有效」那段時間的等待畫面 —— ui-overlay-patterns skill 二之八
 * 「載入中:灰色骨架方塊,不要用『載入中⋯』四個字」。
 *
 * 2026-09-30(使用者實機巡檢批):這四頁原本各自寫了一份一模一樣的
 *     <div className="flex min-h-screen items-center justify-center bg-surface">
 *       <p className="text-sm text-muted-foreground">載入中⋯</p>
 *     </div>
 * ——重設密碼、信箱變更確認、服務人員邀請完成、客服邀請完成。
 *
 * 🔴 為什麼不直接套 `GuardLoading`(守衛那支):**骨架要對得上後面真的會出現的東西**。
 *    這四頁驗完之後出現的是 `AuthShell` 那張置中的小卡(標題 + 副標 + 一到兩個密碼欄 + 一顆按鈕),
 *    不是 App 內的「頁首 + 三張列表卡」。套錯的骨架比四個字更糟:方塊排在完全不同的位置,
 *    真內容一進來版面整個跳一次,骨架「讓版面不跳」的好處就沒了。
 *
 * 📌 標題/副標也做成骨架,是因為**這個階段還不知道標題會是什麼** ——
 *    驗證結果可能是「設定你的密碼」,也可能是「邀請連結已失效」。
 */
export function AuthShellLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-5">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 py-16">
        <div
          className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm"
          aria-busy="true"
          aria-live="polite"
          aria-label="載入中"
        >
          {/* 標題(2xl)+ 副標一行。 */}
          <Skeleton className="h-6 w-48 rounded-sm bg-muted" />
          <Skeleton className="mt-3 h-3 w-full max-w-[17rem] rounded-sm bg-muted/70" />
          {/* 內容:兩個欄位(標籤 + 44px 輸入框)+ 一顆整條寬的按鈕。 */}
          <div className="mt-8 flex flex-col gap-5">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-20 rounded-sm bg-muted/70" />
                <Skeleton className="h-11 w-full rounded-lg bg-muted" />
              </div>
            ))}
            <Skeleton className="h-11 w-full rounded-lg bg-muted" />
          </div>
        </div>
      </main>
    </div>
  );
}
