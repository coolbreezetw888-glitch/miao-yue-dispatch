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

// ---------------------------------------------------------------------------
// 2026-09-24 使用者裁決(月薪只在「完整月份」的查詢下才計算):店家帳務報表的時間篩選預設改成
// 「月份」顆粒度(本月 / 上個月 / 指定月份),只有切到「自訂區間」才用任意起訖日期。
//
// 為什麼要有這一組「完整月份」專用的函式,而不是沿用上面的 defaultDateRange():
//   defaultDateRange() 是「本月 1 號 ~ **今天**」,月中查詢時結束日期不是月底,也就不是一個
//   完整月份;而月薪本質上是「一整個月」這個單位,資料庫端的 salary_applicable 判斷正是
//   「起始日是某月 1 號 且 結束日是某月最後一天」。所以「本月」這個選項一律取到**月底**
//   (未來的日期還沒有訂單,營收加總是 0,不影響數字正確性),這樣月薪相關數字才算得出來。
//
// 這幾支都是純函式,月份字串一律用 "YYYY-MM",跟 <Input type="month"> 的原生值格式一致,
// 也跟上面既有的 firstDayOfMonth/lastDayOfMonth 共用同一套月底判斷邏輯,不另造一套。
// ---------------------------------------------------------------------------

/** Date 物件 → "YYYY-MM"(本地時間,理由同 toISODateString)。 */
export function toMonthString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** "YYYY-MM" → 該月份的完整區間(1 號 ~ 該月最後一天)。 */
export function monthRange(monthStr: string): { startDate: string; endDate: string } {
  return { startDate: firstDayOfMonth(monthStr), endDate: lastDayOfMonth(monthStr) };
}

/** 今天所在月份的完整區間(1 號 ~ 月底,刻意不是「~ 今天」,理由見本區塊開頭說明)。 */
export function currentMonthRange(): { startDate: string; endDate: string } {
  return monthRange(toMonthString(new Date()));
}

/** 上一個月的完整區間。用 `new Date(年, 月-1, 1)` 往前推,跨年(1 月 → 前一年 12 月)由
 * Date 自己處理,不用自己算年份進位。 */
export function previousMonthRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const firstDayOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return monthRange(toMonthString(firstDayOfPreviousMonth));
}
