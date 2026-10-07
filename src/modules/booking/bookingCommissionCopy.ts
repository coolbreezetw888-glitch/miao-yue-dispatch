// SPECS-INDEX #996(第 11 批 K):預約詳情「服務人員抽成」區塊的文案與小工具。
// 獨立成一個檔案,讓測試可以直接比對文案,也避免元件檔匯出非元件(react-refresh 規則)。
import { isoToTaipeiDateKey, isoToTaipeiTime } from "./dateUtils";

export const BOOKING_COMMISSION_COPY = {
  sectionLabel: "服務人員抽成",
  currentLabel: "目前抽成",
  lastComputed: (text: string) => `最後計算：${text}`,
  button: "重新計算抽成",
  noRecord: "這筆訂單沒有抽成紀錄(月薪制服務人員或完成時沒有產生)，不能重新計算。",
  notPieceRate: "這位服務人員目前不是抽成制，無法重新計算抽成。",
  loadError: "讀不到這筆訂單的抽成",
  confirmTitle: "重新計算這筆訂單的抽成？",
  confirmBody: (current: string) =>
    `會用目前的抽成比例和「料錢影響抽成」設定，依這筆訂單當時的金額與料錢重新算一次，並取代原本的抽成(目前 ${current})。服務人員報表會跟著變，這個動作不能復原。`,
  confirmCancel: "取消",
  confirmAction: "重新計算",
  confirmBusy: "計算中⋯",
  successChanged: (from: string, to: string) => `抽成已重新計算：${from} → ${to}`,
  successSame: (amount: string) => `抽成已重新計算，金額沒有變動(${amount})`,
  failTitle: "重新計算失敗",
} as const;

/** 後端這幾句代表「訂單或服務人員的狀態已經變了」(多半是別人剛還原 / 取消 / 改計酬)⇒ 重抓詳情與總額。 */
export const BOOKING_COMMISSION_STATE_CHANGED_MESSAGES = [
  "只有已完成的訂單才能重新計算抽成",
  "這筆訂單目前沒有抽成紀錄",
  "這位服務人員目前不是抽成制",
];

export function bookingCommissionSummaryQueryKey(bookingId: string | null) {
  return ["payroll-module", "booking-commission-summary", bookingId] as const;
}

/** 「最後計算：YYYY/MM/DD HH:MM」(台北時間)。 */
export function formatCommissionComputedAt(iso: string): string {
  return `${isoToTaipeiDateKey(iso).replace(/-/g, "/")} ${isoToTaipeiTime(iso)}`;
}
