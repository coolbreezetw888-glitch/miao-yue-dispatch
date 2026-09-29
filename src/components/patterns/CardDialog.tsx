/**
 * 小卡窗殼(Dialog 版)—— ui-overlay-patterns skill 三、兩種窗 → 小卡窗。
 *
 * 用在:確認、3 欄以內的短表單(分類原則見 skill 三「📐 分類原則」與「使用者已裁決的個案」)。
 * 規格全部寫死在這個殼裡:置中 / 16px 圓角 / 手機左右留 16px / 電腦固定 400px / 高度隨內容 /
 * 按鈕手機左右各半、電腦靠右。**個別頁面不准再自己寫 max-w-* 或 className 調寬度** ——
 * 盤點報告指出「每個彈窗寬度各自手寫」正是目前大小不一的根因,所以 CardDialogContent 刻意不收 className。
 *
 * 純確認(沒有表單、要防止點外面誤關)請用 CardAlertDialog.tsx;有輸入欄位的短表單用這個。
 *
 * 用法(跟 shadcn Dialog 一模一樣,只是把 Dialog* 換成 CardDialog*):
 *   <CardDialog open={open} onOpenChange={setOpen}>
 *     <CardDialogTrigger asChild><Button variant="neutral" size="card">編輯</Button></CardDialogTrigger>
 *     <CardDialogContent>
 *       <CardDialogHeader>
 *         <CardDialogTitle>修改登入信箱</CardDialogTitle>
 *         <CardDialogDescription>...</CardDialogDescription>
 *       </CardDialogHeader>
 *       <FormField ...>...</FormField>
 *       <CardDialogFooter>
 *         <CardDialogClose asChild><Button variant="neutral" size="touch">取消</Button></CardDialogClose>
 *         <Button variant="primary" size="touch">儲存</Button>
 *       </CardDialogFooter>
 *     </CardDialogContent>
 *   </CardDialog>
 *
 * ⚠️ 這裡改動會影響全站所有小卡窗,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  CARD_CLOSE_CLASS,
  CARD_CONTENT_CLASS,
  CARD_DESCRIPTION_CLASS,
  CARD_FOOTER_CLASS,
  CARD_HEADER_CLASS,
  CARD_TITLE_CLASS,
  OVERLAY_CLASS,
} from "./overlayClasses";

const CardDialog = DialogPrimitive.Root;
const CardDialogTrigger = DialogPrimitive.Trigger;
const CardDialogClose = DialogPrimitive.Close;

interface CardDialogContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "className"
> {
  /** 預設右上角有 ✕。純表單、一定要用底部按鈕收尾的情境才關掉。 */
  hideClose?: boolean | undefined;
}

const CardDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  CardDialogContentProps
>(({ children, hideClose = false, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={OVERLAY_CLASS} />
    <DialogPrimitive.Content ref={ref} className={CARD_CONTENT_CLASS} {...props}>
      {children}
      {hideClose ? null : (
        <DialogPrimitive.Close className={CARD_CLOSE_CLASS}>
          <X className="h-5 w-5" />
          <span className="sr-only">關閉</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
CardDialogContent.displayName = "CardDialogContent";

const CardDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(CARD_HEADER_CLASS, className)} {...props} />
);
CardDialogHeader.displayName = "CardDialogHeader";

const CardDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(CARD_FOOTER_CLASS, className)} {...props} />
);
CardDialogFooter.displayName = "CardDialogFooter";

const CardDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn(CARD_TITLE_CLASS, className)} {...props} />
));
CardDialogTitle.displayName = "CardDialogTitle";

const CardDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(CARD_DESCRIPTION_CLASS, className)}
    {...props}
  />
));
CardDialogDescription.displayName = "CardDialogDescription";

export {
  CardDialog,
  CardDialogTrigger,
  CardDialogClose,
  CardDialogContent,
  CardDialogHeader,
  CardDialogFooter,
  CardDialogTitle,
  CardDialogDescription,
};
