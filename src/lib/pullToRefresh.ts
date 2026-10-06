// SPECS-INDEX #982(2026-10-06):手機下拉刷新 —— 判斷邏輯(純函式,有 Vitest:pullToRefresh.test.ts)。
// 規格:.project/specs/建單畫面與下拉刷新-第2批.md 第三節;畫面在 src/components/PullToRefresh.tsx。
//
// ─── 最重要的一條:絕對不能干擾既有手勢 ───────────────────────────────────────────────
// 行事曆有「直接拖 = 捲動」「長按 0.5 秒浮起來再拖 = 改時間 / 轉派」「左右滑 = 換日 / 換週」
// (ui-overlay-patterns skill 六、#811、#845、#961)。下拉刷新的做法是**只聽、不攔**:
//   ・所有 touch 監聽器都是 passive,從不呼叫 preventDefault —— 不會擋到任何捲動或拖拉
//   ・一碰到下面任何一個「不該觸發」的條件,這一次手勢就整個放棄(直到手指離開螢幕)
// 寧可少觸發,也不要在拖預約的時候畫面突然重抓資料。

/** 手指往下拉超過這個距離(px,手指實際移動量)放開才觸發(規格:約 70px)。 */
export const PULL_TO_REFRESH_THRESHOLD_PX = 70;
/** 只在寬度 < 1024px 的畫面啟用(規格:手機 / 平板直式;電腦版不做)。 */
export const PULL_TO_REFRESH_MAX_VIEWPORT_WIDTH = 1024;
/** 手指移動不到這個距離之前,還分不出是要往哪個方向滑,先不決定。 */
export const PULL_DIRECTION_DECIDE_PX = 8;
/**
 * 從手指放上去到「看得出是往下拉」之間超過這個時間 ⇒ 視為長按,放棄。
 * 行事曆色塊長按 500ms 就會浮起來進入拖拉模式(calendarBookingDrag),所以要比它短。
 */
export const PULL_LONG_PRESS_CANCEL_MS = 400;
/** 指示器實際往下移動的距離 = 手指距離 × 這個係數(阻尼,拉起來比較有「拉」的感覺)。 */
export const PULL_INDICATOR_RESISTANCE = 0.5;
/** 指示器最多往下移動這麼多(px)。 */
export const PULL_INDICATOR_MAX_OFFSET = 64;

export const PULL_TEXT_PULLING = "下拉以重新整理";
export const PULL_TEXT_READY = "放開以重新整理";
export const PULL_TEXT_REFRESHING = "重新整理中";

export type PullBlockReason =
  "desktop" | "multi-touch" | "overlay-open" | "opted-out" | "page-not-at-top" | "inner-scrolled";

/** 會「蓋在畫面上」的東西:任何一個開著,下拉刷新就停用(規格:彈窗、抽屜、整頁選擇畫面打開時停用)。 */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  "[data-radix-popper-content-wrapper]",
  "[vaul-drawer][data-state='open']",
  '[data-pull-to-refresh="off"]',
].join(",");

/** 手指從這些元素裡面開始拉 ⇒ 不觸發(手勢屬於那個元件)。 */
const OPT_OUT_SELECTOR = [
  '[data-pull-to-refresh="off"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-radix-popper-content-wrapper]",
  // 行事曆可拖拉的預約色塊:長按 0.5 秒後是拖拉改時間,不是下拉刷新。
  '[data-booking-draggable="true"]',
].join(",");

/** 這個元素本身是不是一個「目前可以往上捲」的內層捲動區(不在頂端)。 */
function isScrolledInnerContainer(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.scrollTop <= 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  const overflowY = style?.overflowY ?? "";
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/**
 * 手指剛放上去(touchstart)時判斷:這一次可不可以開始下拉刷新。回傳 null = 可以;否則是原因。
 * 順序沒有語意上的優先權,只是先檢查便宜的。
 */
export function resolvePullBlockReason(input: {
  target: Element | null;
  doc: Document;
  viewportWidth: number;
  touchCount: number;
  pageScrollTop: number;
}): PullBlockReason | null {
  if (input.viewportWidth >= PULL_TO_REFRESH_MAX_VIEWPORT_WIDTH) return "desktop";
  if (input.touchCount !== 1) return "multi-touch";
  // Radix 的對話框 / 選單打開時會在 body 加 data-scroll-locked(react-remove-scroll),兩個訊號都看。
  if (input.doc.body?.hasAttribute("data-scroll-locked")) return "overlay-open";
  if (input.doc.querySelector(OPEN_OVERLAY_SELECTOR)) return "overlay-open";
  if (input.target?.closest(OPT_OUT_SELECTOR)) return "opted-out";
  if (input.pageScrollTop > 0) return "page-not-at-top";
  // 內層有自己的捲動區而且不在頂端(例:行事曆格線往下捲過了)⇒ 往下拉是要把它捲回去,不是刷新。
  for (let el = input.target; el && el !== input.doc.body; el = el.parentElement) {
    if (isScrolledInnerContainer(el)) return "inner-scrolled";
  }
  return null;
}

export type PullDirection = "undecided" | "pull" | "cancel";

/**
 * 手指移動中:看出方向了沒有。
 *   ・往上、或水平為主(左右滑換日 / 換週、橫向捲行事曆)⇒ cancel
 *   ・往下為主 ⇒ pull;但如果拖了太久才看出方向(長按之後才開始拖)⇒ cancel
 */
export function resolvePullDirection(input: {
  dx: number;
  dy: number;
  elapsedMs: number;
}): PullDirection {
  const { dx, dy, elapsedMs } = input;
  if (Math.abs(dx) < PULL_DIRECTION_DECIDE_PX && Math.abs(dy) < PULL_DIRECTION_DECIDE_PX) {
    return elapsedMs > PULL_LONG_PRESS_CANCEL_MS ? "cancel" : "undecided";
  }
  if (dy <= 0) return "cancel";
  if (Math.abs(dx) >= Math.abs(dy)) return "cancel";
  if (elapsedMs > PULL_LONG_PRESS_CANCEL_MS) return "cancel";
  return "pull";
}

/** 放開時:拉的距離有沒有超過門檻。 */
export function shouldTriggerRefresh(pullDistance: number): boolean {
  return pullDistance >= PULL_TO_REFRESH_THRESHOLD_PX;
}

/** 指示器要往下移多少、轉幾度、顯示哪句話。 */
export function resolvePullIndicator(pullDistance: number): {
  offset: number;
  progress: number;
  ready: boolean;
  text: string;
} {
  const distance = Math.max(0, pullDistance);
  const ready = shouldTriggerRefresh(distance);
  return {
    offset: Math.min(PULL_INDICATOR_MAX_OFFSET, distance * PULL_INDICATOR_RESISTANCE),
    progress: Math.min(1, distance / PULL_TO_REFRESH_THRESHOLD_PX),
    ready,
    text: ready ? PULL_TEXT_READY : PULL_TEXT_PULLING,
  };
}
