import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",

        // ─────────────────────────────────────────────────────────────────
        // ui-overlay-patterns skill 二之四「標籤:狀態 / 屬性 / 待辦 三種要分開」(2026-09-29)。
        // 這裡改動會影響全站,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
        // 🔴 不用實心色塊(一整頁排下來很吵);🔴 顏色不能是唯一差別(每個標籤都要有文字)。
        //   狀態:圓角膠囊、淺底 + 深字 + 左邊小圓點(圓點由 patterns/Tags.tsx 的 StatusTag 加上)
        //     正常 = 綠系 / 要處理 = 黃系 / 結束或停用 = 灰系 / 出事 = 紅系
        //   屬性:方角、灰底、安靜
        //   待辦:黃底 + `!` 圖示(圖示由 TodoTag 加上)
        // 一般畫面請直接用 patterns/Tags.tsx 的 StatusTag / AttributeTag / TodoTag,不要自己組。
        // ─────────────────────────────────────────────────────────────────
        statusSuccess: "rounded-full border-transparent bg-success-soft text-success-strong",
        statusWarning: "rounded-full border-transparent bg-warn-soft text-warn-strong",
        statusNeutral: "rounded-full border-transparent bg-muted text-muted-foreground",
        statusDanger: "rounded-full border-transparent bg-destructive-soft text-destructive-strong",
        attribute: "rounded-sm border-transparent bg-muted font-medium text-muted-foreground",
        // SPECS-INDEX #861(2026-09-30 使用者實機巡檢):服務人員端「主要服務人員 / 協助」兩顆
        // 標籤原本都是同一個灰底 attribute,看起來一模一樣,分不出自己這一單是主手還是副手。
        // 這是**屬性**不是狀態,所以維持方角(不做圓角膠囊,免得跟旁邊的訂單狀態膠囊混淆),
        // 只把「重要的那一個」換成主題色淺底 + 主題色字 + 淡框:跟灰底那顆一眼分得開,
        // 又不是實心色塊(skill 二之四「🔴 不用實心色塊」)。
        // 🔴 顏色不是唯一差別 —— 兩顆都有完整文字(「主要服務人員」/「協助」)。
        attributeStrong: "rounded-sm border-brand/40 bg-brand-soft font-semibold text-brand",
        todo: "rounded-md border-warn/40 bg-warn-soft text-warn-strong",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
