/**
 * 說明文字:`?` 收起來,`!` 一直顯示 —— ui-overlay-patterns skill 二。
 *
 * 🔵 HelpToggle(`?`):藍色 18px 小圓鈕,要點才展開。放「這是什麼、怎麼用」這類看過一次就懂的內容
 *    (欄位怎麼填、規則怎麼算、範例)。aria-label 要寫完整句子,例:「說明:點數兌換比例怎麼設定」。
 *    展開後是欄位下方的藍底說明區塊(HelpPanel)。
 *    ⚠️ 版面做法:按鈕跟展開的說明區塊是同一個 fragment,說明區塊 `basis-full` 會自己換到下一行,
 *       所以**父容器要是 `flex flex-wrap`**(FormField 的標籤列已經是)。
 *
 * 🟡 AlertNote(`!`):黃色、常駐、**不可收合**。三類絕對不能收進 `?`:
 *    1. 為什麼這顆按鈕按不了(#829「已手動調整「洗車」的單價,無法再套用自訂總金額」)
 *    2. 按下去會發生什麼不可逆的事(「關閉後系統不再自動給點數」)
 *    3. 現在的狀態跟使用者以為的不一樣(「功能已關閉,資料不會被清空」)
 *    理由:沒有人會為了問「為什麼這顆是灰的」去點一個問號 —— 他只會以為系統壞了。
 *    tone="danger" 給紅色版本(例如取消已完成訂單的連帶影響警告)。
 *
 * 顏色:`?` 用 info(固定藍)、`!` 用 warn(固定黃),都是語意色,不跟商家主題色跑(見 styles.css 說明)。
 */

import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface HelpToggleProps {
  /** aria-label,完整句子。 */
  label: string;
  className?: string | undefined;
  children: React.ReactNode;
}

export function HelpToggle({ label, className, children }: HelpToggleProps) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // 視覺 18px;用 before 撐出 32px 的點擊區,不佔版面。
          "relative inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full text-xs font-bold leading-none transition-colors before:absolute before:-inset-[7px] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "bg-info text-info-soft" : "bg-info-soft text-info-strong hover:bg-info/20",
          className,
        )}
      >
        ?
      </button>
      {open ? (
        <HelpPanel id={panelId} className="basis-full">
          {children}
        </HelpPanel>
      ) : null}
    </>
  );
}

/**
 * 🔵 HelpPopover(`?` 的小說明框版本)—— SPECS-INDEX #973(2026-10-06)。
 *
 * 跟 HelpToggle 的差別:HelpToggle 是「欄位下方展開一塊藍底區塊」,會把下面的內容往下推;
 * 這個是「點 `?` 跳出一個浮在畫面上的小說明框」,不推動版面。目前只用在 PageHeader 的
 * helpMode(功能頁卡片點進去的那些頁,H1 文字後面的 `?`)。
 *
 * 行為(使用者 2026-10-02 裁決 H-1):點 / 觸碰 `?` 打開;點框外任一處、按 Esc、或再點一次 `?` 關閉。
 * 底層用 Radix Popover(全站已在用),上面三種關法它都內建,而且會自己避開螢幕邊緣
 * (collisionPadding 16px = skill 三「手機左右留 16px 白邊」)。
 * 寬度 `min(20rem, 100vw − 32px)`:手機 320px 也不會超出畫面、不會造成橫向捲動;文字可換行。
 * 顏色沿用 HelpPanel 的 info 藍,跟欄位旁的 `?` 是同一套視覺語言。
 * #990 第 11 批:SwitchRow 的 popover 模式也用這顆(客服權限頁、服務人員權限開關)。同一頁會有很多顆,
 * 所以 data-testid 可以用 triggerTestId / popoverTestId 換掉(預設值不變,PageHeader 那顆照舊)。
 */
interface HelpPopoverProps {
  /** `?` 的 aria-label。 */
  label?: string | undefined;
  className?: string | undefined;
  /** `?` 按鈕的 data-testid,預設 `page-help-trigger`。 */
  triggerTestId?: string | undefined;
  /** 小說明框的 data-testid,預設 `page-help-popover`。 */
  popoverTestId?: string | undefined;
  children: React.ReactNode;
}

export function HelpPopover({
  label = "說明",
  className,
  triggerTestId = "page-help-trigger",
  popoverTestId = "page-help-popover",
  children,
}: HelpPopoverProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* 點擊區 32px(手機好按)、看得到的圓鈕 18px。
            跟 HelpToggle 不同,這裡**不用** `before:-inset-[7px]` 撐點擊區 —— 那個絕對定位的偽元素會讓按鈕的
            scrollWidth(25)> clientWidth(18),被 e2e 的 320px 溢出檢查(overflow-assert.ts)判成「內容比版位寬」。
            改成外層真的是 32px、上下用負 margin 抵掉多出來的高度(不影響標題行高);左右刻意不用負 margin ——
            標題很長折行時 `?` 會貼著容器右緣,負 margin 會讓它凸出容器 7px,反而造成溢出。 */}
        <button
          type="button"
          aria-label={label}
          data-testid={triggerTestId}
          className={cn(
            "group/help -my-[7px] inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-[18px] items-center justify-center rounded-full text-xs font-bold leading-none transition-colors",
              open
                ? "bg-info text-info-soft"
                : "bg-info-soft text-info-strong group-hover/help:bg-info/20",
            )}
          >
            ?
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        data-testid={popoverTestId}
        className="w-[min(20rem,calc(100vw-2rem))] whitespace-normal break-words rounded-md border-info/30 bg-info-soft px-3.5 py-3 text-[13px] leading-relaxed text-info-strong shadow-md [&_strong]:font-bold"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function HelpPanel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-md border border-info/30 bg-info-soft px-3.5 py-3 text-[13px] leading-relaxed text-info-strong [&_strong]:font-bold",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface AlertNoteProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "warning" | "danger" | undefined;
}

export function AlertNote({ tone = "warning", className, children, ...props }: AlertNoteProps) {
  const isDanger = tone === "danger";
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-relaxed",
        isDanger
          ? "border-destructive/40 bg-destructive-soft text-destructive-strong"
          : "border-warn/50 bg-warn-soft text-warn-strong",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none",
          isDanger ? "bg-destructive text-destructive-foreground" : "bg-warn-strong text-warn-soft",
        )}
      >
        !
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
