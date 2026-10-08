// 客戶端第 3 批(C3-E01):「線上預約」「訪客預約」標籤(訂單列表、預約詳細、服務人員端詳細共用)。
// 樣式依 ui-overlay-patterns 二之四:線上預約 = 屬性(灰底安靜);訪客預約 = 待辦(黃底 + !,要店家自己打電話確認)。
import { AttributeTag, TodoTag } from "@/components/patterns";

import {
  CUSTOMER_BOOKING_SOURCE_LABELS,
  customerBookingSourceKind,
  type CustomerBookingSourceInput,
} from "./customerBookingSource";

export function CustomerBookingSourceTag({ booking }: { booking: CustomerBookingSourceInput }) {
  const kind = customerBookingSourceKind(booking);
  if (kind === "guest") {
    return (
      <TodoTag data-testid="booking-source-tag-guest">
        {CUSTOMER_BOOKING_SOURCE_LABELS.guest}
      </TodoTag>
    );
  }
  if (kind === "online") {
    return (
      <AttributeTag data-testid="booking-source-tag-online">
        {CUSTOMER_BOOKING_SOURCE_LABELS.online}
      </AttributeTag>
    );
  }
  return null;
}
