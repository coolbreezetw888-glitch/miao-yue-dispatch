// 客戶端第 1 批(C1):公開預約頁共用的外框元件(頁面殼、步驟頁首、聯絡按鈕)。
//
// 版面依 ui-overlay-patterns skill(方案 D):手機優先;電腦是「同一個畫面變寬並置中」(max-w-3xl),
// 不加欄位。上方頁首、下方動作列固定,只有中間捲動(整頁捲動 + sticky,手機瀏覽器網址列收合時也正常)。
// 🔴 這個頁面**不套後台外殼**(AppLayout):沒有後台品牌列、沒有底部分頁籤、沒有下拉刷新。

import type { ReactNode } from "react";
import { ChevronLeft, Phone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { STEP5_NAME_LOGIN, stepLabels, TOTAL_STEPS, type ContactLinks } from "./publicBookingLogic";

export function PublicShell({
  header,
  footer,
  children,
  className,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div data-testid="public-booking" className="flex min-h-dvh min-w-0 flex-col bg-surface">
      {header ? (
        <header className="sticky top-0 z-30 border-b border-border bg-background">
          <div className="mx-auto w-full max-w-3xl">{header}</div>
        </header>
      ) : null}
      <main className={cn("mx-auto w-full min-w-0 max-w-3xl flex-1 px-3 py-3 sm:px-4", className)}>
        {children}
      </main>
      {footer ? (
        <footer className="sticky bottom-0 z-30 border-t border-border bg-background">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-3 pt-2.5 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-4">
            {footer}
          </div>
        </footer>
      ) : null}
    </div>
  );
}

/** 只有標題的頁首(① 店家首頁、找不到 / 暫停頁)。 */
export function TitleOnlyHeader({ title }: { title: string }) {
  return (
    <div className="flex h-[54px] items-center justify-center px-14">
      <h1 className="truncate text-base font-bold text-foreground">{title}</h1>
    </div>
  );
}

/**
 * C2 ⑥ 系列(登入會員 / 完成會員資料 / 不登入預約)的頁首:返回箭頭(可省略)+ 置中標題 + 右側動作(登出)。
 * 沒有步驟進度條(⑥ 已經不是 ②~⑤ 的四步驟,同預覽圖)。
 */
export function SimpleHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: (() => void) | undefined;
  right?: ReactNode;
}) {
  return (
    <div className="relative flex h-[54px] items-center justify-between px-2 sm:px-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="回上一步"
          className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-foreground">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </span>
        </button>
      ) : (
        <span className="h-11 w-11 shrink-0" aria-hidden="true" />
      )}
      <h1 className="pointer-events-none absolute inset-x-[72px] truncate text-center text-base font-bold text-foreground">
        {title}
      </h1>
      <div className="flex min-w-11 shrink-0 justify-end">{right}</div>
    </div>
  );
}

/**
 * ②~⑥ 的頁首:返回箭頭(可省略)+ 標題 + 右側動作(登出,可省略)
 * +「步驟 x／5(全形空白)這步名稱 / 下一步：⋯」+ 五段進度條。
 * @param stepNumber 1~5(5 = ⑥-1 / ⑥-2 / ⑥-4 / 確認送出)
 * @param lastStepName 第 5 步的名稱(step5Name)。
 */
export function StepHeader({
  stepNumber,
  title,
  onBack,
  right,
  lastStepName = STEP5_NAME_LOGIN,
  children,
}: {
  stepNumber: 1 | 2 | 3 | 4 | 5;
  title: string;
  onBack?: (() => void) | undefined;
  right?: ReactNode;
  lastStepName?: string;
  /** 標題下方的額外內容(② 的分類頁籤)。 */
  children?: ReactNode;
}) {
  const { current, next } = stepLabels(stepNumber, lastStepName);
  return (
    <>
      <div className="relative flex h-[54px] items-center justify-between px-2 sm:px-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="回上一步"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-foreground">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </span>
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" aria-hidden="true" />
        )}
        <h1 className="pointer-events-none absolute inset-x-[72px] truncate text-center text-base font-bold text-foreground">
          {title}
        </h1>
        <div className="flex min-w-11 shrink-0 justify-end">{right}</div>
      </div>
      <div
        className="flex justify-between gap-3 px-4 pb-2 text-xs text-muted-foreground"
        data-testid="public-booking-step-label"
      >
        <span>{current}</span>
        <span>{next}</span>
      </div>
      <div className="flex gap-1.5 px-4 pb-2.5" aria-hidden="true">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className={cn("h-1 flex-1 rounded-full", n <= stepNumber ? "bg-brand" : "bg-border")}
          />
        ))}
      </div>
      {children}
    </>
  );
}

export function LineIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5 1.1-.5 5.9-3.5 8-6C21.3 14.2 22 12.7 22 11c0-4.4-4.5-8-10-8Z"
      />
    </svg>
  );
}

/**
 * C1-A04 聯絡按鈕:有 LINE 好友連結 ⇒「LINE 聯絡店家」(另開新分頁,noopener noreferrer);
 * 有電話 ⇒「撥打電話」(tel:)。兩個都沒有 ⇒ 整列不顯示(回傳 null)。
 * 🔴 LINE 綠是 LINE 的品牌色(客人認得的那顆綠色按鈕),不是我們的主題色,所以這裡刻意寫死。
 */
export function ContactButtons({
  links,
  className,
}: {
  links: ContactLinks;
  className?: string | undefined;
}) {
  if (!links.lineUrl && !links.telHref) return null;
  return (
    <div className={cn("flex gap-2", className)} data-testid="public-booking-contacts">
      {links.lineUrl ? (
        <Button
          asChild
          size="card"
          className="h-11 flex-1 border border-transparent bg-[#06C755] font-semibold text-white shadow-sm hover:bg-[#06C755]/90"
        >
          <a href={links.lineUrl} target="_blank" rel="noopener noreferrer">
            <LineIcon className="mr-1.5 h-[18px] w-[18px]" />
            LINE 聯絡店家
          </a>
        </Button>
      ) : null}
      {links.telHref ? (
        <Button asChild variant="neutral" size="card" className="h-11 flex-1">
          <a href={links.telHref}>
            <Phone className="mr-1.5 h-4 w-4" aria-hidden="true" />
            撥打電話
          </a>
        </Button>
      ) : null}
    </div>
  );
}
