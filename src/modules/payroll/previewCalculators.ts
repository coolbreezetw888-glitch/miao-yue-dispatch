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

/** 商家端三項調整規格書 §二 2.8.2:服務項目層級抽成的即時預覽計算機,取代原本只支援單一百分比
 * 模式的 previewCommissionAmount。percentage 模式:基準 × 比例;fixed_amount 模式:固定金額 ×
 * 件數,不受基準金額影響。四捨五入到分,跟資料庫 calculate_booking_staff_commission 的公式對齊。 */
export function previewServiceCommission(
  basePrice: number,
  mode: "percentage" | "fixed_amount",
  value: number,
  quantity = 1,
): number {
  if (!Number.isFinite(basePrice) || !Number.isFinite(value) || !Number.isFinite(quantity)) {
    return 0;
  }
  if (mode === "fixed_amount") {
    return roundToCents(value * quantity);
  }
  return roundToCents((basePrice * quantity * value) / 100);
}

/** 月折算天數換算成「一天薪水」(對應規則 2.7 的 day_rate)。payDaysPerMonth <= 0 時視為 0,
 * 避免除以 0(正常情況下 §十 10.1 動態計算出來的天數一定是 28~31,這裡只是前端防呆)。 */
export function calculateDayRate(monthlyBaseSalary: number, payDaysPerMonth: number): number {
  if (!Number.isFinite(monthlyBaseSalary) || !Number.isFinite(payDaysPerMonth) || payDaysPerMonth <= 0) {
    return 0;
  }
  return monthlyBaseSalary / payDaysPerMonth;
}

/** §十 10.1:「月折算天數」已改成系統依「當月實際天數」自動計算,不再是商家填寫的固定值
 * (merchant_payroll_settings.pay_days_per_month 已移除)。前端預覽計算機用這個純函式算出某年月
 * 的實際天數,邏輯跟資料庫 private.get_days_in_month 對齊(用 JS Date 的「該月第 0 天 = 上個月
 * 最後一天」特性取得月底日期,不用自己手刻閏年判斷)。month 是 1~12(跟資料庫函式的參數習慣一致,
 * 不是 JS Date 原生 0~11 的月份)。 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
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
