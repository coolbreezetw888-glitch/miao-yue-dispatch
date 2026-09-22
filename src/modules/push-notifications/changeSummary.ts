// 模組 15(服務人員推播通知)規則 4.5:訂單內容異動的通知文字,由前端在呼叫 update_booking
// 之前先算好一句話摘要。純函式,方便 Vitest 測試,不依賴任何 React/Supabase 呼叫。
//
// 判斷優先順序(規則 4.5 第 2 點):先看時間有沒有變 → 再看服務項目有沒有變 → 再看服務人員指派
// 有沒有變 → 都沒有明顯差異就用通用文字。如果同時改了好幾項,不逐一列出,直接用通用文字,
// 避免推播內文塞進一大段列點式文字被截斷成看不懂的殘缺句子。

const GENERIC_MULTI_CHANGE_TEXT = "您的預約內容已更新,請至系統查看最新內容";
const MAX_SUMMARY_LENGTH = 60;

export interface BookingChangeSummaryInput {
  original: {
    startAt: string;
    serviceItemIds: string[];
    staffId: string;
  };
  next: {
    startAt: string;
    serviceItemIds: string[];
    staffId: string;
    /** 新的服務人員姓名,只有服務人員被改派時才需要,用來組成「服務人員改為王小明」這句話。 */
    staffName?: string | null;
    /** 新的服務時間顯示文字(例如 "09/26 15:00"),已經是格式化過的字串,這裡不重新處理時區。 */
    formattedStartAt?: string;
    /** 新的服務項目名稱清單(依畫面顯示順序),用來組成「服務項目改為洗剪+燙髮」這句話。 */
    serviceNames?: string[];
  };
}

function sameServiceItemSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, index) => id === sortedB[index]);
}

/** 判斷「使用者這次改動最主要的欄位」,回傳哪個欄位有變動(用於決定要不要當作唯一一項顯示)。
 * 回傳陣列長度 0 代表沒有明顯差異,1 代表只改了一項,>=2 代表同時改了好幾項。 */
export function detectChangedFields(input: BookingChangeSummaryInput): Array<"time" | "service" | "staff"> {
  const changed: Array<"time" | "service" | "staff"> = [];
  if (input.original.startAt !== input.next.startAt) changed.push("time");
  if (!sameServiceItemSet(input.original.serviceItemIds, input.next.serviceItemIds)) changed.push("service");
  if (input.original.staffId !== input.next.staffId) changed.push("staff");
  return changed;
}

/** 規則 4.5 核心:組出一句話摘要,上限 60 字(超過在前端就先截斷)。 */
export function computeBookingChangeSummary(input: BookingChangeSummaryInput): string {
  const changed = detectChangedFields(input);

  let summary: string;
  if (changed.length === 0) {
    summary = GENERIC_MULTI_CHANGE_TEXT;
  } else if (changed.length > 1) {
    summary = GENERIC_MULTI_CHANGE_TEXT;
  } else if (changed[0] === "time") {
    summary = `預約時間改為 ${input.next.formattedStartAt ?? input.next.startAt}`;
  } else if (changed[0] === "service") {
    const names = input.next.serviceNames && input.next.serviceNames.length > 0
      ? input.next.serviceNames.join("+")
      : "";
    summary = names ? `服務項目改為 ${names}` : GENERIC_MULTI_CHANGE_TEXT;
  } else {
    // changed[0] === "staff"
    const name = input.next.staffName?.trim();
    summary = name ? `服務人員改為 ${name}` : GENERIC_MULTI_CHANGE_TEXT;
  }

  return summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH) : summary;
}
