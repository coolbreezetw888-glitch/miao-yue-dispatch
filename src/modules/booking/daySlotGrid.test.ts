// SPECS-INDEX #977 第 7 批(2026-10-07):時間軸每一格狀態的純函式(商家端 / 服務人員端共用)。
//   ・resolveDaySlot:單日例外優先 → 可約區間 → 跨店佔用,輸出的 data-slot-state 跟搬家前 CalendarPage 的算法一樣
//   ・buildStaffDayAvailableWindows:服務人員端在前端算出的可約區間 = 資料庫 get_merchant_day_schedule 的 available_windows
//   ・同一組輸入,商家端(拿資料庫算好的 available_windows)與服務人員端(前端自己算)得到一樣的 data-slot-state
import { describe, expect, it } from "vitest";

import { buildStaffDayAvailableWindows, daySlotState, resolveDaySlot } from "./daySlotGrid";
import { minutesToTime, timeToMinutes } from "./dateUtils";

const WEEKLY = [
  { day_of_week: 3, start_time: "07:00:00", end_time: "12:00:00" },
  { day_of_week: 3, start_time: "14:00:00", end_time: "23:00:00" },
  { day_of_week: 4, start_time: "09:00:00", end_time: "18:00:00" },
];

describe("buildStaffDayAvailableWindows(對應資料庫 available_windows)", () => {
  it("每週時段跟營業時間取交集,只取這個星期幾", () => {
    expect(
      buildStaffDayAvailableWindows({
        hasSetting: true,
        isClosed: false,
        openTime: "09:00:00",
        closeTime: "20:00:00",
        unlimitedBackendEdit: false,
        dayOfWeek: 3,
        weeklyWindows: WEEKLY,
      }),
    ).toEqual([
      { start_time: "09:00:00", end_time: "12:00:00" },
      { start_time: "14:00:00", end_time: "20:00:00" },
    ]);
  });
  it("商家後台編輯無時段限制 ⇒ 整段營業時間", () => {
    expect(
      buildStaffDayAvailableWindows({
        hasSetting: true,
        isClosed: false,
        openTime: "09:00",
        closeTime: "20:00",
        unlimitedBackendEdit: true,
        dayOfWeek: 1,
        weeklyWindows: [],
      }),
    ).toEqual([{ start_time: "09:00", end_time: "20:00" }]);
  });
  it("公休 / 沒設定營業時間 ⇒ 空", () => {
    const base = {
      openTime: "09:00",
      closeTime: "20:00",
      unlimitedBackendEdit: true,
      dayOfWeek: 3,
      weeklyWindows: WEEKLY,
    };
    expect(buildStaffDayAvailableWindows({ ...base, hasSetting: true, isClosed: true })).toEqual(
      [],
    );
    expect(buildStaffDayAvailableWindows({ ...base, hasSetting: false, isClosed: false })).toEqual(
      [],
    );
  });
  it("完全落在營業時間外的每週時段不算", () => {
    expect(
      buildStaffDayAvailableWindows({
        hasSetting: true,
        isClosed: false,
        openTime: "13:00",
        closeTime: "14:00",
        unlimitedBackendEdit: false,
        dayOfWeek: 3,
        weeklyWindows: WEEKLY,
      }),
    ).toEqual([]);
  });
});

describe("resolveDaySlot", () => {
  const windows = [{ start_time: "10:00", end_time: "12:00" }];
  it("可約區間內 ⇒ available;區間外 ⇒ unavailable", () => {
    expect(
      resolveDaySlot({
        slotStartMin: 600,
        slotEndMin: 630,
        availableWindows: windows,
        overrides: [],
        foreignBookings: [],
      }).state,
    ).toBe("available");
    expect(
      resolveDaySlot({
        slotStartMin: 720,
        slotEndMin: 750,
        availableWindows: windows,
        overrides: [],
        foreignBookings: [],
      }).state,
    ).toBe("unavailable");
  });
  it("單日例外優先:區間內被關 ⇒ override-closed;區間外被開 ⇒ override-open", () => {
    expect(
      resolveDaySlot({
        slotStartMin: 600,
        slotEndMin: 630,
        availableWindows: windows,
        overrides: [{ start_time: "10:00", end_time: "10:30", is_available: false }],
        foreignBookings: [],
      }),
    ).toEqual({
      foreignBusy: false,
      isOverride: true,
      finalAvailable: false,
      state: "override-closed",
    });
    expect(
      resolveDaySlot({
        slotStartMin: 780,
        slotEndMin: 810,
        availableWindows: windows,
        overrides: [{ start_time: "13:00", end_time: "14:00", is_available: true }],
        foreignBookings: [],
      }).state,
    ).toBe("override-open");
  });
  it("跨店佔用優先顯示 cross-store-occupied", () => {
    expect(
      resolveDaySlot({
        slotStartMin: 600,
        slotEndMin: 630,
        availableWindows: windows,
        overrides: [],
        foreignBookings: [
          { start_at: "2036-03-12T02:15:00+00:00", end_at: "2036-03-12T03:00:00+00:00" },
        ],
      }).state,
    ).toBe("cross-store-occupied");
  });
  it("daySlotState 對照(搬家前的函式一字未改)", () => {
    expect(daySlotState(false, true)).toBe("available");
    expect(daySlotState(false, false)).toBe("unavailable");
    expect(daySlotState(true, true)).toBe("override-open");
    expect(daySlotState(true, false)).toBe("override-closed");
  });
});

describe("同一組輸入,商家端與服務人員端算出一樣的 data-slot-state", () => {
  it("整天每一格都一樣(商家端吃資料庫算好的 available_windows,服務人員端前端自己算)", () => {
    // 資料庫 get_merchant_day_schedule 對這組資料會回的 available_windows(營業 09:00–20:00 ∩ 週三兩段)。
    const merchantWindows = [
      { start_time: "09:00:00", end_time: "12:00:00" },
      { start_time: "14:00:00", end_time: "20:00:00" },
    ];
    // 商家端單日例外是合併後的區間;服務人員端是一格一列 —— 兩種形狀都要得到同一個結果。
    const merchantOverrides = [
      { start_time: "15:00:00", end_time: "16:00:00", is_available: false },
    ];
    const staffOverrides = [
      { start_time: "15:00:00", end_time: "15:30:00", is_available: false },
      { start_time: "15:30:00", end_time: "16:00:00", is_available: false },
    ];
    const staffWindows = buildStaffDayAvailableWindows({
      hasSetting: true,
      isClosed: false,
      openTime: "09:00:00",
      closeTime: "20:00:00",
      unlimitedBackendEdit: false,
      dayOfWeek: 3,
      weeklyWindows: WEEKLY,
    });
    for (let m = timeToMinutes("09:00"); m < timeToMinutes("20:00"); m += 30) {
      const a = resolveDaySlot({
        slotStartMin: m,
        slotEndMin: m + 30,
        availableWindows: merchantWindows,
        overrides: merchantOverrides,
        foreignBookings: [],
      });
      const b = resolveDaySlot({
        slotStartMin: m,
        slotEndMin: m + 30,
        availableWindows: staffWindows,
        overrides: staffOverrides,
        foreignBookings: [],
      });
      expect(`${minutesToTime(m)} ${b.state}`).toBe(`${minutesToTime(m)} ${a.state}`);
    }
  });
});
