/**
 * 小卡窗殼(AlertDialog 版,純確認用)—— ui-overlay-patterns skill 三、兩種窗 → 小卡窗。
 *
 * 跟 CardDialog.tsx 同一套外觀規格(置中 / 16px 圓角 / 手機留 16px / 電腦 400px / 高度隨內容),
 * 差別只在底層是 Radix AlertDialog:點遮罩、按 Esc 不會關,一定要按按鈕,適合「刪除 / 取消預約 /
 * 解除串接」這類要使用者明確二選一的確認。有輸入欄位的短表單請用 CardDialog。
 *
 * 按鈕階層(skill 二之三):
 *   - CardAlertDialogCancel  → ② 次要(白底灰框)
 *   - CardAlertDialogAction tone="primary"(預設)→ ① 主要(實心主題色)
 *   - CardAlertDialogAction tone="danger" → ③ 危險(白底紅字淡紅框)。🔴 危險動作不做實心紅。
 *   兩顆在手機上左右各半,電腦靠右(CARD_FOOTER_CLASS)。
 *
 * 用法(跟 shadcn AlertDialog 一模一樣,只是把 AlertDialog* 換成 CardAlertDialog*):
 *   <CardAlertDialog>
 *     <CardAlertDialogTrigger asChild><Button variant="neutral" size="card">刪除</Button></CardAlertDialogTrigger>
 *     <CardAlertDialogContent>
 *       <CardAlertDialogHeader>
 *         <CardAlertDialogTitle>確定要刪除「{name}」嗎?</CardAlertDialogTitle>
 *         <CardAlertDialogDescription>刪除後……</CardAlertDialogDescription>
 *       </CardAlertDialogHeader>
 *       <CardAlertDialogFooter>
 *         <CardAlertDialogCancel>取消</CardAlertDialogCancel>
 *         <CardAlertDialogAction tone="danger" onClick={...}>確定刪除</CardAlertDialogAction>
 *       </CardAlertDialogFooter>
 *     </CardAlertDialogContent>
 *   </CardAlertDialog>
 *
 * ⚠️ 這裡改動會影響全站所有確認窗,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  CARD_CONTENT_CLASS,
  CARD_DESCRIPTION_CLASS,
  CARD_FOOTER_CLASS,
  CARD_HEADER_CLASS,
  CARD_TITLE_CLASS,
  OVERLAY_CLASS,
} from "./overlayClasses";

const CardAlertDialog = AlertDialogPrimitive.Root;
const CardAlertDialogTrigger = AlertDialogPrimitive.Trigger;

const CardAlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  Omit<React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>, "className">
>((props, ref) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay className={OVERLAY_CLASS} />
    <AlertDialogPrimitive.Content ref={ref} className={CARD_CONTENT_CLASS} {...props} />
  </AlertDialogPrimitive.Portal>
));
CardAlertDialogContent.displayName = "CardAlertDialogContent";

const CardAlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  // AlertDialog 沒有 ✕,所以不需要 CardDialogHeader 的右側預留空間(pr-8)。
  <div className={cn(CARD_HEADER_CLASS, "pr-0", className)} {...props} />
);
CardAlertDialogHeader.displayName = "CardAlertDialogHeader";

const CardAlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(CARD_FOOTER_CLASS, className)} {...props} />
);
CardAlertDialogFooter.displayName = "CardAlertDialogFooter";

const CardAlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn(CARD_TITLE_CLASS, className)} {...props} />
));
CardAlertDialogTitle.displayName = "CardAlertDialogTitle";

const CardAlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn(CARD_DESCRIPTION_CLASS, className)}
    {...props}
  />
));
CardAlertDialogDescription.displayName = "CardAlertDialogDescription";

interface CardAlertDialogActionProps extends React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Action
> {
  /** primary = 實心主題色(預設);danger = 白底紅字淡紅框(刪除、取消預約等不可逆動作)。 */
  tone?: "primary" | "danger" | undefined;
}

const CardAlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  CardAlertDialogActionProps
>(({ className, tone = "primary", ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(buttonVariants({ variant: tone, size: "touch" }), className)}
    {...props}
  />
));
CardAlertDialogAction.displayName = "CardAlertDialogAction";

const CardAlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: "neutral", size: "touch" }), className)}
    {...props}
  />
));
CardAlertDialogCancel.displayName = "CardAlertDialogCancel";

export {
  CardAlertDialog,
  CardAlertDialogTrigger,
  CardAlertDialogContent,
  CardAlertDialogHeader,
  CardAlertDialogFooter,
  CardAlertDialogTitle,
  CardAlertDialogDescription,
  CardAlertDialogAction,
  CardAlertDialogCancel,
};
