// 建單表單「日期時間選擇器」下方可選時段清單的計算邏輯(CalendarPage.tsx 的 BookingDateTimeField)。
//
// ─── 為什麼抽出來 ────────────────────────────────────────────────────────────
// 原本這段直接寫在 BookingDateTimeField 的 useMemo 裡,而且**只讀 available_windows**,
// 完全沒有用到同一份 get_merchant_day_schedule 資料裡的 on_leave 跟 availability_overrides。
//
// 造成的實際問題(2026-09-24 稽核抓到):
//   先幫師傅 A 登記 9/25 一整天請假 → 回行事曆 →「新增預約」→ 服務人員選 A → 日期選 9/25
//   → 展開時段清單,照常列出 A 平常的所有可預約時間(行事曆主畫面明明已經把 A 整欄灰掉了)
//   → 客服選了時間、把整張表單填完按送出,才被後端擋下「主要服務人員這天是休假日」。
//
// ─── 定位:體驗層引導,不是安全邊界 ─────────────────────────────────────────────
// 建單表單細節修正規格書第三節第 7 點:這裡的篩選只是「不要讓客服白填一整張表單才被擋下」,
// 真正擋住不合法時段的仍然是資料庫層的 create_booking/update_booking(這次沒有、也不該
// 因為前端補了引導就放寬後端的擋阻)。
//
// ─── 疊加規則(跟行事曆主畫面的背景格線完全一致,見 CalendarPage.tsx §5.3/§5.5 第 4 點)───
//   1. on_leave 不是 null(整天請假)→ 直接沒有任何可選時段
//   2. 時段起點必須讓「總工時」能完整放進某個 available_window(第一層商家營業時間 ∩
//      第二層服務人員可預約時段,後端算好的結果)
//   3. 這次預約會佔用到的每個半小時格子,只要有落在某個 availability_overrides 區間內而且
//      該區間 is_available=false(單日排休),這個起點就不列出來

import { minutesToTime, timeToMinutes } from "./dateUtils";

/** 只取用真正需要的欄位,故意不直接吃 DayScheduleStaffBlock 整包——這樣測試可以只組最小資料。 */
export interface BookingSlotOptionsInput {
  /** 後端算好的可預約區間(第一層商家營業時間 ∩ 第二層服務人員時段)。 */
  availableWindows: { start_time: string; end_time: string }[];
  /** 單日例外區間(已由後端合併相鄰同值的半小時格子)。 */
  availabilityOverrides: { start_time: string; end_time: string; is_available: boolean }[];
  /** 這位服務人員這一天是不是整天請假。 */
  onLeave: boolean;
  /** 目前已選服務項目的總工時(分鐘)。還沒選任何項目時是 0。 */
  totalDurationMinutes: number;
  /** 切格單位(分鐘),呼叫端傳 CalendarPage 的 SLOT_MINUTES。 */
  slotMinutes: number;
}

/**
 * 這次預約會佔用的範圍內,有沒有任何一個半小時格子被「單日排休」蓋掉。
 *
 * 判斷格子是否落在某個 override 區間內的條件,跟行事曆主畫面的背景格線逐字相同
 * (o.start_time <= 格子起點 且 o.end_time >= 格子終點,也就是「格子完整被區間包住」),
 * 兩邊要保持一致,否則會出現「主畫面灰掉但建單清單列得出來」這種前後矛盾。
 */
function isBlockedByUnavailableOverride(
  rangeStartMinutes: number,
  rangeEndMinutes: number,
  overrides: BookingSlotOptionsInput["availabilityOverrides"],
  slotMinutes: number,
): boolean {
  for (let m = rangeStartMinutes; m < rangeEndMinutes; m += slotMinutes) {
    const slotEnd = m + slotMinutes;
    const matched = overrides.find(
      (o) => timeToMinutes(o.start_time) <= m && timeToMinutes(o.end_time) >= slotEnd,
    );
    if (matched && !matched.is_available) return true;
  }
  return false;
}

/** 回傳可選的起始時間字串清單(例如 ["09:00", "09:30", ...]),已排序、已去重。 */
export function buildBookingSlotOptions({
  availableWindows,
  availabilityOverrides,
  onLeave,
  totalDurationMinutes,
  slotMinutes,
}: BookingSlotOptionsInput): string[] {
  // 規則 1:整天請假直接沒有任何可選時段(由呼叫端另外顯示「這位服務人員這天休假」的說明文字)。
  if (onLeave) return [];

  // 還沒選任何服務項目時總工時是 0,此時至少用一個格子的長度去檢查單日排休,
  // 讓畫面跟行事曆主畫面「這格是灰的」保持一致(不會出現主畫面灰掉、這裡卻列得出來)。
  // 注意:這個放大只用在「檢查排休」,不影響下面「能不能塞進 available_window」的判斷,
  // 所以不會改變總工時為 0 時原本列得出來的那些起點。
  const occupiedLength = Math.max(totalDurationMinutes, slotMinutes);

  const starts = new Set<string>();
  for (const w of availableWindows) {
    const windowStart = timeToMinutes(w.start_time);
    const windowEnd = timeToMinutes(w.end_time);
    // 規則 2:總工時要能完整放進這個區間(維持既有行為,逐字沿用原本的迴圈條件)。
    for (let m = windowStart; m + totalDurationMinutes <= windowEnd; m += slotMinutes) {
      // 規則 3:佔用範圍內有任何一格是單日排休,就不列出這個起點。
      if (
        isBlockedByUnavailableOverride(m, m + occupiedLength, availabilityOverrides, slotMinutes)
      ) {
        continue;
      }
      starts.add(minutesToTime(m));
    }
  }
  return Array.from(starts).sort();
}
