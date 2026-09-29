/**
 * 列表卡片:一張卡片 = 一筆資料 —— ui-overlay-patterns skill 二之五(+ 二之三「一張卡片右邊只放
 * 一顆主要動作 + 一個 ⋯」)。
 *
 * 結構:`頭像/縮圖` → `名稱 + 狀態標籤 + 屬性標籤` → `次要資訊(email / 電話)` → 右側 `主要動作 + ⋯`
 *   - 手機直向堆疊、電腦橫向排開,欄位沒有增減(純 CSS 換行,不是兩份設計)。
 *   - 🔴 需要處理的卡片整張變黃(state="attention"),不只是加個標籤。
 *   - 已移除 / 停用的卡片整張變灰、名稱變淡(state="inactive")。
 *   - 右側永遠只有「一顆主要動作 + 一個 ⋯」,不常用和危險的都收進 ⋯,危險項紅字並放在分隔線下方。
 *     這樣不管卡片是什麼狀態,右邊永遠只有兩個東西,位置不會跳。主要動作可以隨狀態換字,但位置固定。
 *   - 🔴 列表一律卡片式,不做多欄表格(skill 一、核心原則)。
 *
 * 用法:
 *   <ListCard
 *     leading={<Avatar .../>}
 *     title="王小明"
 *     tags={<><StatusTag tone="success">已上架</StatusTag><AttributeTag>抽成制</AttributeTag></>}
 *     meta={<span>0912-345-678</span>}
 *     primaryAction={<Button variant="neutral" size="card">編輯</Button>}
 *     menuItems={[{ label: "修改登入信箱", onSelect: ... }, { label: "移除", danger: true, onSelect: ... }]}
 *   />
 */

import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ListCardMenuItem {
  label: React.ReactNode;
  onSelect: () => void;
  /** 危險項:紅字,自動排在分隔線下方(不管在陣列裡的順序)。 */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
}

export type ListCardState = "default" | "attention" | "inactive";

interface ListCardProps {
  /** 頭像 / 縮圖 / 首字圓圈。 */
  leading?: React.ReactNode | undefined;
  title: React.ReactNode;
  /** 狀態標籤 + 屬性標籤,放在名稱旁邊。 */
  tags?: React.ReactNode | undefined;
  /** 次要資訊(email / 電話 / 最後消費),放在名稱下方。 */
  meta?: React.ReactNode | undefined;
  /** 右側唯一的主要動作按鈕(建議 <Button size="card">)。 */
  primaryAction?: React.ReactNode | undefined;
  /** 右側 ⋯ 選單的項目;沒有就不顯示 ⋯。 */
  menuItems?: ListCardMenuItem[] | undefined;
  /** attention = 整張變黃(需要處理);inactive = 整張變灰、名稱變淡(已移除 / 停用)。 */
  state?: ListCardState | undefined;
  /** 整張卡可點(例如點進詳情)。有 onClick 時整張是 button,右側動作區會擋掉冒泡。 */
  onClick?: (() => void) | undefined;
  className?: string | undefined;
  children?: React.ReactNode | undefined;
}

const STATE_CLASS: Record<ListCardState, string> = {
  default: "border-border bg-card",
  attention: "border-warn/50 bg-warn-soft",
  inactive: "border-border bg-muted/50",
};

export function ListCard({
  leading,
  title,
  tags,
  meta,
  primaryAction,
  menuItems,
  state = "default",
  onClick,
  className,
  children,
}: ListCardProps) {
  const normalItems = (menuItems ?? []).filter((item) => !item.danger);
  const dangerItems = (menuItems ?? []).filter((item) => item.danger);
  const hasMenu = normalItems.length > 0 || dangerItems.length > 0;
  const hasActions = Boolean(primaryAction) || hasMenu;

  const body = (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "min-w-0 break-words text-base font-semibold",
              state === "inactive" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          {tags}
        </div>
        {meta ? (
          <div className="mt-0.5 break-words text-[13px] tabular-nums text-muted-foreground">
            {meta}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-3.5 transition-colors sm:flex-row sm:items-center sm:gap-4",
        STATE_CLASS[state],
        onClick && "cursor-pointer hover:border-brand",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {body}
      {hasActions ? (
        <div
          className="flex shrink-0 items-center justify-end gap-2"
          onClick={onClick ? (e) => e.stopPropagation() : undefined}
          onKeyDown={onClick ? (e) => e.stopPropagation() : undefined}
        >
          {primaryAction}
          {hasMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="neutral" size="cardIcon" aria-label="更多動作">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {normalItems.map((item, index) => (
                  <DropdownMenuItem
                    key={index}
                    disabled={item.disabled ?? false}
                    onSelect={() => item.onSelect()}
                    className="h-10 cursor-pointer"
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
                {normalItems.length > 0 && dangerItems.length > 0 ? (
                  <DropdownMenuSeparator />
                ) : null}
                {dangerItems.map((item, index) => (
                  <DropdownMenuItem
                    key={`danger-${index}`}
                    disabled={item.disabled ?? false}
                    onSelect={() => item.onSelect()}
                    className="h-10 cursor-pointer text-destructive focus:text-destructive"
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
