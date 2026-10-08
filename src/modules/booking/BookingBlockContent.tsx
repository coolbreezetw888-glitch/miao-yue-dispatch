// SPECS-INDEX #1005(第 14 批,2026-10-07)/ #1012(第 18 批,2026-10-08):行事曆時間軸預約卡片的內容
// —— 商家端與服務人員端共用。
// #1012 使用者裁決(選比較圖 B + 三點調整):
//   ・時間標籤在左上角,**固定**半透明白底(75%)+ 深色字,不隨狀態色變
//   ・白色半透明虛線
//   ・客戶姓名白字、粗體,太長截斷加「…」
// #1017(第 20 批,使用者:「分隔線的位置是錯的,應該要在正中間」):
//   ・虛線改在卡片**垂直正中間**(50% 高度),不再緊貼時間標籤下方
//   ・上半部:時間標籤靠左上;下半部:姓名在下半部上下左右置中
//   ・做法:上半 / 下半各 flex-1 + basis-0(等分),中間夾一條 1px 虛線、不留上下 margin
//     ⇒ 虛線中心 = 內容區正中間;兩端卡片上下框、上下內距對稱(border 1px + p-1),所以也是卡片正中間。
//   ・上半部高度放不下時間標籤時(目前門檻 41px 下不會發生,最矮 45 分鐘卡上半約 15.5px > 標籤 12px),
//     上半部不准縮到比時間標籤矮(min-height:auto),虛線會被往下推 —— 以時間標籤不被裁切為準。
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
      {/* 上半部:時間標籤靠左上。不加 min-h-0 —— 放不下標籤時寧可把虛線往下推,也不裁切標籤。 */}
      <span data-booking-block-top="" className="flex flex-1 basis-0 items-start">
        {timeLabel}
      </span>
      <span
        aria-hidden="true"
        data-booking-block-divider=""
        className="block shrink-0 border-t border-dashed border-[rgba(255,255,255,0.6)]"
      />
      {/* 下半部:姓名上下左右置中。 */}
      <span
        data-booking-block-bottom=""
        className="flex min-h-0 min-w-0 flex-1 basis-0 items-center justify-center overflow-hidden"
      >
        {nameText}
      </span>
    </span>
  );
}
