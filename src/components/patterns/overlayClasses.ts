// ui-overlay-patterns skill 三、兩種窗(2026-09-29 方案 D)——小卡窗與全頁層共用的遮罩與動畫 class。
// 抽出來的原因:「建立正式會員」是全頁層上面再疊一個小卡窗(skill 三、兩層重疊),兩層遮罩會相加,
// 所以遮罩不能沿用 shadcn 預設的 bg-black/80(疊兩層幾乎全黑)。這裡統一用 foreground 40%,
// 疊兩層約 64%,而且顏色跟著主題的前景色走,不寫死任何 hex。
//
// ⚠️ 只給 CardDialog / CardAlertDialog / FullPageLayer 三個殼用,個別頁面不要 import。

export const OVERLAY_CLASS =
  "fixed inset-0 z-50 bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

/** 小卡窗 / 確認窗本體(手機規格;確認窗電腦也用這個):置中、16px 圓角(rounded-xl = --radius + 4px)、手機左右各留 16px、最寬 400px、高度隨內容
 *  (電腦版:確認窗照這個 400px;小卡窗 CardDialog 另外疊上 CARD_DIALOG_CONTENT_CLASS 拉寬)。
 *  max-h + overflow 只是極端小螢幕的保險(skill 說「不捲動」,正常內容量不會觸發)。 */
export const CARD_CONTENT_CLASS =
  "fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-32px)] max-w-[400px] max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg duration-200 focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

/** 小卡窗標題列 / 標題 / 說明 / 按鈕列。按鈕列:手機左右各半(每顆 flex-1),電腦靠右、按內容寬。
 *  第 12 批起 CARD_FOOTER_CLASS(電腦靠右)只剩確認窗 CardAlertDialog 用;CardDialog 用下方 CARD_DIALOG_*。 */
export const CARD_HEADER_CLASS = "flex flex-col gap-1.5 pr-8 text-left";
export const CARD_TITLE_CLASS = "text-[17px] font-bold leading-snug text-foreground";
export const CARD_DESCRIPTION_CLASS = "text-[13px] leading-relaxed text-muted-foreground";
export const CARD_FOOTER_CLASS =
  "flex items-center gap-2 pt-1 [&>*]:min-w-0 [&>*]:flex-1 sm:justify-end sm:[&>*]:flex-none";

/** 小卡窗(CardDialog)電腦版(sm 以上)—— 第 12 批 #1001。確認窗 CardAlertDialog 不用這組,維持 400px。
 *  手機(< 640px)完全沿用上面的 CARD_* 規格(這裡全部是 sm: 前綴,或手機上 display:contents 不產生框)。
 *  電腦:
 *   - 寬度:對齊底下頁面的主要內容欄(第 15 批 #1009,見下方 CARD_DIALOG_COLUMN_ALIGN_CLASS);
 *     量不到時退回同全頁層:左右各留 16px、最寬 1152px(sm:max-w-6xl,與 FULL_PAGE_PANEL_CLASS 同一個 token)。
 *   - 高度跟著內容;最高 = 畫面高 − 56px − 18px。在「上 56px、下 18px」之間的範圍垂直置中
 *     (中心點 = 50% + 19px;2026-10-07 使用者裁決維持置中,不固定在頂端 56px)。
 *     內容很長時上緣剛好 56px(上方空白條照小卡窗規則最多 48px)、下緣 18px。
 *   - 標題列(下方分隔線)與按鈕列(上方分隔線)固定,只有中間內容區捲動。
 *   - 按鈕列按鈕平均分寬(兩顆各半、三顆三等分),跟全頁層一樣。
 *   - 欄位不重排成兩欄(只拉寬)。 */
/** 第 15 批 #1009:電腦版寬度改成對齊底下頁面的主要內容欄(使用者:「寬度應該要同紅框的寬度」)。
 *  CardDialog 量到內容欄時才會掛 data-card-col-align,並用 CSS 變數給中心點與寬度
 *  (左 = 中心點、照舊 -translate-x-1/2 置中,進場動畫不受影響);沒掛 ⇒ 沿用上面的第 12 批規則
 *  (左右 16px、最寬 1152px)。全部 sm: 前綴,手機不受影響。
 *  🔴 transition-none:CARD_CONTENT_CLASS 的 duration-200 沒限定屬性(= transition all),不取消的話
 *     寬度 / left 會跑 200ms 過渡,打開時「先寬後縮」、拉視窗也慢半拍(第 15 批 QA 打回)。只在對齊狀態取消,
 *     確認窗 CardAlertDialog 共用的 CARD_CONTENT_CLASS 不動;進場淡入 / 縮放是 animation,不受影響。 */
const CARD_DIALOG_COLUMN_ALIGN_CLASS =
  "sm:data-[card-col-align]:left-[var(--card-col-center)] sm:data-[card-col-align]:w-[var(--card-col-width)] sm:data-[card-col-align]:max-w-none sm:data-[card-col-align]:transition-none";
export const CARD_DIALOG_CONTENT_CLASS = `${CARD_CONTENT_CLASS} sm:top-[calc(50%+19px)] sm:max-w-6xl sm:max-h-[calc(100dvh-74px)] sm:gap-0 sm:overflow-hidden sm:p-0 ${CARD_DIALOG_COLUMN_ALIGN_CLASS}`;
/** 中間內容區:手機 display:contents(子元素照舊直接排在卡片裡,跟改版前一模一樣);電腦自己捲動。 */
export const CARD_DIALOG_BODY_CLASS =
  "contents sm:flex sm:min-h-0 sm:min-w-0 sm:flex-col sm:gap-4 sm:overflow-y-auto sm:px-5 sm:py-4";
/** 標題列:電腦固定在上方、下面一條分隔線;右邊留給 ✕(right-2 + 36px)。 */
export const CARD_DIALOG_HEADER_CLASS = `${CARD_HEADER_CLASS} sm:shrink-0 sm:border-b sm:border-border sm:pt-5 sm:pb-4 sm:pl-5 sm:pr-14`;
/** 按鈕列:手機照舊左右各半;電腦固定在底部、上面一條分隔線、按鈕平均分寬(不再靠右)。
 *  沒有中間內容(只有標題 + 按鈕)時,緊接在標題列後面 ⇒ 不再畫上分隔線,免得兩條線疊成粗線。 */
export const CARD_DIALOG_FOOTER_CLASS =
  "flex items-center gap-2 pt-1 [&>*]:min-w-0 [&>*]:flex-1 sm:shrink-0 sm:border-t sm:border-border sm:px-5 sm:pt-3 sm:pb-4 sm:[[data-card-dialog-header]+&]:border-t-0";

/** 小卡窗右上角的 ✕:視覺 20px、點擊區 36px。 */
export const CARD_CLOSE_CLASS =
  "absolute right-2 top-2 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none";

/** 全頁層電腦版寬度(第 11 批 J,#995 J-16):隨瀏覽器寬度伸縮、左右各留 16px、最寬 1152px
 *  (= 行事曆頁內容容器 `max-w-6xl`;用同一個 Tailwind token,之後內容容器改寬度兩邊一起改)。
 *  只拉寬不重排;手機 < 640px 不受影響(全部是 sm: 前綴)。 */
export const FULL_PAGE_PANEL_CLASS = "sm:w-[calc(100%-32px)] sm:max-w-6xl";
