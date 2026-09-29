/**
 * 全頁層殼 —— ui-overlay-patterns skill 三、兩種窗 → 全頁層。
 *
 * 用在:長表單、需要捲動的編輯畫面、沒有欄位但內容長的詳情(預約詳情)。
 * 規格全部寫死在這個殼裡,**個別頁面不准再自己寫 max-w-* / h-[92vh] 這類尺寸**:
 *   - 手機:整個螢幕蓋滿,像進到新頁面;關閉鈕在左上角 ✕
 *   - 電腦:置中大面板、上下各留 18px,🔴 不會佔滿 27 吋螢幕;關閉鈕在右上角 ✕(或底部「取消」)
 *   - 標題列固定在上方、按鈕列固定在底部、只有中間會捲動
 *   - 寬度只有兩檔具名尺寸(size="default" 560px / size="wide" 760px),要更寬請改這裡,不要在頁面上寫
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

import { OVERLAY_CLASS } from "./overlayClasses";

const FullPageLayer = DialogPrimitive.Root;
const FullPageLayerTrigger = DialogPrimitive.Trigger;
const FullPageLayerClose = DialogPrimitive.Close;

const SIZE_CLASS = {
  default: "sm:max-w-[560px]",
  wide: "sm:max-w-[760px]",
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
  /** 電腦版面板寬度的具名尺寸。default 560px 給一般表單 / 詳情;wide 760px 給兩欄格線 + 多個開關列 /
   *  每個服務項目一列的那種長表(例:服務人員表單)。 */
  size?: keyof typeof SIZE_CLASS | undefined;
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
    { children, title, titleExtra, footer, size = "default", subtitle, description, ...props },
    ref,
  ) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={OVERLAY_CLASS} />
      <DialogPrimitive.Content
        ref={ref}
        // 沒有 Description 時要明確給 undefined,Radix 才不會在 console 警告缺少 aria-describedby;
        // 有 Description 時不能傳(傳 undefined 會蓋掉 Radix 自動連結的 id)。
        {...(subtitle || description ? {} : { "aria-describedby": undefined })}
        className={cn(
          // 手機:整個螢幕蓋滿(dvh 才會避開 iOS Safari 的網址列)。
          "fixed inset-0 z-50 flex h-dvh w-full flex-col bg-background focus:outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          // 電腦:置中面板、上下各留 18px、左右最少留 16px、圓角 16px。
          "sm:inset-x-auto sm:inset-y-[18px] sm:left-1/2 sm:h-auto sm:w-[calc(100%-32px)] sm:-translate-x-1/2 sm:overflow-hidden sm:rounded-xl sm:border sm:shadow-lg",
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
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
FullPageLayerContent.displayName = "FullPageLayerContent";

export { FullPageLayer, FullPageLayerTrigger, FullPageLayerClose, FullPageLayerContent };
