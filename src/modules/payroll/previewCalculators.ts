// 模組 8(薪資與帳務)§4.1:抽成與薪資設定頁的「即時預覽計算機」。
//
// 這裡全部是純函式,只給畫面上的白話試算用(例如「一筆服務金額 1000 元的訂單,這個人可以拿到
// 多少抽成」),不是任何寫入依據。真正的計算永遠以資料庫函式(compute_booking_commission/
// get_staff_monthly_payroll_summary)的結果為準——呼應這個專案「安全邊界/正確性一律在資料庫層
// 落實」的既定原則(§4.1 第 4 點)。四捨五入到分的作法刻意跟資料庫的 round(x, 2) 對齊,方便
// 使用者在畫面上看到的預覽數字跟之後資料庫實際算出來的數字一致,不會覺得「怎麼跟畫面上看到的
// 不一樣」。

/** 四捨五入到小數點第二位(分),跟資料庫 round(numeric, 2) 對齊。 */
export function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 抽成金額試算(對應規則 2.2):基準 × 比例,四捨五入到分。 */
export function previewCommissionAmount(baseAmount: number, ratePercentage: number): number {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(ratePercentage)) return 0;
  return roundToCents((baseAmount * ratePercentage) / 100);
}

/** 月折算天數換算成「一天薪水」(對應規則 2.7 的 day_rate)。pay_days_per_month <= 0 時視為 0,
 * 避免除以 0(正常情況下資料庫 CHECK 約束已經限制 1~31,這裡只是前端防呆)。 */
export function calculateDayRate(monthlyBaseSalary: number, payDaysPerMonth: number): number {
  if (!Number.isFinite(monthlyBaseSalary) || !Number.isFinite(payDaysPerMonth) || payDaysPerMonth <= 0) {
    return 0;
  }
  return monthlyBaseSalary / payDaysPerMonth;
}

export type DeductionMode =
  | "no_deduction"
  | "full_day_rate"
  | "percentage_of_day_rate"
  | "fixed_amount_per_day";

/** 假別扣款試算(對應規則 2.7 四種模式,單日金額,不乘天數——天數由畫面另外顯示/相乘)。 */
export function previewLeaveDeductionPerDay(
  dayRate: number,
  mode: DeductionMode,
  percentageValue: number | null,
  fixedAmountValue: number | null,
): number {
  switch (mode) {
    case "no_deduction":
      return 0;
    case "full_day_rate":
      return roundToCents(dayRate);
    case "percentage_of_day_rate":
      return roundToCents((dayRate * (percentageValue ?? 0)) / 100);
    case "fixed_amount_per_day":
      return roundToCents(fixedAmountValue ?? 0);
    default:
      return 0;
  }
}
