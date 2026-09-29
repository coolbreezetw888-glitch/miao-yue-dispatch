/**
 * 底線式切換列 —— ui-overlay-patterns skill 二之四末段「篩選標籤列、分頁切換列:都用底線式」+ 二之八。
 *
 * 篩選標籤列(全部 / 未上架 / 已上架 / 已移除)跟分頁切換列(紅利計算 / 點數使用 / …)**共用同一個元件**——
 * 都是「切換要看哪一批」,沒有理由長得不一樣。
 *   - 選中的用主題色 + 2px 底線,不是灰底長條裡的白色方塊(那會被誤以為是按鈕)
 *   - 保留數量(「未上架 1」)
 *   - 手機放不下就整條橫向捲動,不要換行(換行會讓下面的內容整個往下跳)
 *   - 每個項目至少 44px 高(觸控目標)
 *
 * 底層是 Radix Tabs,所以本來就用 <Tabs>/<TabsContent> 的頁面只要把 TabsList / TabsTrigger 換成
 * UnderlineTabsList / UnderlineTabsTrigger;純篩選(沒有 TabsContent)的頁面一樣用 <Tabs value onValueChange>
 * 包起來就好。
 *
 *   <Tabs value={filter} onValueChange={setFilter}>
 *     <UnderlineTabsList>
 *       <UnderlineTabsTrigger value="all" count={3}>全部</UnderlineTabsTrigger>
 *       <UnderlineTabsTrigger value="inactive" count={1}>未上架</UnderlineTabsTrigger>
 *     </UnderlineTabsList>
 *   </Tabs>
 */

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

export const UnderlineTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // 整條橫向捲、不換行、藏捲軸;-mx/px 讓第一個項目的底線對齊內容左緣,又不會被容器裁掉。
      "flex w-full items-stretch gap-5 overflow-x-auto border-b border-border px-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      className,
    )}
    {...props}
  />
));
UnderlineTabsList.displayName = "UnderlineTabsList";

interface UnderlineTabsTriggerProps extends React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Trigger
> {
  /** 數量,顯示在文字後面(「未上架 1」)。 */
  count?: number | undefined;
}

export const UnderlineTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  UnderlineTabsTriggerProps
>(({ className, count, children, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "-mb-px inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
      "data-[state=active]:border-brand data-[state=active]:font-semibold data-[state=active]:text-brand",
      className,
    )}
    {...props}
  >
    {children}
    {count !== undefined ? (
      <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
    ) : null}
  </TabsPrimitive.Trigger>
));
UnderlineTabsTrigger.displayName = "UnderlineTabsTrigger";
