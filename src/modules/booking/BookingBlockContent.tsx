// SPECS-INDEX #1005(第 14 批,2026-10-07):行事曆時間軸預約卡片的內容 —— 商家端與服務人員端共用。
// 使用者裁決(截圖 17):上面開始時間(小標籤)、中間一條虛線、下面客戶名字。
// 半小時(一格高)放不下三層 ⇒ 時間與名字排同一行、不畫虛線(門檻見 bookingBlockLayout.ts)。
// 顏色全部跟著卡片本身的文字色(currentColor = 狀態色),不另外寫死任何顏色。

import { bookingBlockLayout } from "./bookingBlockLayout";
import { isoToTaipeiTime } from "./dateUtils";

export function BookingBlockContent({
  startAt,
  name,
  height,
}: {
  /** 預約開始時間(ISO),顯示成台北時間 HH:mm。 */
  startAt: string;
  /** 卡片下方顯示的文字(客戶名字;協助卡已經帶「(協助)」)。 */
  name: string;
  /** 卡片高度(px),決定排三層還是一行。 */
  height: number | undefined;
}) {
  const layout = bookingBlockLayout(height);
  const timeLabel = (
    <span
      data-booking-block-time=""
      className="inline-block shrink-0 rounded border border-current/40 bg-card px-1 text-[10px] font-semibold leading-[12px] tabular-nums"
    >
      {isoToTaipeiTime(startAt)}
    </span>
  );

  if (layout === "inline") {
    return (
      <span data-booking-block-layout="inline" className="flex min-w-0 items-center gap-1">
        {timeLabel}
        <span className="min-w-0 truncate font-medium">{name}</span>
      </span>
    );
  }

  return (
    <span data-booking-block-layout="stacked" className="flex min-w-0 flex-col">
      <span className="flex">{timeLabel}</span>
      <span
        aria-hidden="true"
        data-booking-block-divider=""
        className="my-0.5 block border-t border-dashed border-current/50"
      />
      <span className="min-w-0 truncate font-medium">{name}</span>
    </span>
  );
}
