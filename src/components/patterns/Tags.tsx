/**
 * 標籤三類:狀態 / 屬性 / 待辦 —— ui-overlay-patterns skill 二之四。
 *
 * 底層是 shadcn Badge 的新 variant(見 components/ui/badge.tsx 的說明區塊),這裡只負責把
 * 「狀態要有左邊小圓點」「待辦要有 ! 圖示」這兩個結構加上去,讓頁面不用自己組。
 *
 *   StatusTag    一個人 / 一張單同一時間只會有一個。圓角膠囊、淺底 + 深字 + 左邊小圓點。
 *                tone:success = 正常(已上架、已確認)/ warning = 要處理(待確認、派單中)/
 *                      neutral = 結束或停用(已完成、未上架)/ danger = 出事(已移除、已取消)
 *   AttributeTag 靜態分類(抽成制、月薪制)。方角、灰底、安靜。
 *   TodoTag      要你去處理(尚未開通登入)。黃底 + `!`。
 *
 * 🔴 顏色不能是唯一的差別(色盲看不出紅綠)—— 每個標籤都要有文字,這裡的圓點只是輔助。
 * 🔴 不用實心色塊。**唯一例外:StatusTag 的 `fillColor`**(2026-09-30 使用者裁決,
 *    SPECS-INDEX #832)—— 顏色是商家自己挑的那一種情境,淺底膠囊會跟卡片底色撞色整個消失
 *    (預設的「待確認」#ebaa2d 撞上黃卡就是這樣),所以改成實心填滿商家的色 + **一律白字**。
 *    詳見 fillColor 那個 prop 的說明。其他標籤維持「不用實心色塊」。
 *
 * `wrap`:標籤預設一行不折(whitespace-nowrap),因為短標籤折行會很醜。但標籤裡夾著使用者自填的
 * 文字(登入信箱、客戶名)時,320px 會撐爆卡片 ⇒ 給 `wrap` 讓它能在任意字元折行(email 沒有空白
 * 可以斷,所以是 break-all),圓點 / `!` 圖示改對齊第一行。頁面不要自己用 className 覆寫 whitespace。
 *
 * ⚠️ 這裡改動會影響全站所有標籤,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { solidFillStyle } from "@/lib/statusPillStyle";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "neutral" | "danger";

const STATUS_VARIANT: Record<StatusTone, NonNullable<BadgeProps["variant"]>> = {
  success: "statusSuccess",
  warning: "statusWarning",
  neutral: "statusNeutral",
  danger: "statusDanger",
};

const STATUS_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warn",
  neutral: "bg-muted-foreground/60",
  danger: "bg-destructive",
};

interface WrapProps {
  /** 標籤內含使用者自填的長文字(email、姓名)時開啟,允許折行、不撐爆 320px。預設 false。 */
  wrap?: boolean | undefined;
}

/** 依 wrap 決定「一行不折」還是「任意字元可折 + 靠左」。 */
function wrapClass(wrap: boolean | undefined) {
  return wrap ? "whitespace-normal break-all text-left" : "whitespace-nowrap";
}

interface StatusTagProps extends Omit<BadgeProps, "variant">, WrapProps {
  tone: StatusTone;
  /**
   * 🔴 逃生門,只給「顏色是商家自己在設定裡挑的、build 時不知道是什麼色」的情境用。
   * 目前唯一的使用點:訂單管理 / 行事曆的訂單狀態膠囊(商家設定 > 訂單狀態顏色設定,
   * SPECS-INDEX #832)。**其他頁面的 StatusTag 不吃商家自訂色,不要為了統一而到處傳這個。**
   *
   * 給了之後這顆膠囊變成「實心填滿這個顏色」:
   *   - 🔴 文字顏色**一律白字**、底色原樣不動(2026-09-30 使用者實機巡檢後的裁決,原話
   *     「一律白字,顏色完全不動」;白字在亮綠/橘上只有 WCAG 標準值的 40%~65%,這個代價
   *     已經明確告知,使用者仍然選它)。**不要改回「依底色亮度自動挑黑或白」** ——
   *     那個做法當天早一批做過、被使用者當面推翻。完整理由見 lib/statusPillStyle.ts 檔頭。
   *   - 左邊那顆小圓點改成 bg-current(跟文字同色),否則圓點會用 tone 的固定色、
   *     在商家自訂的底色上有機率整個看不見(這次要修的就是這種「撞色就消失」)。
   *   - 邊框用**固定深色**的 25% 透明度(不是文字色的)——文字既然固定白色,邊框跟著文字走
   *     會在淺底色上變成「白底卡片 + 白邊 + 白字」整顆消失。
   *
   * 沒給的時候(全站其他所有使用點)渲染結果跟改版前完全一樣:淺底 + 深字 + tone 色圓點。
   *
   * 📌 做法跟 ListCard 的 `style` prop(第 2 批為了訂單卡片左側色條加的)同一個立場:
   *    動態顏色沒辦法寫成 Tailwind class(build 時就固定了),只能走 inline style;
   *    所以開一個**明確標示用途**的 opt-in 插槽,而不是放寬公版樣式。
   */
  fillColor?: string | undefined;
}

export function StatusTag({
  tone,
  wrap,
  fillColor,
  className,
  style,
  children,
  ...props
}: StatusTagProps) {
  const solid = fillColor ? solidFillStyle(fillColor) : undefined;
  return (
    <Badge
      variant={STATUS_VARIANT[tone]}
      className={cn("gap-1.5", wrapClass(wrap), wrap && "items-start", className)}
      style={solid ? { ...solid, ...style } : style}
      {...props}
    >
      {/* 折行時圓點對齊第一行(text-xs 行高 16px,圓點 6px ⇒ 往下推 5px)。 */}
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          solid ? "bg-current" : STATUS_DOT[tone],
          wrap && "mt-[5px]",
        )}
      />
      {children}
    </Badge>
  );
}

/** 屬性標籤的兩種強度。SPECS-INDEX #861。 */
export type AttributeTone = "muted" | "strong";

export function AttributeTag({
  tone = "muted",
  wrap,
  className,
  ...props
}: Omit<BadgeProps, "variant"> &
  WrapProps & {
    /**
     * muted(預設)= skill 二之四 的標準屬性標籤:方角、灰底、安靜。全站既有使用點都是這個,
     * 不傳就跟改版前完全一樣。
     *
     * strong = 同樣方角(還是屬性,不是狀態),但換成主題色淺底 + 主題色字 + 淡框。
     * 只用在「同一個位置會出現兩種互斥的屬性,而其中一種明顯比較重要、使用者必須一眼分出來」
     * 的情境 —— 目前唯一的使用點是服務人員端的「主要服務人員」vs「協助」
     * (SPECS-INDEX #861:兩顆原本都是灰底,服務人員分不出自己這一單是主手還是副手)。
     * ⚠️ 不要為了「讓標籤好看一點」到處傳 strong,一整頁都醒目等於沒有一個醒目。
     */
    tone?: AttributeTone | undefined;
  }) {
  return (
    <Badge
      variant={tone === "strong" ? "attributeStrong" : "attribute"}
      className={cn(wrapClass(wrap), className)}
      {...props}
    />
  );
}

export function TodoTag({
  wrap,
  className,
  children,
  ...props
}: Omit<BadgeProps, "variant"> & WrapProps) {
  return (
    <Badge
      variant="todo"
      className={cn("gap-1.5", wrapClass(wrap), wrap && "items-start", className)}
      {...props}
    >
      {/* 折行時 `!` 對齊第一行(text-xs 行高 16px,圖示 14px ⇒ 往下推 1px)。 */}
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-warn-strong text-[10px] font-bold leading-none text-warn-soft",
          wrap && "mt-px",
        )}
      >
        !
      </span>
      {children}
    </Badge>
  );
}

/**
 * 「即將推出」小灰標籤 —— SPECS-INDEX #977(2026-10-06)。
 *
 * 用在「設定可以先存,但對應的功能還沒正式上線」的欄位名稱旁邊(編輯服務人員 > 權限功能)。
 * 性質是**屬性**(靜態說明這個欄位的狀態),所以跟 AttributeTag 一樣方角、灰底、安靜(skill 二之四);
 * 刻意用 <span> 而不是 Badge(<div>):它常常放在 <label> 裡面,label 只能包行內元素。
 * 🔴 這個標籤只是標示,**不代表欄位被鎖住** —— 旁邊的開關 / 輸入框照常可以操作、照常存值。
 */
export function ComingSoonTag({ className }: { className?: string | undefined }) {
  return (
    <span
      data-testid="coming-soon-tag"
      className={cn(
        "ml-1.5 inline-flex shrink-0 items-center rounded-[4px] bg-muted px-1.5 py-px align-middle text-[11px] font-medium leading-4 text-muted-foreground",
        className,
      )}
    >
      即將推出
    </span>
  );
}
