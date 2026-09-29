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
 *      🔴 會跳到別的網址的用 `to`(真正的 <a href>,可以中鍵開新分頁),原地做事的才用 `onClick`。
 *
 * 🔴 電話與地址做成可點擊(DetailPhoneRow / DetailAddressRow):tel: 直接撥號、開地圖導航;
 *    **各佔一行,不要並排**,地址那行要能折行。
 * 🔴 兩種備註要分開:CustomerNote 黃底黃框(客人交代的事,服務人員到現場一定要看到);
 *    InternalNote 灰底 + 🔒 標記「客戶看不到,服務人員看得到」(2026-09-29 使用者確認服務人員端看得到內部備註,
 *    不講清楚商家會把不該給服務人員知道的事寫進去)。
 */

import * as React from "react";
import { ChevronRight, Lock, MapPin, Phone } from "lucide-react";
import { Link } from "react-router-dom";

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
  // 🔴 QA D1(2026-09-29)兩側都可能是商家自己填的動態文字(標籤 = 「服務項目名稱 × 數量」,
  // 值 = 客戶姓名 / 會員姓名),所以不能任何一側 shrink-0、另一側 min-w-0 —— 那只是把「誰被壓成 0 寬」
  // 換一邊。這裡的規則:
  //   值:flex 預設(basis = 內容寬、不主動搶空間),用 max-w-[70%] 封頂。因為沒有 min-w-0,
  //       flex 的自動最小寬度 = 內容寬(再被 max-w 夾住),所以「$1,000」「11:00 – 12:00」這種
  //       數字永遠拿得到自己的完整寬度,不會被擠成一個字一行直排;超過 70% 的長文字(姓名、
  //       email)才在 70% 內折行。
  //   標籤:flex-1(basis 0)只拿值剩下的空間,所以永遠 ≥ 30% − gap、永遠不會是 0;長名稱在
  //       這個空間內折行,min-w-0 + break-words 是給沒有斷行點的英文 / email 用的。
  // 320px 實測(22 字項目名 × 26px 金額)見 commit 訊息。
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <span
        className={cn(
          "min-w-0 flex-1 break-words text-[13px]",
          size === "xl" ? "text-sm font-bold text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className={cn("max-w-[70%] break-words text-right tabular-nums", VALUE_CLASS[size])}>
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

interface DetailLinkRowBaseProps {
  label: React.ReactNode;
  /** 右側的次要文字,例如「2 筆」。 */
  extra?: React.ReactNode | undefined;
  disabled?: boolean | undefined;
}

/** 純動作:按了在原地做事(展開子面板、打開另一個彈窗),不會離開目前的網址。 */
interface DetailLinkRowActionProps extends DetailLinkRowBaseProps {
  onClick: () => void;
  to?: undefined;
}

/** 跳頁:底層是真正的 <Link>(渲染成 <a href>),可以中鍵 / 右鍵「在新分頁開啟」。 */
interface DetailLinkRowLinkProps extends DetailLinkRowBaseProps {
  to: string;
  onClick?: undefined;
}

/**
 * 🔴 **跳頁用 `to`、純動作用 `onClick`,不要用 `onClick` + `navigate()`。**
 *
 * `to` 會渲染成真正的 `<a href>`,使用者才能中鍵 / 右鍵「在新分頁開啟」——
 * 每天要開很多筆的人(客服核對訂單、看會員推薦名單)就是靠這個。`onClick` + `navigate()`
 * 外觀一模一樣,但那是一顆 `<button>`,中鍵點下去什麼都不會發生,而且使用者不會來回報,
 * 他只會覺得「這個系統很難用」。這是第 1 批就定案的裁決,ListCard 的選單項目(`to`)
 * 走的是同一條規則。
 *
 * `disabled` 對兩種都有效:給 `to` 時會退化成不可點的一列(`<a>` 沒有 disabled 屬性,
 * 所以不渲染 `<a>`,改渲染一個 `aria-disabled` 的 div,避免鍵盤還能 Tab 進去按下去)。
 */
export type DetailLinkRowProps = DetailLinkRowActionProps | DetailLinkRowLinkProps;

// h-12 改 min-h-12:label 現在可能夾著狀態標籤等會折行的內容(例:會員詳情的推薦名單),
// 固定高度會讓折到第二行的內容直接溢出到隔壁列上面。單行時的視覺高度完全沒變。
const LINK_ROW_CLASS =
  "flex min-h-12 w-full cursor-pointer items-center gap-2.5 px-1 py-1.5 text-left text-sm text-foreground no-underline transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50";

export function DetailLinkRow({ label, extra, onClick, to, disabled }: DetailLinkRowProps) {
  const inner = (
    <>
      {/* label 可能是「名稱 + 好幾顆標籤」,320px 要能折行(flex-wrap),不是被截斷。 */}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{label}</span>
      {extra ? <span className="shrink-0 text-xs text-muted-foreground">{extra}</span> : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  );

  if (to !== undefined) {
    if (disabled) {
      return (
        <div aria-disabled="true" className={cn(LINK_ROW_CLASS, "cursor-not-allowed opacity-50")}>
          {inner}
        </div>
      );
    }
    return (
      <Link to={to} className={LINK_ROW_CLASS}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled ?? false} className={LINK_ROW_CLASS}>
      {inner}
    </button>
  );
}
