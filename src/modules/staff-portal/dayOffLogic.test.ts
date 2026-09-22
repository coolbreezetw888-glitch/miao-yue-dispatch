// 對應規格書 v2 §10.3.4:「整天排休」判斷邏輯是這次休假設定重新設計的核心前端邏輯
// (決定要不要高亮月曆日期、決定「本月已排休 N 天」這個數字對不對),依 ARCHITECTURE.md
// 第八節第 5 條/automated-testing SKILL 的要求,這類判斷邏輯要寫 Vitest,不是只靠肉眼看畫面。

import { describe, expect, it } from "vitest";

import type { StaffAvailabilityOverride } from "./api";
import { countWholeDaysOffInMonth, isDateWholeDayOff, isWholeDayOff } from "./dayOffLogic";

function makeSlot(
  overrideDate: string,
  slotStartTime: string,
  isAvailable: boolean,
): StaffAvailabilityOverride {
  return {
    id: `${overrideDate}-${slotStartTime}`,
    staff_id: "staff-1",
    override_date: overrideDate,
    slot_start_time: slotStartTime,
    is_available: isAvailable,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as StaffAvailabilityOverride;
}

/** 產生某一天完整 48 格的例外紀錄(00:00 到 23:30,每半小時一筆)。 */
function makeFullDay(overrideDate: string, isAvailable: boolean): StaffAvailabilityOverride[] {
  const slots: StaffAvailabilityOverride[] = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    const h = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push(makeSlot(overrideDate, `${h}:${mm}:00`, isAvailable));
  }
  return slots;
}

describe("isWholeDayOff", () => {
  it("48 格全部 is_available=false 時判定為整天排休", () => {
    expect(isWholeDayOff(makeFullDay("2026-11-10", false))).toBe(true);
  });

  it("缺一筆(只有 47 格)時不算整天排休", () => {
    const slots = makeFullDay("2026-11-10", false).slice(0, 47);
    expect(isWholeDayOff(slots)).toBe(false);
  });

  it("48 格裡有一筆是 is_available=true 時不算整天排休", () => {
    const slots = makeFullDay("2026-11-10", false);
    slots[10] = makeSlot("2026-11-10", slots[10]!.slot_start_time, true);
    expect(isWholeDayOff(slots)).toBe(false);
  });

  it("完全沒有例外紀錄(0 格)不算整天排休", () => {
    expect(isWholeDayOff([])).toBe(false);
  });
});

describe("isDateWholeDayOff", () => {
  it("從混合多天的例外清單裡正確篩出指定那一天再判斷", () => {
    const overrides = [
      ...makeFullDay("2026-11-10", false),
      ...makeFullDay("2026-11-11", true), // 額外開放,不是排休
    ];
    expect(isDateWholeDayOff(overrides, "2026-11-10")).toBe(true);
    expect(isDateWholeDayOff(overrides, "2026-11-11")).toBe(false);
    expect(isDateWholeDayOff(overrides, "2026-11-12")).toBe(false); // 完全沒有紀錄
  });
});

describe("countWholeDaysOffInMonth", () => {
  it("正確算出當月符合整天排休條件的天數", () => {
    const overrides = [
      ...makeFullDay("2026-11-01", false),
      ...makeFullDay("2026-11-15", false),
      ...makeFullDay("2026-11-20", true), // 額外開放,不算排休
    ];
    expect(countWholeDaysOffInMonth(overrides, 2026, 11)).toBe(2);
  });

  it("跨月邊界:只算當月的天數,不算月曆格線補進來的上下月日期", () => {
    const overrides = [
      ...makeFullDay("2026-10-31", false), // 上個月最後一天
      ...makeFullDay("2026-11-01", false), // 這個月第一天
      ...makeFullDay("2026-12-01", false), // 下個月第一天
    ];
    expect(countWholeDaysOffInMonth(overrides, 2026, 11)).toBe(1);
  });

  it("沒有任何符合條件的資料時回傳 0", () => {
    expect(countWholeDaysOffInMonth([], 2026, 11)).toBe(0);
  });
});
