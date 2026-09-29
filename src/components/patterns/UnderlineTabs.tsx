/**
 * 底線式切換列 —— ui-overlay-patterns skill 二之四「篩選標籤列、分頁切換列:都用底線式」+ 二之八。
 *
 * 篩選標籤列(全部 / 未上架 / 已上架 / 已移除)跟分頁切換列(紅利計算 / 點數使用 / …)**共用同一個元件**——
 * 都是「切換要看哪一批」,沒有理由長得不一樣。
 *   - 選中的用主題色 + 2px 底線,不是灰底長條裡的白色方塊(那會被誤以為是按鈕)
 *   - 保留數量(「未上架 1」)
 *   - 每個項目至少 44px 高(觸控目標)
 *
 * ## 🔴 `variant` 是必填:兩種列「放不下的時候」處理方式不一樣(2026-09-29 使用者裁決)
 *
 * | variant    | 用在哪                                   | 放不下怎麼辦                                              |
 * |------------|------------------------------------------|-----------------------------------------------------------|
 * | `"filter"` | 篩選列(全部 / 未上架 / 已上架 / 已移除) | 🔴 **必須一眼全部看到**:數量縮小變淡、間距縮小、容器太窄時整條字級降一級。**不橫向捲動、不換行、不截字** |
 * | `"pages"`  | 內容分頁列(紅利計算 / 點數使用 / …)    | 放不下就**整條橫向捲動**,不換行                            |
 *
 * 為什麼篩選列不能捲:**看不到的篩選等於不存在。** 使用者不會想到要去滑,只會以為系統沒有那個選項。
 * 第 1 批曾照「一律橫向捲動」做,結果 320px 下服務人員頁第四顆「已移除」要滑才看得到,使用者裁決改回
 * 「想辦法一眼看到」(舊程式的註解本來就寫「篩選器四個選項應一眼全部看到,不該左右滑」——那條是對的,
 * 不要再推翻)。內容分頁則是「進去看另一塊內容」,使用者有預期會有多個分頁、滑得到,所以可以捲;
 * 兩種都不換行,換行會讓下面的內容整個往下跳。
 *
 * ## `"filter"` 怎麼塞進 320px(手機最窄:320 − 頁面 px-5 − 卡片邊框 − CardHeader p-6 ≈ 230px 可用)
 *   - 數量用 11px、比標籤淡(不跟標籤同字級搶寬度);標籤與數量之間只留 2px
 *   - 項目之間 gap 由 20px 縮到 12px;容器寬 ≤ 280px 再縮到 10px
 *   - 容器寬 ≤ 280px 時整條字級 14px → 13px;≤ 220px(更窄的內嵌容器)再降到 12px
 *   - 用的是容器查詢(`@container`),不是 viewport 斷點——同一條列放進側欄、對話框也會自己判斷
 *   - 🔴 沒有 `truncate`(切掉的字跟看不到一樣糟)、沒有 `flex-wrap`、沒有 `overflow-x-auto`
 *   實測(2026-09-29,320px iframe):四顆三字標籤 + 兩位數數量在 13px 下總寬 226px,放得進 230px;
 *   一位數 204px。三個分類都破百人(三位數)才會多出約 8.4px 溢進卡片內距(QA 2026-09-29 於 320px 實測值)
 *   ——仍看得到,只是底線比較長。
 *
 * ## 🔴 `"filter"` 的隱性上限:320px 下**最多約 6 顆**,要放第 7 顆之前必須重新量
 *
 * 2026-09-30 QA 實測:`variant="filter"` 沒有 `overflow-x-auto`(刻意的,見上面),所以塞不進去的時候
 * **不是變成可以捲,而是把整頁撐出一條橫向捲軸**——整個頁面跟著能左右滑,比「篩選看不到」更糟。
 * 320px 下(可用寬約 230px)塞到 **7 顆就會撐出整頁橫向捲軸**;目前全站最多的一條是訂單管理的
 * `ORDER_STATUS_TABS`(5 顆,還剩約 34px 餘裕),安全。
 *
 * ⚠️ **要加第 7 顆篩選之前,先回 320px 真瀏覽器量一次**,不要照「反正它會自己縮字級」的印象加下去。
 * 真的塞不下時的處理順序是:① 縮短標籤文字 → ② 把數量藏到只有選中的那顆才顯示 → ③ 回頭問
 * 「這個篩選是不是可以跟別的合併」。🔴 **不可以改成橫向捲或換行**(skill 二之四:看不到的篩選等於不存在)。
 *
 * 底層是 Radix Tabs,所以本來就用 <Tabs>/<TabsContent> 的頁面只要把 TabsList / TabsTrigger 換成
 * UnderlineTabsList / UnderlineTabsTrigger;純篩選(沒有 TabsContent)的頁面一樣用 <Tabs value onValueChange>
 * 包起來就好。variant 只在 List 上設一次,Trigger 會透過 context 自己拿到。
 *
 *   <Tabs value={filter} onValueChange={setFilter}>
 *     <UnderlineTabsList variant="filter">
 *       <UnderlineTabsTrigger value="all" count={3}>全部</UnderlineTabsTrigger>
 *       <UnderlineTabsTrigger value="inactive" count={1}>未上架</UnderlineTabsTrigger>
 *     </UnderlineTabsList>
 *   </Tabs>
 *
 *   <Tabs defaultValue="calc">
 *     <UnderlineTabsList variant="pages">
 *       <UnderlineTabsTrigger value="calc">紅利計算</UnderlineTabsTrigger>
 *       <UnderlineTabsTrigger value="usage">點數使用</UnderlineTabsTrigger>
 *     </UnderlineTabsList>
 *     <TabsContent value="calc">…</TabsContent>
 *   </Tabs>
 */

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

/**
 * 兩種列的差別見檔頭表格。**沒有預設值**——每個呼叫端都要自己講清楚這是哪一種,
 * 免得之後有人順手用了「pages」在篩選列上,又把第四顆篩選藏到畫面外。
 */
export type UnderlineTabsVariant = "filter" | "pages";

const VariantContext = React.createContext<UnderlineTabsVariant>("filter");

interface UnderlineTabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /** `"filter"` = 篩選列,必須一眼全部看到;`"pages"` = 內容分頁列,放不下可以橫向捲。 */
  variant: UnderlineTabsVariant;
}

export const UnderlineTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  UnderlineTabsListProps
>(({ className, variant, ...props }, ref) => (
  <VariantContext.Provider value={variant}>
    {/* 外層多一個 div 當容器查詢的量測對象(@container):容器查詢只能問「祖先」有多寬,元素不能問自己,
        所以 @max-[…]/tabs 一定要寫在這個 div 的子孫(List 本身、Trigger)上才會生效。 */}
    <div className="@container/tabs w-full min-w-0">
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          // 共用:一整條、不換行、底部一條分隔線;px-0.5 讓第一個項目的底線對齊內容左緣,又不會被容器裁掉。
          "flex w-full items-stretch border-b border-border px-0.5",
          variant === "pages"
            ? // 內容分頁列:放不下整條橫向捲、藏捲軸。
              "gap-5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : // 篩選列:不捲、不換行、不截字。依「這條列實際有多寬」縮間距(Trigger 那邊再縮字級),
              // 不是看 viewport(放進側欄或對話框時 viewport 寬但容器窄,一樣要塞得進去)。
              "gap-3 @max-[280px]/tabs:gap-2.5",
          className,
        )}
        {...props}
      />
    </div>
  </VariantContext.Provider>
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
>(({ className, count, children, ...props }, ref) => {
  const variant = React.useContext(VariantContext);
  const isFilter = variant === "filter";
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        // shrink-0 + whitespace-nowrap:兩種列都不准把文字擠成兩行或截掉。
        "-mb-px inline-flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap border-b-2 border-transparent text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:border-brand data-[state=active]:font-semibold data-[state=active]:text-brand",
        isFilter
          ? // 篩選列:左右不留 padding、標籤與數量只隔 2px;容器 ≤ 280px 字級 14 → 13,≤ 220px 再到 12。
            "gap-0.5 px-0 text-sm @max-[280px]/tabs:text-[13px] @max-[220px]/tabs:text-xs"
          : "gap-1 px-0.5 text-sm",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "font-normal tabular-nums",
            // 篩選列的數量要比標籤小一截又淡一點,它是輔助資訊,不該跟標籤搶寬度。
            isFilter ? "text-[11px] text-muted-foreground/80" : "text-xs text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </TabsPrimitive.Trigger>
  );
});
UnderlineTabsTrigger.displayName = "UnderlineTabsTrigger";
