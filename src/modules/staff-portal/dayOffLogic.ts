// 對應規格書 v2 §10.3.4:「本月已排休天數」與「這天是不是整天排休」的判斷邏輯。
// 純前端計算,不新增後端函式——給定某一天已抓回的 staff_availability_overrides 清單
// (來自既有 useMyAvailabilityOverrides,v1 既有對外介面 5.3),判斷「這天是不是整天排休」=
// 這天存在 48 筆例外紀錄(00:00 到 23:30 每半小時一筆)且全部 is_available=false。
// 這支純函式獨立寫、獨立單元測試,10.3.2(整天排休分頁判斷要不要高亮)/10.3.3(時段排休分頁
// 顯示計數文字)共用同一份邏輯,不各自重複實作一次判斷條件。

import type { StaffAvailabilityOverride } from "./api";

const SLOTS_PER_DAY = 48;

/** 給定「同一天」已抓回的例外紀錄,判斷這天是不是「整天排休」。 */
export function isWholeDayOff(overridesForDate: StaffAvailabilityOverride[]): boolean {
  if (overridesForDate.length !== SLOTS_PER_DAY) return false;
  return overridesForDate.every((o) => o.is_available === false);
}

/** 把一批例外紀錄依 override_date 分組,供下面的計數/判斷函式共用。 */
export function groupOverridesByDate(
  overrides: StaffAvailabilityOverride[],
): Map<string, StaffAvailabilityOverride[]> {
  const map = new Map<string, StaffAvailabilityOverride[]>();
  for (const o of overrides) {
    const list = map.get(o.override_date) ?? [];
    list.push(o);
    map.set(o.override_date, list);
  }
  return map;
}

/** 給定某個特定日期(YYYY-MM-DD)跟一批(可能跨很多天的)例外紀錄,判斷那一天是不是整天排休。 */
export function isDateWholeDayOff(overrides: StaffAvailabilityOverride[], dateKey: string): boolean {
  return isWholeDayOff(overrides.filter((o) => o.override_date === dateKey));
}

/** 「本月已排休天數」= 當月(year/month,month 為 1-12)月曆範圍內符合「整天排休」的日期數量。
 * 只計算 override_date 落在該年月的紀錄,不算月曆格線補進來的上下月日期。 */
export function countWholeDaysOffInMonth(
  overrides: StaffAvailabilityOverride[],
  year: number,
  month: number,
): number {
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const grouped = groupOverridesByDate(overrides);
  let count = 0;
  for (const [dateKey, list] of grouped) {
    if (!dateKey.startsWith(monthPrefix)) continue;
    if (isWholeDayOff(list)) count += 1;
  }
  return count;
}
