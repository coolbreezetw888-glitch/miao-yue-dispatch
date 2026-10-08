// SPECS-INDEX #1005(第 14 批,2026-10-07)/ #1012(第 18 批,2026-10-08):行事曆時間軸預約卡片的內容
// —— 商家端與服務人員端共用。
// #1012 使用者裁決(選比較圖 B + 三點調整):
//   ・時間標籤在左上角,**固定**半透明白底(75%)+ 深色字,不隨狀態色變
//   ・時間標籤下方一條白色半透明虛線
//   ・客戶姓名白字、粗體,在虛線下方剩餘空間**垂直 + 水平置中**;太長截斷加「…」
// 半小時(一格高)放不下三層 ⇒ 時間標籤靠左、姓名在剩下空間置中、不畫虛線(門檻見 bookingBlockLayout.ts)。
// 卡片底色 / 白字由外層 filledBookingBlockStyle 決定;這裡的姓名、虛線跟著卡片文字色(白)。

import { bookingBlockLayout } from "./bookingBlockLayout";
import { isoToTaipeiTime } from "./dateUtils";

export function BookingBlockContent({
  startAt,
  name,
  height,
}: {
  /** 預約開始時間(ISO),顯示成台北時間 HH:mm。 */
  startAt: string;
  /** 卡片顯示的文字(客戶名字;協助卡已經帶「(協助)」)。 */
  name: string;
  /** 卡片實際畫出來的高度(px),決定排三層還是一行。 */
  height: number | undefined;
}) {
  const layout = bookingBlockLayout(height);
  const timeLabel = (
    <span
      data-booking-block-time=""
      className="inline-block shrink-0 rounded-[3px] bg-[rgba(255,255,255,0.75)] px-1 text-[10px] font-semibold leading-[12px] text-[#111827] tabular-nums"
    >
      {isoToTaipeiTime(startAt)}
    </span>
  );
  const nameText = (
    <span data-booking-block-name="" className="min-w-0 max-w-full truncate font-bold">
      {name}
    </span>
  );

  if (layout === "inline") {
    return (
      <span data-booking-block-layout="inline" className="flex h-full min-w-0 items-center gap-1">
        {timeLabel}
        <span className="flex min-w-0 flex-1 justify-center">{nameText}</span>
      </span>
    );
  }

  return (
    <span data-booking-block-layout="stacked" className="flex h-full min-w-0 flex-col">
      <span className="flex">{timeLabel}</span>
      <span
        aria-hidden="true"
        data-booking-block-divider=""
        className="my-0.5 block border-t border-dashed border-[rgba(255,255,255,0.6)]"
      />
      <span className="flex min-h-0 min-w-0 flex-1 items-center justify-center">{nameText}</span>
    </span>
  );
}
