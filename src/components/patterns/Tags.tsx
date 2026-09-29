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
 * 🔴 不用實心色塊。
 *
 * `wrap`:標籤預設一行不折(whitespace-nowrap),因為短標籤折行會很醜。但標籤裡夾著使用者自填的
 * 文字(登入信箱、客戶名)時,320px 會撐爆卡片 ⇒ 給 `wrap` 讓它能在任意字元折行(email 沒有空白
 * 可以斷,所以是 break-all),圓點 / `!` 圖示改對齊第一行。頁面不要自己用 className 覆寫 whitespace。
 *
 * ⚠️ 這裡改動會影響全站所有標籤,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
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
}

export function StatusTag({ tone, wrap, className, children, ...props }: StatusTagProps) {
  return (
    <Badge
      variant={STATUS_VARIANT[tone]}
      className={cn("gap-1.5", wrapClass(wrap), wrap && "items-start", className)}
      {...props}
    >
      {/* 折行時圓點對齊第一行(text-xs 行高 16px,圓點 6px ⇒ 往下推 5px)。 */}
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone], wrap && "mt-[5px]")}
      />
      {children}
    </Badge>
  );
}

export function AttributeTag({
  wrap,
  className,
  ...props
}: Omit<BadgeProps, "variant"> & WrapProps) {
  return <Badge variant="attribute" className={cn(wrapClass(wrap), className)} {...props} />;
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
