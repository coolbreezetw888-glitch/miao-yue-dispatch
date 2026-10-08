// SPECS-INDEX #1005(第 14 批,2026-10-07)/ #1012(第 18 批,2026-10-08):行事曆時間軸「預約卡片」的
// 共用樣式、位置與版型判斷。
// 商家端(CalendarPage → DraggableBookingBlock)與服務人員端(MyCalendarTimelineView)兩邊共用,
// **不要各寫一份** —— 改一邊另一邊會又長得不一樣(主腦補上的決定,可單獨退)。
// 卡片內容元件在 BookingBlockContent.tsx(.tsx 只放元件,避免 react-refresh 警告)。

import type { CSSProperties } from "react";

import {
  DEFAULT_BOOKING_STATUS_COLORS,
  getBookingStatusColor,
  type BookingStatus,
  type BookingStatusColorMap,
} from "./types";

/**
 * 卡片「畫出來的高度」(px,已扣掉 #1012 上下間隔)達到這個值才排成三層「時間標籤 / 虛線 / 名字」,
 * 低於就把時間與名字排在同一行、不畫虛線。
 *
 * 怎麼算的(#1012 版,時間標籤拿掉了外框):卡片上下框 2px + 上下內距 8px,三層內容 = 時間標籤 12px
 * + 虛線含上下間距 5px + 名字一行約 14px ≈ 31px ⇒ 卡片至少要 2 + 8 + 31 = 41px。
 * 時間軸一格 30 分鐘 = 30px,每張卡片再扣 3px 上下間隔(BOOKING_BLOCK_GAP_*):
 * ⇒ 半小時(27px)一行;45 分鐘(42px)以上三層;一小時(57px)三層。
 * #1017(第 20 批):三層改成「虛線在正中間、上下兩半等高」,門檻照舊不動;45 分鐘卡內容區 32px
 * ⇒ 上下半各約 15.5px,時間標籤 12px、姓名一行都放得下。
 */
export const BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX = 41;

export type BookingBlockLayout = "stacked" | "inline";

/** 高度不明(沒給數字)時當成放得下 —— 寧可多一層,也不要把一張長卡片擠成一行。 */
export function bookingBlockLayout(heightPx: number | undefined): BookingBlockLayout {
  if (typeof heightPx !== "number" || !Number.isFinite(heightPx)) return "stacked";
  return heightPx >= BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX ? "stacked" : "inline";
}

// ---------------------------------------------------------------------------
// #1012 追加(使用者截圖 22):卡片之間留間隔,整張填色後才不會黏成一大片。
// ---------------------------------------------------------------------------

/** 卡片左右各內縮 3px ⇒ 商家端相鄰兩位服務人員的卡片之間空出 6px + 中間 1px 欄線 = 實測 7px,
 * 看得到底下的欄底色(規格:約 6~8px;4px 實測會變 9px,超出)。 */
export const BOOKING_BLOCK_INSET_X_PX = 3;
/** 卡片上緣往下 1px、下緣往上 2px ⇒ 前後相連的兩張卡片之間空出 3px。 */
export const BOOKING_BLOCK_GAP_TOP_PX = 1;
export const BOOKING_BLOCK_GAP_BOTTOM_PX = 2;

/**
 * 把「時間格換算出來的 top / height」轉成實際畫出來的位置(扣掉上下間隔)。
 * 🔴 拖拉的落點計算是看游標 + 卡片上緣(DraggableBookingBlock 會把 GAP_TOP 加回去),
 *    所以這裡只影響外觀,不影響落點。
 */
export function bookingBlockVerticalBox(
  top: number,
  height: number,
): { top: number; height: number } {
  return {
    top: top + BOOKING_BLOCK_GAP_TOP_PX,
    height: Math.max(1, height - BOOKING_BLOCK_GAP_TOP_PX - BOOKING_BLOCK_GAP_BOTTOM_PX),
  };
}

// ---------------------------------------------------------------------------
// #1012(第 18 批):整張填色 + 白字(使用者選比較圖的 B)
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 🔴 資安:狀態色是商家自己輸入的字串(資料庫只擋空字串,允許任意文字),要放進 inline style 前
 * 只接受 `#RGB` / `#RRGGBB` 兩種合法色碼,一律轉成小寫 `#rrggbb`。其他任何字串
 * (`rgb()`、顏色名稱、或夾帶 `;`、`url(` 的怪字串)一律改用該狀態的系統預設色,不原樣輸出。
 */
export function sanitizeHexColor(input: string | null | undefined, fallback: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const m = HEX_COLOR_RE.exec(raw);
  if (!m) return fallback;
  const hex = m[1]!;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  return `#${full.toLowerCase()}`;
}

/** 左邊色條往白色調亮的比例(規格:約 40~45%;取 45%,跟使用者看過的比較圖 B 一樣)。 */
export const BOOKING_BLOCK_BAR_LIGHTEN = 0.45;

/** 把 `#rrggbb` 往白色混合 ratio(0~1)。輸入必須是已經 sanitize 過的 6 碼色碼。 */
export function lightenHex(hex: string, ratio: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${c
    .map((v) =>
      Math.round(v + (255 - v) * ratio)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 卡片文字色。🔴 一律白字(使用者知情對比不足後仍選 B),不做「淺底自動換深色字」。 */
export const BOOKING_BLOCK_INK = "#ffffff";

/**
 * 兩端共用的預約卡片底色樣式:
 *   ・底色 = 商家設定的狀態色(原色、不透明)
 *   ・左邊 4px 色條 = 同色往白調亮 45%
 *   ・外框(上 / 右 / 下)= 跟左色條同色 —— 前後相連 / 同狀態的卡片才分得開(工程師選擇,見回報)
 *   ・字一律白色
 */
export function filledBookingBlockStyle(
  colors: BookingStatusColorMap,
  status: BookingStatus,
): CSSProperties {
  const fill = sanitizeHexColor(
    getBookingStatusColor(colors, status),
    getBookingStatusColor(DEFAULT_BOOKING_STATUS_COLORS, status),
  );
  const bar = lightenHex(fill, BOOKING_BLOCK_BAR_LIGHTEN);
  return {
    backgroundColor: fill,
    color: BOOKING_BLOCK_INK,
    borderColor: bar,
    borderLeftColor: bar,
    borderLeftWidth: 4,
  };
}
