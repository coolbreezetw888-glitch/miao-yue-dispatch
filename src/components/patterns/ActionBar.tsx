/**
 * 底部動作列:同一列的按鈕一律等寬 —— ui-overlay-patterns skill 二之三「底部動作列:三顆等寬」。
 *
 * 🔴 2026-09-29 使用者裁決:同一列的按鈕一律等寬(flex: 1 1 0)、間距一致,階層靠**顏色**區分
 * (紅框 / 白底 / 實心),不靠大小和距離。使用者原話:「應該一樣大小就可以了,這樣分反而更奇怪」——
 * 這條推翻了原本的「危險靠最左、主要靠最右、中間拉開」,**不要改回去**,也不要因為覺得等寬不合設計慣例就改掉。
 *
 * 直接子元素都會被拉成等寬。用 Radix Trigger asChild 包的按鈕也算直接子元素(Trigger 本身不產生 DOM)。
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export function ActionBar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center gap-2 [&>*]:min-w-0 [&>*]:flex-1", className)}
      {...props}
    />
  );
}
