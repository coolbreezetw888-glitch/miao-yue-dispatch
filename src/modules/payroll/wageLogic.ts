// #1035 彈性計薪 B 批(日薪／時薪制)— 前端純函式(顯示用;金額一律由資料庫算,這裡只負責排版文字)。
// 規格書:母版 .project/specs/彈性計薪.md PB-B02、PB-U02。
//
// 🔴 上工時間、金額都不在前端算:報表數字一律來自 get_staff_wage_by_range / get_merchant_billing_summary_by_range。
//    唯一的例外是設定區的「試算小計算機」(PB-U02),它只是說明文字,算式跟資料庫 PB-R02 同一條
//    (分鐘 × 時薪 ÷ 60,四捨五入到元)。

import type { StaffCompensationType } from "@/modules/staff-agent/types";

import type { StaffWageByRange, StaffWageDay, WageDayState } from "./types";

/** 上工分鐘 ⇒「37 小時 20 分」/「3 小時」/「45 分」/「0 分」。 */
export function formatWorkedMinutes(minutes: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(minutes ?? 0)));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} 分`;
  if (rest === 0) return `${hours} 小時`;
  return `${hours} 小時 ${rest} 分`;
}

/** 金額千分位(最多 2 位小數,整數不帶小數點)。 */
export function formatWageMoney(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0);
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

/** 金額輸入框旁邊的單位。 */
export function wageUnitLabel(type: "daily_wage" | "hourly_wage"): string {
  return type === "daily_wage" ? "元／天" : "元／小時";
}

/** 每天明細的狀態屬性標籤文字。 */
export const WAGE_DAY_STATE_LABELS: Record<WageDayState, string> = {
  settled: "已結算",
  estimated: "預估",
  unsettled: "尚未結算",
};

/** 時薪試算(PB-U02 小計算機):跟資料庫同一條算式 —— 分鐘 × 時薪 ÷ 60,四捨五入到元。 */
export function computeHourlyPay(minutes: number, hourlyRate: number): number {
  if (
    !Number.isFinite(minutes) ||
    !Number.isFinite(hourlyRate) ||
    minutes <= 0 ||
    hourlyRate <= 0
  ) {
    return 0;
  }
  return Math.round((minutes * hourlyRate) / 60);
}

/** 試算說明句:「時薪 200 元 × 2 小時 20 分 = 467 元」。 */
export function hourlyPreviewText(hourlyRate: number, minutes: number): string {
  return `時薪 ${formatWageMoney(hourlyRate)} 元 × ${formatWorkedMinutes(minutes)} = ${formatWageMoney(
    computeHourlyPay(minutes, hourlyRate),
  )} 元`;
}

/** 試算小計算機用的固定範例:2 小時 20 分。 */
export const HOURLY_PREVIEW_EXAMPLE_MINUTES = 140;

/**
 * 服務人員報表最上面那行費率說明:
 *   日薪:「日薪 1,500 元 × 12 天」;時薪:「時薪 200 元」。
 *   區間內費率改過(天天不同)時,以最後一天的為準並加「(以最後一天的金額顯示)」。
 */
export function wageRateSummaryText(
  wage: Pick<StaffWageByRange, "days" | "work_days">,
): string | null {
  const days = wage.days;
  if (days.length === 0) return null;
  const last = days[days.length - 1]!;
  const changed = days.some(
    (d) =>
      d.compensation_type !== last.compensation_type ||
      Number(d.wage_amount) !== Number(last.wage_amount),
  );
  const suffix = changed ? "（以最後一天的金額顯示）" : "";
  if (last.compensation_type === "daily_wage") {
    return `日薪 ${formatWageMoney(last.wage_amount)} 元 × ${wage.work_days} 天${suffix}`;
  }
  return `時薪 ${formatWageMoney(last.wage_amount)} 元${suffix}`;
}

/** 每天明細的說明行:「時段 3 小時 30 分 ・ 時段外訂單 1 小時」/「請假(事假)」。 */
export function wageDayDetailText(day: StaffWageDay): string {
  if (day.is_leave) {
    return day.leave_type_name ? `請假（${day.leave_type_name}）` : "請假";
  }
  const parts = [`時段 ${formatWorkedMinutes(day.shift_minutes)}`];
  if (day.extra_booking_minutes > 0) {
    parts.push(`時段外訂單 ${formatWorkedMinutes(day.extra_booking_minutes)}`);
  }
  parts.push(`合計 ${formatWorkedMinutes(day.worked_minutes)}`);
  return parts.join(" ・ ");
}

/** 「10/9（四）」這種短日期。 */
export function formatWageDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  return `${m}/${d}（${weekday}）`;
}

/** 計酬方式下拉下方的說明(選日薪／時薪時,PB-U01)。 */
export const WAGE_COMPENSATION_HELP =
  "上工時間照行事曆的可預約時段自動計算，請假那天不算。金額請到「抽成與薪資設定」設定。";

/** 改計酬方式時的提醒(風險 2,⚠️)。 */
export const COMPENSATION_MID_MONTH_NOTE = "月中更改時，月薪以月底當時的計酬方式計算整個月。";

/** 從日薪改時薪(或反過來)時的提醒(PB-D02)。 */
export const WAGE_TYPE_CHANGED_NOTE = "計酬方式改了，請確認金額。";

/** 日薪↔時薪互換(金額不會自動換算)。 */
export function isWageTypeSwitch(
  from: StaffCompensationType | null | undefined,
  to: StaffCompensationType | null | undefined,
): boolean {
  return (
    (from === "daily_wage" && to === "hourly_wage") ||
    (from === "hourly_wage" && to === "daily_wage")
  );
}

/** 服務人員端「我的時段」頁:日薪／時薪的人看到的說明(PB-U04 ⚠️)。 */
export const WAGE_STAFF_AVAILABILITY_NOTE = "你的上工時間照店家排的時段計算，要調整請聯絡店家。";
