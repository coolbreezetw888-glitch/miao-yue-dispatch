/**
 * 小卡窗殼(Dialog 版)—— ui-overlay-patterns skill 三、兩種窗 → 小卡窗。
 *
 * 用在:確認、3 欄以內的短表單(分類原則見 skill 三「📐 分類原則」與「使用者已裁決的個案」)。
 * 規格全部寫死在這個殼裡:置中 / 16px 圓角 / 手機左右留 16px / 電腦固定 400px / 高度隨內容 /
 * 按鈕手機左右各半、電腦靠右。**個別頁面不准再自己寫 max-w-* 或 className 調寬度** ——
 * 盤點報告指出「每個彈窗寬度各自手寫」正是目前大小不一的根因,所以 CardDialogContent 刻意不收 className。
 *
 * 純確認(沒有表單)請用 CardAlertDialog.tsx;有輸入欄位的短表單用這個。
 *
 * 關閉(第 11 批 J,#995):右上角 ✕ / 取消 / Esc / 點卡片正上方 48px 空白條。🔴 點遮罩不會關(J-1)。
 * 有「按儲存才寫入」的欄位 ⇒ 用 useFormDirty 傳 dirty;Esc / 空白條遇到 dirty 先問「確定放棄這次輸入？」。
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

import { useOverlayOpenAutoFocus } from "./overlayAutoFocus";
import { useOverlayDirtyDismiss } from "./overlayDirtyDismiss";
import { CARD_STRIP_MAX_HEIGHT } from "./overlayDismissLogic";
import { OverlayDismissStrip } from "./OverlayDismissStrip";
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
  /**
   * 有「按儲存才寫入」的欄位、而且使用者改過 ⇒ true(用 useFormDirty 算)。
   * true 時 Esc / 點上方空白條先問「確定放棄這次輸入？」;✕ 與「取消」鈕不問(J-11)。預設 false。
   */
  dirty?: boolean | undefined;
  /** 預設 true:卡片正上方畫「點了關閉」的空白條。只有「必須選一個」的特殊視窗才傳 false。 */
  dismissStrip?: boolean | undefined;
}

const CardDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  CardDialogContentProps
>(
  (
    {
      children,
      hideClose = false,
      onOpenAutoFocus,
      dirty = false,
      dismissStrip = true,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      ...props
    },
    ref,
  ) => {
    // SPECS-INDEX #861:開窗時不要自動聚焦第一個可聚焦元素(手機會彈鍵盤),改把焦點放在
    // 對話框容器本身。完整理由與無障礙考量見 overlayAutoFocus.ts。
    const autoFocus = useOverlayOpenAutoFocus(ref, onOpenAutoFocus);
    // 空白條要量卡片的位置,所以自己也留一份 ref。
    const cardRef = React.useRef<HTMLDivElement | null>(null);
    const autoFocusRef = autoFocus.ref;
    const setCardRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        cardRef.current = node;
        autoFocusRef(node);
      },
      [autoFocusRef],
    );
    const dismiss = useOverlayDirtyDismiss({ dirty, onEscapeKeyDown });
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASS} />
        <DialogPrimitive.Content
          ref={setCardRef}
          onOpenAutoFocus={autoFocus.onOpenAutoFocus}
          onEscapeKeyDown={dismiss.handleEscapeKeyDown}
          // J-1:點外面(遮罩、toast、畫面任何外面)一律不關;頁面自己傳的同名 handler 先跑。
          onPointerDownOutside={(event) => {
            onPointerDownOutside?.(event);
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            onInteractOutside?.(event);
            event.preventDefault();
          }}
          className={CARD_CONTENT_CLASS}
          {...props}
        >
          {children}
          {hideClose ? null : (
            <DialogPrimitive.Close className={CARD_CLOSE_CLASS}>
              <X className="h-5 w-5" />
              <span className="sr-only">關閉</span>
            </DialogPrimitive.Close>
          )}
          {dismiss.hiddenClose}
          {dismiss.discardConfirm}
        </DialogPrimitive.Content>
        {/* J-4 / J-5:卡片正上方 48px 的空白條(上方不夠 16px 就不畫)。 */}
        {dismissStrip ? (
          <OverlayDismissStrip
            targetRef={cardRef}
            maxHeight={CARD_STRIP_MAX_HEIGHT}
            label="關閉"
            onDismiss={dismiss.requestDismiss}
          />
        ) : null}
      </DialogPrimitive.Portal>
    );
  },
);
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
