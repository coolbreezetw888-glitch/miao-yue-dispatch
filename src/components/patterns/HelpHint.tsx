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
