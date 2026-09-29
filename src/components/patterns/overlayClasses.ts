// ui-overlay-patterns skill 三、兩種窗(2026-09-29 方案 D)——小卡窗與全頁層共用的遮罩與動畫 class。
// 抽出來的原因:「建立正式會員」是全頁層上面再疊一個小卡窗(skill 三、兩層重疊),兩層遮罩會相加,
// 所以遮罩不能沿用 shadcn 預設的 bg-black/80(疊兩層幾乎全黑)。這裡統一用 foreground 40%,
// 疊兩層約 64%,而且顏色跟著主題的前景色走,不寫死任何 hex。
//
// ⚠️ 只給 CardDialog / CardAlertDialog / FullPageLayer 三個殼用,個別頁面不要 import。

export const OVERLAY_CLASS =
  "fixed inset-0 z-50 bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

/** 小卡窗本體:置中、16px 圓角(rounded-xl = --radius + 4px)、手機左右各留 16px、電腦固定 400px、高度隨內容。
 *  max-h + overflow 只是極端小螢幕的保險(skill 說「不捲動」,正常內容量不會觸發)。 */
export const CARD_CONTENT_CLASS =
  "fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-32px)] max-w-[400px] max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg duration-200 focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

/** 小卡窗標題列 / 標題 / 說明 / 按鈕列。按鈕列:手機左右各半(每顆 flex-1),電腦靠右、按內容寬。 */
export const CARD_HEADER_CLASS = "flex flex-col gap-1.5 pr-8 text-left";
export const CARD_TITLE_CLASS = "text-[17px] font-bold leading-snug text-foreground";
export const CARD_DESCRIPTION_CLASS = "text-[13px] leading-relaxed text-muted-foreground";
export const CARD_FOOTER_CLASS =
  "flex items-center gap-2 pt-1 [&>*]:min-w-0 [&>*]:flex-1 sm:justify-end sm:[&>*]:flex-none";

/** 小卡窗右上角的 ✕:視覺 20px、點擊區 36px。 */
export const CARD_CLOSE_CLASS =
  "absolute right-2 top-2 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none";
