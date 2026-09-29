import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        cta: "bg-cta text-cta-foreground shadow-sm shadow-cta/25 hover:bg-cta/90",
        brand: "bg-brand text-brand-foreground shadow-sm hover:bg-brand/90",
        brandSoft: "bg-brand-soft text-accent-foreground hover:bg-brand-soft/70",

        // ─────────────────────────────────────────────────────────────────
        // ui-overlay-patterns skill 二之三「按鈕的四種階層」(2026-09-29 方案 D)。
        // 全站新畫面 / 改版畫面一律用這四個,不要再用上面的 default / outline / destructive。
        // 這裡改動會影響全站,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
        //   ① primary  實心、主題色、白字 —— 一個畫面只能有一顆
        //   ② neutral  白底、灰框、深字 —— 常用但不是主角,可以很多顆
        //   ③ danger   白底、紅字、淡紅框 —— 🔴 危險動作不做實心紅(實心紅會讓最危險的變成最好按的)
        //   ④ text     無底無框、主題色字 —— 很次要的動作
        // 顏色吃 --brand(商家主題色會覆寫它),不用 --primary(主題色不會覆寫 --primary)。
        // ─────────────────────────────────────────────────────────────────
        primary: "bg-brand text-brand-foreground font-semibold shadow-sm hover:bg-brand/90",
        neutral: "border border-input bg-background text-foreground shadow-sm hover:bg-accent",
        danger:
          "border border-destructive/40 bg-background text-destructive shadow-sm hover:bg-destructive-soft",
        text: "text-brand hover:bg-brand-soft/60",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-11 rounded-lg px-8 text-base",
        xl: "h-13 rounded-xl px-9 text-base font-semibold",
        icon: "h-9 w-9",
        // ui-overlay-patterns 二之三:標準 44px / 圓角 12px;卡片內 36px / 圓角 10px。
        // (rounded-lg = var(--radius) = 12px,rounded-md = 10px,見 styles.css 的 --radius 階梯。)
        touch: "h-11 rounded-lg px-5 text-[15px]",
        card: "h-9 rounded-md px-4 text-sm",
        cardIcon: "h-9 w-9 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
