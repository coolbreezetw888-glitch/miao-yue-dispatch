// 商家端三項調整規格書 §3.6(店家帳務報表)/服務人員端規格書 §15.2(服務人員個人薪資報表比照
// 辦理):時間篩選從單一年/月改成可選區間,最長一年。這裡是純函式部分,供 DateRangePicker.tsx
// 的 UI 邏輯、BillingReportPage.tsx/MyPayrollPage.tsx 的送出前驗證共用,方便獨立測試。
//
// MAX_RANGE_DAYS 的判斷公式刻意跟資料庫 get_merchant_billing_summary_by_range/
// get_staff_monthly_payroll_summary_by_range/get_staff_commission_summary_by_range 內部的
// `p_end_date - p_start_date > 366` 這個後端保護完全對齊(同一套公式,不是「前端算 inclusive
// 天數」這種容易跟後端差 1 天的算法)——這裡故意也用「結束日期 - 起始日期」的原始天數差,不是
// inclusive 的總天數,確保前端擋下的臨界值跟後端會不會噴錯的臨界值一致。

/** 跟資料庫 `p_end_date - p_start_date <= 366` 對齊的區間上限(原始天數差,不是 inclusive 總天數)。 */
export const MAX_RANGE_RAW_DAYS = 366;

/** 兩個 YYYY-MM-DD 字串的原始天數差(end - start),跟 PostgreSQL `date - date` 的語意一致。 */
export function rawDateDiffDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

/** 驗證起訖日期是否合法,回傳錯誤訊息(null 代表合法)。錯誤文案刻意跟後端 raise exception 的
 * 文字對齊,讓使用者在前端看到的提示,跟萬一繞過前端、後端擋下時看到的錯誤訊息一致。 */
export function validateDateRange(startDate: string, endDate: string): string | null {
  if (!startDate || !endDate) return "請選擇起訖日期";
  const diff = rawDateDiffDays(startDate, endDate);
  if (diff < 0) return "結束日期不能早於起始日期";
  if (diff > MAX_RANGE_RAW_DAYS) return "最長只能查詢一年範圍";
  return null;
}

/** "YYYY-MM" → 該月第一天 "YYYY-MM-01"。 */
export function firstDayOfMonth(monthStr: string): string {
  return `${monthStr}-01`;
}

/** "YYYY-MM" → 該月最後一天,邏輯跟資料庫 private.get_days_in_month 對齊。 */
export function lastDayOfMonth(monthStr: string): string {
  const parts = monthStr.split("-");
  const year = Number(parts[0] ?? 0);
  const month = Number(parts[1] ?? 0);
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthStr}-${String(lastDay).padStart(2, "0")}`;
}

/** Date 物件 → "YYYY-MM-DD"(用本地時間,不是 UTC,避免 toISOString() 在時區邊界跨日的問題)。 */
export function toISODateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 預設區間:本月 1 號 ~ 今天(比照原本 YearMonthPicker 預設「當月」的習慣,只是改成一個具體的
 * 起訖日期區間)。 */
export function defaultDateRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { startDate: toISODateString(start), endDate: toISODateString(now) };
}
