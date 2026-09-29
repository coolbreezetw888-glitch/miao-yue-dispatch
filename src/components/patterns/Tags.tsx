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

interface StatusTagProps extends Omit<BadgeProps, "variant"> {
  tone: StatusTone;
}

export function StatusTag({ tone, className, children, ...props }: StatusTagProps) {
  return (
    <Badge
      variant={STATUS_VARIANT[tone]}
      className={cn("gap-1.5 whitespace-nowrap", className)}
      {...props}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone])} />
      {children}
    </Badge>
  );
}

export function AttributeTag({ className, ...props }: Omit<BadgeProps, "variant">) {
  return <Badge variant="attribute" className={cn("whitespace-nowrap", className)} {...props} />;
}

export function TodoTag({ className, children, ...props }: Omit<BadgeProps, "variant">) {
  return (
    <Badge variant="todo" className={cn("gap-1.5 whitespace-nowrap", className)} {...props}>
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-warn-strong text-[10px] font-bold leading-none text-warn-soft"
      >
        !
      </span>
      {children}
    </Badge>
  );
}
