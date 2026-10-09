// #1035 追加(使用者 2026-10-09 選 B):服務人員端「我的薪資報表」的預設查詢區間。
//
// 獎金只算「完整月份」,原本預設的「本月 1 號到今天」永遠不是完整月份 ⇒ 有獎金方案的人一進來只看到
// 「這幾個月不是完整月份，不計算獎金」。所以(主腦 2026-10-09 裁決):
//   ・本人目前是月薪制、而且**上個月(月底當時)有獎金方案** ⇒ 預設改成「上個月整月」、區間單位「按月份」,
//     一進來就看得到上個月的獎金。
//   ・其他人(沒有方案、只有本月才剛有方案、或不是月薪制)⇒ 維持原本的「本月 1 號到今天」、「按日期」,
//     畫面完全不變。(本月才剛有方案的人跳到上個月也看不到獎金,所以不跳。)
// 商家端「服務人員報表」不走這裡,不受影響。
//
// 「上個月有沒有方案」用 get_staff_bonus_by_range(上個月 1 號 ~ 上個月最後一天)的 has_any_plan 判斷:
//   區間只有上個月一個完整月份 ⇒ has_any_plan 就是「上個月月底當時有沒有方案」。

import type { DateRangeGranularity } from "@/modules/payroll/DateRangePicker";
import { defaultDateRange, previousMonthRange } from "@/modules/payroll/dateRangeUtils";

export interface MyPayrollInitialRange {
  startDate: string;
  endDate: string;
  granularity: DateRangeGranularity;
}

/** 用來判斷「上個月有沒有獎金方案」的查詢區間:上個月整月。 */
export function bonusPlanProbeRange(): { startDate: string; endDate: string } {
  return previousMonthRange();
}

/** 只有月薪制才可能有獎金,也只有月薪制的報表會顯示獎金區塊。 */
export function shouldProbeBonusPlan(compensationType: string | null | undefined): boolean {
  return compensationType === "monthly_salary";
}

/** 決定預設區間。hasBonusPlan(上個月月底有方案)為 true 且目前月薪制 ⇒ 上個月整月 + 按月份;否則照舊。 */
export function myPayrollInitialRange(input: {
  compensationType: string | null | undefined;
  hasBonusPlan: boolean;
}): MyPayrollInitialRange {
  if (shouldProbeBonusPlan(input.compensationType) && input.hasBonusPlan) {
    return { ...previousMonthRange(), granularity: "month" };
  }
  return { ...defaultDateRange(), granularity: "day" };
}
