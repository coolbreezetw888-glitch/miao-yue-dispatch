/**
 * 明細列(治單調感)—— ui-overlay-patterns skill 二之六。
 *
 * 單調的根因:每行同字級同高度同間距 + 沒有分組 + 分隔線太淡 ⇒ 眼睛找不到落腳點。這組元件把
 * skill 列的六件事寫死:
 *   1. DetailSection  分組 + 組間留白,每組上面一行 11px 大寫字距的小標(人員 / 金額 / 客戶 / 備註)
 *   2. DetailSection tone="amount"  金額整組用色塊包起來(淺色底 + 細框),一眼看到錢在哪
 *   3. DetailRow size="lg" / "xl"  最重要的一兩個值放大(預約時間 18px、最終金額 26px)
 *   4. 標籤縮小變淡(13px 灰)、值變粗 —— 值才是主角
 *   5. 數字一律 tabular-nums
 *   6. DetailLinkRow  「去別的地方看」做成可點的列 + ›,不是整條寬的按鈕(相關訂單、操作記錄)
 *
 * 🔴 電話與地址做成可點擊(DetailPhoneRow / DetailAddressRow):tel: 直接撥號、開地圖導航;
 *    **各佔一行,不要並排**,地址那行要能折行。
 * 🔴 兩種備註要分開:CustomerNote 黃底黃框(客人交代的事,服務人員到現場一定要看到);
 *    InternalNote 灰底 + 🔒 標記「客戶看不到,服務人員看得到」(2026-09-29 使用者確認服務人員端看得到內部備註,
 *    不講清楚商家會把不該給服務人員知道的事寫進去)。
 */

import * as React from "react";
import { ChevronRight, Lock, MapPin, Phone } from "lucide-react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 分組
// ---------------------------------------------------------------------------

interface DetailSectionProps {
  /** 組標題(人員 / 金額 / 客戶 / 備註)。不給就沒有小標,只有分組間距。 */
  label?: React.ReactNode | undefined;
  /** amount = 金額組:淺色底 + 細框的色塊。 */
  tone?: "plain" | "amount" | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

export function DetailSection({ label, tone = "plain", className, children }: DetailSectionProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2",
        tone === "amount" && "rounded-lg border border-brand/20 bg-brand-soft/50 px-3.5 py-3",
        className,
      )}
    >
      {label ? (
        <h3
          className={cn(
            "text-[11px] font-bold uppercase tracking-[0.1em]",
            tone === "amount" ? "text-brand/80" : "text-muted-foreground",
          )}
        >
          {label}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

export function DetailDivider({ className }: { className?: string | undefined }) {
  return <div role="separator" className={cn("h-px w-full bg-border", className)} />;
}

// ---------------------------------------------------------------------------
// 一列:左邊淡標籤、右邊粗值
// ---------------------------------------------------------------------------

interface DetailRowProps {
  label: React.ReactNode;
  /** sm = 次要資訊(小計、付款方式,值也變淡)/ md = 一般(預設)/ lg = 18px(預約時間)/ xl = 26px 主題色(最終金額)。 */
  size?: "sm" | "md" | "lg" | "xl" | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

const VALUE_CLASS: Record<NonNullable<DetailRowProps["size"]>, string> = {
  sm: "text-[13px] font-normal text-muted-foreground",
  md: "text-sm font-semibold text-foreground",
  lg: "text-lg font-bold text-foreground",
  xl: "text-[26px] font-bold leading-none text-brand",
};

export function DetailRow({ label, size = "md", className, children }: DetailRowProps) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <span
        className={cn(
          "shrink-0 text-[13px]",
          size === "xl" ? "text-sm font-bold text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className={cn("min-w-0 break-words text-right tabular-nums", VALUE_CLASS[size])}>
        {children}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 可點擊的電話 / 地址(各佔一行)
// ---------------------------------------------------------------------------

const CONTACT_ROW_CLASS =
  "flex min-h-11 w-full items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-left text-foreground no-underline transition-colors hover:border-brand hover:bg-brand-soft/40";

export function DetailPhoneRow({
  phone,
  className,
}: {
  phone: string;
  className?: string | undefined;
}) {
  const href = `tel:${phone.replace(/[^\d+]/g, "")}`;
  return (
    <a href={href} className={cn(CONTACT_ROW_CLASS, className)}>
      <Phone className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[15px] tabular-nums">{phone}</span>
      <span className="shrink-0 text-xs font-semibold text-brand">撥號</span>
    </a>
  );
}

/** 開 Google Maps 搜尋該地址(手機會轉交給地圖 App)。用 search API 而不是 geo: 是因為桌機也能開。 */
export function mapsHrefForAddress(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function DetailAddressRow({
  address,
  className,
}: {
  address: string;
  className?: string | undefined;
}) {
  return (
    <a
      href={mapsHrefForAddress(address)}
      target="_blank"
      rel="noopener noreferrer"
      // 地址很長,要能折行:align-items: flex-start(skill 二之六)。
      className={cn(CONTACT_ROW_CLASS, "items-start py-2.5", className)}
    >
      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words text-[15px] leading-snug">{address}</span>
      <span className="mt-0.5 shrink-0 text-xs font-semibold text-brand">導航</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// 兩種備註
// ---------------------------------------------------------------------------

export function CustomerNote({
  className,
  children,
}: {
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-md border border-warn/50 bg-warn-soft px-3.5 py-3", className)}>
      <p className="mb-1 text-[11px] font-bold text-warn-strong">客戶備註</p>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
        {children}
      </p>
    </div>
  );
}

export function InternalNote({
  className,
  children,
}: {
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-md border border-border bg-muted/60 px-3.5 py-3", className)}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <p className="text-[11px] font-bold text-muted-foreground">內部備註</p>
        <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
          <Lock className="h-2.5 w-2.5" aria-hidden="true" />
          客戶看不到,服務人員看得到
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 「去別的地方看」的可點列 + ›
// ---------------------------------------------------------------------------

/** 一組 DetailLinkRow 的容器:上緣一條線、列與列之間細線。 */
export function DetailLinkRows({
  className,
  children,
}: {
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("divide-y divide-border border-t border-border", className)}>{children}</div>
  );
}

interface DetailLinkRowProps {
  label: React.ReactNode;
  /** 右側的次要文字,例如「2 筆」。 */
  extra?: React.ReactNode | undefined;
  onClick: () => void;
  disabled?: boolean | undefined;
}

export function DetailLinkRow({ label, extra, onClick, disabled }: DetailLinkRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled ?? false}
      className="flex h-12 w-full cursor-pointer items-center gap-2.5 px-1 text-left text-sm text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">{label}</span>
      {extra ? <span className="shrink-0 text-xs text-muted-foreground">{extra}</span> : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
