/**
 * 頁面骨架 + 空的 / 載入中 / 出錯 三種狀態 —— ui-overlay-patterns skill 二之八。
 *
 * PageHeader 骨架:`‹ 返回功能`(一行小字,不是按鈕)→ 標題 22px(手機 19px)→ 說明一到兩行 →
 *   主要動作靠右(手機改成整條寬放標題下面)。
 *
 * | 狀態 | 做法 |
 * |---|---|
 * | EmptyState 空的 | 圖示 + 一句「還沒有○○」+ 一句「做了之後能幹嘛」+ 🔴 一顆下一步按鈕。只寫「目前沒有資料」等於把人丟在那裡。唯一例外見 EmptyStateProps.action 的說明 |
 * | LoadingSkeleton 載入中 | 灰色骨架方塊,不要用「載入中⋯」四個字。骨架讓人覺得快,而且資料進來時版面不會跳 |
 * | ErrorState 出錯 | 講三件事:什麼壞了 / 可能原因 / 下一步,外加一句 🔴「你的資料沒有遺失」讓人安心 |
 */

import * as React from "react";
import { ChevronLeft, Inbox } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 頁首骨架
// ---------------------------------------------------------------------------

interface PageHeaderProps {
  /** 返回連結的目的地;沒有就不顯示返回列。 */
  backTo?: string | undefined;
  backLabel?: React.ReactNode | undefined;
  title: React.ReactNode;
  description?: React.ReactNode | undefined;
  /** 這一頁唯一的主要動作(<Button variant="primary" size="touch">)。 */
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

export function PageHeader({
  backTo,
  backLabel = "返回功能",
  title,
  description,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4", className)}>
      <div className="min-w-0 flex-1">
        {backTo ? (
          <Link
            to={backTo}
            className="mb-1.5 inline-flex min-h-6 items-center gap-0.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {backLabel}
          </Link>
        ) : null}
        <h1 className="text-[19px] font-bold leading-tight text-foreground sm:text-[22px]">
          {title}
        </h1>
        {description ? (
          // #947:用 <div> 不用 <p>。description 是 ReactNode,呼叫端可能放 StatusTag(底層 Badge 是 <div>),
          // 放在 <p> 裡會變成「<div> 在 <p> 裡」的 HTML 結構錯誤(React 主控台警告)。Tailwind preflight 已把
          // <p> 的預設外距歸零,<div> 跟 <p> 一樣是區塊元素 ⇒ 畫面完全不變。
          <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        // 手機整條寬(直接子元素拉滿),電腦靠右、按內容寬。
        <div className="flex shrink-0 [&>*]:w-full sm:[&>*]:w-auto">{action}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 空的
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  icon?: React.ReactNode | undefined;
  /** 「還沒有○○」 */
  title: React.ReactNode;
  /** 「做了之後能幹嘛」;沒有 action 時,這裡要順便指路(例:「用上方的邀請表單新增客服」)。 */
  description?: React.ReactNode | undefined;
  /**
   * 🔴 下一步按鈕。skill 二之八寫「空狀態一定要有一顆下一步按鈕」,那條的**精神**是「不要把人丟在那裡」。
   * 所以只有一種情況可以不給:**下一步就在同一個畫面上、而且一眼看得到**(例如客服名單的邀請表單
   * 就在空狀態正上方)——這時候硬做一顆「聚焦上方欄位」的按鈕反而脆弱又多餘,改在 description
   * 用一句話指路就夠了。**下一步不在這個畫面上(要開對話框、要跳頁)的,一律要給按鈕,不是漏做。**
   */
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center",
        className,
      )}
    >
      <span className="inline-flex size-[52px] items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon ?? <Inbox className="h-6 w-6" aria-hidden="true" />}
      </span>
      <div>
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ?? null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 載入中
// ---------------------------------------------------------------------------

interface LoadingSkeletonProps {
  /** cards = 列表卡片的骨架(頭像 + 兩行);lines = 明細列的骨架(左短右長)。 */
  variant?: "cards" | "lines" | undefined;
  rows?: number | undefined;
  className?: string | undefined;
}

export function LoadingSkeleton({ variant = "cards", rows = 3, className }: LoadingSkeletonProps) {
  const items = Array.from({ length: rows }, (_, i) => i);
  if (variant === "lines") {
    return (
      <div className={cn("flex flex-col gap-3", className)} aria-busy="true" aria-live="polite">
        {items.map((i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <Skeleton className="h-3.5 w-[30%] rounded-sm bg-muted" />
            <Skeleton className="h-3.5 w-[45%] rounded-sm bg-muted" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2.5", className)} aria-busy="true" aria-live="polite">
      {items.map((i) => (
        <div key={i} className="flex items-center gap-3.5 rounded-xl border border-border p-3.5">
          <Skeleton className="size-11 shrink-0 rounded-full bg-muted" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-[45%] rounded-sm bg-muted" />
            <Skeleton className="h-2.5 w-[65%] rounded-sm bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 出錯
// ---------------------------------------------------------------------------

interface ErrorStateProps {
  /** 什麼壞了:「讀不到服務人員名單」 */
  title: React.ReactNode;
  /** 可能原因:「可能是網路斷了」。「你的資料沒有遺失」這句由元件固定加上,不用自己寫。 */
  reason?: React.ReactNode | undefined;
  /** 下一步,通常是重試。 */
  onRetry?: (() => void) | undefined;
  retryLabel?: React.ReactNode | undefined;
  /** 要自訂下一步按鈕時用這個取代 onRetry。 */
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

export function ErrorState({
  title,
  reason,
  onRetry,
  retryLabel = "重試",
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive-soft/60 px-4 py-8 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-11 items-center justify-center rounded-full bg-destructive-soft text-xl font-bold text-destructive"
      >
        !
      </span>
      <div>
        <p className="text-[15px] font-semibold text-destructive-strong">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-destructive-strong/80">
          {reason ? <>{reason}。</> : null}你的資料沒有遺失。
        </p>
      </div>
      {action ??
        (onRetry ? (
          // 🔴 2026-09-30 QA + skill 二之三:「重試」是可逆的,**不給紅色**。紅色只留給不可逆的
          // (真正刪除)。出錯畫面上放一顆紅按鈕,使用者會以為按下去會把東西弄壞,反而不敢按。
          <Button type="button" variant="neutral" size="touch" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null)}
    </div>
  );
}
