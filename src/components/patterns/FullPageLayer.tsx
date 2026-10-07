/**
 * 全頁層殼 —— ui-overlay-patterns skill 三、兩種窗 → 全頁層。
 *
 * 用在:長表單、需要捲動的編輯畫面、沒有欄位但內容長的詳情(預約詳情)。
 * 規格全部寫死在這個殼裡,**個別頁面不准再自己寫 max-w-* / h-[92vh] 這類尺寸**:
 *   - 手機:整個螢幕蓋滿,像進到新頁面;關閉鈕在左上角 ✕
 *   - 電腦:置中大面板、上緣留 56px(這條是「點了關閉」的空白條)、下緣 18px,🔴 不會佔滿 27 吋螢幕;
 *     寬度隨瀏覽器寬度伸縮、左右各留 16px、最寬 1152px(= 行事曆頁內容容器 max-w-6xl),只拉寬不重排
 *     (第 11 批 J,#995 J-16 ~ J-18)。關閉:右上角 ✕、底部「取消」、Esc、點面板正上方的空白條
 *   - 🔴 點遮罩(左右兩側、下方)不會關(J-1);Esc / 空白條遇到 dirty 先問「確定放棄這次輸入？」(J-9、J-10)
 *   - 標題列固定在上方、按鈕列固定在底部、只有中間會捲動
 *   - 寬度只有一檔(J-16);size prop 保留但不再分寬度(@deprecated,J-17)
 *
 * 用法:
 *   <FullPageLayer open={open} onOpenChange={setOpen}>
 *     <FullPageLayerContent
 *       title="預約詳情"
 *       subtitle="名稱、金額、類型、工時皆為必填。"   // 可見副標(選填),標題列下方小字灰色
 *       titleExtra={<StatusTag tone="warning">待確認</StatusTag>}
 *       footer={<ActionBar><Button .../><Button .../><Button .../></ActionBar>}
 *     >
 *       ...會捲動的內容...
 *     </FullPageLayerContent>
 *   </FullPageLayer>
 *
 * 全頁層上面再疊小卡窗(例如預約詳情 → 取消預約確認、建單表單 → 建立正式會員)直接在內容或 footer 裡
 * 放 CardAlertDialog / CardDialog 即可,Radix 會各自 portal 到 body,後開的蓋在上面(skill 三、兩層重疊)。
 *
 * ⚠️ 這裡改動會影響全站所有全頁層,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { useOverlayOpenAutoFocus } from "./overlayAutoFocus";
import { FULL_PAGE_PANEL_CLASS, OVERLAY_CLASS } from "./overlayClasses";
import { useOverlayDirtyDismiss } from "./overlayDirtyDismiss";
import { FULL_PAGE_STRIP_MAX_HEIGHT } from "./overlayDismissLogic";
import { OverlayDismissStrip } from "./OverlayDismissStrip";

const FullPageLayer = DialogPrimitive.Root;
const FullPageLayerTrigger = DialogPrimitive.Trigger;
const FullPageLayerClose = DialogPrimitive.Close;

// 第 11 批 J(J-16 / J-17):電腦版寬度只剩一檔,default / wide 都對應同一個 class。
const SIZE_CLASS = {
  default: FULL_PAGE_PANEL_CLASS,
  wide: FULL_PAGE_PANEL_CLASS,
} as const;

interface FullPageLayerContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "className" | "title"
> {
  /** 標題列文字(必填;Radix 需要 Title 供螢幕閱讀器朗讀)。 */
  title: React.ReactNode;
  /** 標題右側的附加內容,例如狀態標籤。 */
  titleExtra?: React.ReactNode | undefined;
  /** 底部固定按鈕列。三顆等寬請包在 <ActionBar> 裡(skill 二之三「底部動作列:三顆等寬」)。 */
  footer?: React.ReactNode | undefined;
  /**
   * @deprecated 第 11 批 J 起全頁層電腦版一律同寬(隨瀏覽器寬度伸縮、最寬 1152px);default / wide 輸出相同。
   * 保留只是為了不動到還在傳 size="wide" 的頁面,下次動到那些頁面時順手刪掉。
   */
  size?: keyof typeof SIZE_CLASS | undefined;
  /**
   * 有「按儲存才寫入」的欄位、而且使用者改過(跟打開時的內容不同)⇒ true。用 useFormDirty 算(formDirty.ts)。
   * true 時 Esc / 點上方空白條會先問「確定放棄這次輸入？」;✕ 與「取消」鈕不問(J-11)。預設 false。
   */
  dirty?: boolean | undefined;
  /**
   * 🔵 可見的副標:標題列下方一行小字灰色(例:「名稱、金額、類型、工時皆為必填。」),同時也是
   * 螢幕閱讀器的描述(Radix Description)。跟標題列一樣固定在上方,不隨內容捲走。
   */
  subtitle?: React.ReactNode | undefined;
  /** 只給螢幕閱讀器的補充說明(sr-only)。有 subtitle 時以 subtitle 為準、這個會被忽略
   *  (Radix 一個對話框只能有一個 Description)。兩個都沒有就不會有 aria-describedby
   *  (避免 Radix 的 console warning)。 */
  description?: string | undefined;
}

const closeButtonClass =
  "inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const FullPageLayerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  FullPageLayerContentProps
>(
  (
    {
      children,
      title,
      titleExtra,
      footer,
      size = "default",
      subtitle,
      description,
      onOpenAutoFocus,
      dirty = false,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      ...props
    },
    ref,
  ) => {
    // SPECS-INDEX #861:開窗時不要自動聚焦第一個可聚焦元素(手機會彈鍵盤)。全頁層是長表單的殼
    // (建單、編輯服務人員……),第一個可聚焦元素幾乎都是輸入框,所以這裡是使用者回報的主場。
    // 焦點改放在對話框容器本身,理由與無障礙考量見 overlayAutoFocus.ts。
    const autoFocus = useOverlayOpenAutoFocus(ref, onOpenAutoFocus);
    // 空白條要量面板的位置,所以自己也留一份 ref。
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const autoFocusRef = autoFocus.ref;
    const setPanelRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        panelRef.current = node;
        autoFocusRef(node);
      },
      [autoFocusRef],
    );
    const dismiss = useOverlayDirtyDismiss({ dirty, onEscapeKeyDown });
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASS} />
        <DialogPrimitive.Content
          ref={setPanelRef}
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
          // 沒有 Description 時要明確給 undefined,Radix 才不會在 console 警告缺少 aria-describedby;
          // 有 Description 時不能傳(傳 undefined 會蓋掉 Radix 自動連結的 id)。
          {...(subtitle || description ? {} : { "aria-describedby": undefined })}
          className={cn(
            // 手機:整個螢幕蓋滿(dvh 才會避開 iOS Safari 的網址列)。
            "fixed inset-0 z-50 flex h-dvh w-full flex-col bg-background focus:outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            // 電腦:置中面板、上緣 56px(空白條)、下緣 18px、左右最少留 16px、圓角 16px;寬度見 SIZE_CLASS。
            "sm:inset-x-auto sm:top-14 sm:bottom-[18px] sm:left-1/2 sm:h-auto sm:-translate-x-1/2 sm:overflow-hidden sm:rounded-xl sm:border sm:shadow-lg",
            "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
            SIZE_CLASS[size],
          )}
          {...props}
        >
          <header className="shrink-0 border-b border-border">
            <div className="flex h-[54px] items-center gap-2 px-2 sm:px-3">
              {/* 手機:左上角 ✕ */}
              <DialogPrimitive.Close className={cn(closeButtonClass, "sm:hidden")}>
                <X className="h-5 w-5" />
                <span className="sr-only">關閉</span>
              </DialogPrimitive.Close>
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-base font-bold text-foreground sm:pl-1">
                {title}
              </DialogPrimitive.Title>
              {!subtitle && description ? (
                <DialogPrimitive.Description className="sr-only">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
              {titleExtra ? (
                <div className="flex shrink-0 items-center gap-2">{titleExtra}</div>
              ) : null}
              {/* 電腦:右上角 ✕ */}
              <DialogPrimitive.Close className={cn(closeButtonClass, "hidden sm:inline-flex")}>
                <X className="h-5 w-5" />
                <span className="sr-only">關閉</span>
              </DialogPrimitive.Close>
            </div>
            {subtitle ? (
              // 可見副標:手機對齊標題(標題前面有 40px 的 ✕,所以左邊 padding 跟著補到 48px);
              // 電腦沒有左上角 ✕,對齊標題的 pl-1 + px-3。
              <DialogPrimitive.Description className="-mt-1.5 break-words px-4 pb-2.5 pl-12 text-[13px] leading-relaxed text-muted-foreground sm:pl-4">
                {subtitle}
              </DialogPrimitive.Description>
            ) : null}
          </header>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

          {footer ? (
            <footer className="shrink-0 border-t border-border px-3 pt-2.5 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-4">
              {footer}
            </footer>
          ) : null}
          {dismiss.hiddenClose}
          {dismiss.discardConfirm}
        </DialogPrimitive.Content>
        {/* J-4 / J-5:面板正上方的空白條(只有電腦;手機滿版上方 0px ⇒ 不畫)。 */}
        <OverlayDismissStrip
          targetRef={panelRef}
          maxHeight={FULL_PAGE_STRIP_MAX_HEIGHT}
          onDismiss={dismiss.requestDismiss}
        />
      </DialogPrimitive.Portal>
    );
  },
);
FullPageLayerContent.displayName = "FullPageLayerContent";

export { FullPageLayer, FullPageLayerTrigger, FullPageLayerClose, FullPageLayerContent };
