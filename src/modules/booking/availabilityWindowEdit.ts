// SPECS-INDEX #1024(第 22 批):服務人員每週可預約時段「直接調開始 / 結束時間」的純邏輯。
// 商家端(編輯服務人員 → 可預約時段)與服務人員端(休假設定 → 每週固定可預約時段)共用。
// 資料庫(private.tg_staff_availability_windows_validate)也擋同樣兩條,訊息一字不差;
// 這裡先擋是為了不用送出去才知道錯。

import { timeToMinutes } from "./dateUtils";
import { DAY_OF_WEEK_LABELS } from "./types";

export interface EditableAvailabilityWindow {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

/** "09:00:00" / "09:00" ⇒ "09:00"(畫面上的時間欄位只吃 HH:MM)。 */
export function toHhMm(time: string): string {
  return time.slice(0, 5);
}

/** 卡片標題:「星期三 13:00 - 17:00」(= 目前存著的值;e2e 也用這串字找卡片)。 */
export function availabilityWindowRangeLabel(w: {
  day_of_week: number;
  start_time: string;
  end_time: string;
}): string {
  return `星期${DAY_OF_WEEK_LABELS[w.day_of_week]} ${toHhMm(w.start_time)} - ${toHhMm(w.end_time)}`;
}

/** 跟資料庫一樣的寫法:24:00:00 顯示成 24:00。 */
function label(time: string): string {
  return toHhMm(time);
}

function checkWindow(
  windows: readonly EditableAvailabilityWindow[],
  excludeId: string | null,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
): string | null {
  if (!startTime || !endTime) return "請填寫開始與結束時間";
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start >= end) return "開始時間必須早於結束時間";
  const clash = windows
    .filter((w) => w.id !== excludeId && w.day_of_week === dayOfWeek)
    .filter((w) => timeToMinutes(w.start_time) < end && start < timeToMinutes(w.end_time))
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))[0];
  if (clash) {
    return `這個時段跟同一天已設定的「${label(clash.start_time)}–${label(clash.end_time)}」重疊，請調整時間。`;
  }
  return null;
}

/**
 * 把某一組時段改成 [startTime, endTime) 之前的檢查;沒問題回 null,有問題回要顯示的那一句話。
 * 規則(沿用既有 + 規格):開始 < 結束;同一位服務人員同一天的其他時段不能重疊(相接不算)。
 * 營業時間不擋 —— 既有規則本來就允許時段超出營業時間(行事曆會自動取交集),這次不新增。
 */
export function validateAvailabilityWindowEdit(
  windows: readonly EditableAvailabilityWindow[],
  windowId: string,
  startTime: string,
  endTime: string,
): string | null {
  const self = windows.find((w) => w.id === windowId);
  if (!self) return checkWindow([], null, -1, startTime, endTime);
  return checkWindow(windows, windowId, self.day_of_week, startTime, endTime);
}

/**
 * 主腦裁決(第 22 批):「新增時段」也一樣不能跟同一天已設定的時段重疊,訊息跟編輯時一字不差
 * (資料庫 trigger 新增 / 修改都擋)。
 */
export function validateNewAvailabilityWindow(
  windows: readonly EditableAvailabilityWindow[],
  dayOfWeek: number,
  startTime: string,
  endTime: string,
): string | null {
  return checkWindow(windows, null, dayOfWeek, startTime, endTime);
}
