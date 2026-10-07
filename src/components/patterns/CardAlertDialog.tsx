/**
 * 小卡窗殼(AlertDialog 版,純確認用)—— ui-overlay-patterns skill 三、兩種窗 → 小卡窗。
 *
 * 外觀:置中 / 16px 圓角 / 手機留 16px / 電腦 400px / 高度隨內容。手機跟 CardDialog.tsx 一樣;
 * 電腦版**不跟著** CardDialog 拉寬(第 12 批 #1001 使用者裁決:確認窗維持小小的、按鈕靠右)。
 * 差別只在底層是 Radix AlertDialog:**點遮罩不會關**,適合「刪除 / 取消預約 / 解除串接」這類要使用者
 * 明確二選一的確認。⚠️ **按 Esc 會關**(Radix AlertDialog 只擋點遮罩,不擋 Esc;#844 批次 4 QA 實測),
 * 效果等同按「取消」那顆 —— 走 onOpenChange(false)。有輸入欄位的短表單請用 CardDialog。
 *
 * 第 11 批 J(#995 J-7、J-8、J-12):卡片正上方 48px 有「點了取消」的空白條,**等同按 Esc**
 *   (先跑頁面的 onEscapeKeyDown,被 preventDefault 就不關;沒被攔 ⇒ 觸發殼裡隱藏的 Close ⇒ onOpenChange(false))。
 *   🔴 不會跑頁面「取消」鈕自己的 onClick ⇒ 取消要做的事一律寫在 onOpenChange(false)。
 *   🔴「必須選一個」的確認窗(例:協助人員已移除)傳 dismissStrip={false} 不畫空白條。
 *   確認窗不做 dirty(J-12):Esc / 空白條直接取消。
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
 * 🔴 SPECS-INDEX #861「全站彈窗關掉自動聚焦」為什麼**沒有**動這個檔案(不是漏改):
 *    Radix 的 AlertDialogContent 內部**本來就已經**做了這件事 ——
 *      node_modules/@radix-ui/react-alert-dialog/dist/index.mjs 第 58-61 行:
 *        onOpenAutoFocus: composeEventHandlers(contentProps.onOpenAutoFocus, (event) => {
 *          event.preventDefault();
 *          cancelRef.current?.focus({ preventScroll: true });
 *        })
 *    它 preventDefault 掉「自動聚焦第一個可聚焦元素」,然後把焦點放在**「取消」按鈕**上。
 *    所以:① 焦點不是輸入框 ⇒ 手機不會彈鍵盤(使用者回報的問題在這個殼上不存在);
 *          ② 焦點在對話框裡面、而且落在「安全的那一顆」⇒ 無障礙比放在裸容器上更好。
 *    ⇒ 在這裡再疊一層 onOpenAutoFocus 只會把「落在取消鈕」換成「落在容器」,沒有任何好處,
 *      還讓鍵盤使用者多按一次 Tab。這個殼也永遠不會有輸入欄位(有欄位的短表單一律用 CardDialog),
 *      所以不會有「以後某天它變成會彈鍵盤」的風險。
 *    ⚠️ 如果哪天要改成跟另外兩個殼一樣(焦點放容器),請用 useOverlayOpenAutoFocus
 *      (src/components/patterns/overlayAutoFocus.ts),不要各寫一份。
 *
 * ⚠️ 這裡改動會影響全站所有確認窗,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { CARD_STRIP_MAX_HEIGHT, createDismissEscapeEvent } from "./overlayDismissLogic";
import { OverlayDismissStrip } from "./OverlayDismissStrip";
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

interface CardAlertDialogContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>,
  "className"
> {
  /** 預設 true:卡片正上方畫「點了取消」的空白條。「必須選一個」的確認窗傳 false。 */
  dismissStrip?: boolean | undefined;
}

const CardAlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  CardAlertDialogContentProps
>(({ dismissStrip = true, onEscapeKeyDown, children, ...props }, ref) => {
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const setCardRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // 空白條 = Esc:先讓頁面的 onEscapeKeyDown 有機會攔(例:送出中不能關),沒攔才關。
  const requestDismiss = React.useCallback(() => {
    const event = createDismissEscapeEvent();
    onEscapeKeyDown?.(event);
    if (event.defaultPrevented) return;
    closeRef.current?.click();
  }, [onEscapeKeyDown]);
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={OVERLAY_CLASS} />
      <AlertDialogPrimitive.Content
        ref={setCardRef}
        className={CARD_CONTENT_CLASS}
        {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})}
        {...props}
      >
        {children}
        {dismissStrip ? (
          // 隱藏的關閉鈕(⇒ onOpenChange(false))。用 Action 不用 Cancel:Cancel 會搶走 Radix 開窗時
          // 「焦點放在取消鈕」的 cancelRef;Action 底層一樣是 Dialog Close,但不碰 cancelRef,也不是頁面的「取消」鈕。
          <AlertDialogPrimitive.Action
            ref={closeRef}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            style={{ display: "none" }}
            data-overlay-hidden-close=""
          />
        ) : null}
      </AlertDialogPrimitive.Content>
      {dismissStrip ? (
        <OverlayDismissStrip
          targetRef={cardRef}
          maxHeight={CARD_STRIP_MAX_HEIGHT}
          onDismiss={requestDismiss}
        />
      ) : null}
    </AlertDialogPrimitive.Portal>
  );
});
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
