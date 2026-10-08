// SPECS-INDEX #977 第 7 批(2026-10-07):時間軸每一格狀態的純函式(商家端 / 服務人員端共用)。
//   ・resolveDaySlot:單日例外優先 → 可約區間 → 跨店佔用,輸出的 data-slot-state 跟搬家前 CalendarPage 的算法一樣
//   ・buildStaffDayAvailableWindows:服務人員端在前端算出的可約區間 = 資料庫 get_merchant_day_schedule 的 available_windows
//   ・同一組輸入,商家端(拿資料庫算好的 available_windows)與服務人員端(前端自己算)得到一樣的 data-slot-state
import { describe, expect, it } from "vitest";

import {
  buildStaffDayAvailableWindows,
  canToggleDayOverride,
  countBookingsInSlot,
  daySlotState,
  planDayOverrideToggle,
  resolveDaySlot,
} from "./daySlotGrid";
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
      // #1004:另外帶出「不看例外時原本可不可以約」,給 planDayOverrideToggle 判斷要刪例外還是寫例外。
      templateAvailable: true,
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

// SPECS-INDEX #1004(第 14 批):點格子「關閉 → 再開啟」要恢復成白色 —— 開啟後回到每週時段原本的狀態時刪例外。
describe("planDayOverrideToggle(#1004)", () => {
  const windows = [{ start_time: "10:00", end_time: "12:00" }];
  const slotAt = (
    min: number,
    overrides: { start_time: string; end_time: string; is_available: boolean }[],
  ) =>
    resolveDaySlot({
      slotStartMin: min,
      slotEndMin: min + 30,
      availableWindows: windows,
      overrides,
      foreignBookings: [],
    });

  it("每週時段內、沒有例外(白色)⇒ 關閉 = 寫一筆 false 例外", () => {
    expect(planDayOverrideToggle(slotAt(600, []))).toEqual({ kind: "set", isAvailable: false });
  });
  it("🔴 每週時段內、被例外關掉(斜線)⇒ 開啟 = 刪掉例外(回到白色),不是寫一筆「例外開啟」", () => {
    const closed = slotAt(600, [{ start_time: "10:00", end_time: "10:30", is_available: false }]);
    expect(closed.state).toBe("override-closed");
    expect(planDayOverrideToggle(closed)).toEqual({ kind: "clear" });
  });
  it("每週時段外、沒有例外(灰色)⇒ 開啟 = 寫一筆 true 例外(這才是真的「例外開啟」)", () => {
    expect(planDayOverrideToggle(slotAt(780, []))).toEqual({ kind: "set", isAvailable: true });
  });
  it("🔴 反方向:每週時段外、被例外開啟 ⇒ 關閉 = 刪掉例外(回到原本灰色),不是寫一筆「例外關閉」(斜線)", () => {
    const opened = slotAt(780, [{ start_time: "13:00", end_time: "13:30", is_available: true }]);
    expect(opened.state).toBe("override-open");
    expect(planDayOverrideToggle(opened)).toEqual({ kind: "clear" });
  });
  it("兩個方向一致:沒有例外時一律寫例外(要偏離每週時段本來就得寫)", () => {
    expect(planDayOverrideToggle(slotAt(600, []))).toEqual({ kind: "set", isAvailable: false });
    expect(planDayOverrideToggle(slotAt(780, []))).toEqual({ kind: "set", isAvailable: true });
  });
  it("舊資料殘留:每週時段內卻有一筆「例外開啟」(改版前留下的紫框)⇒ 關閉照舊寫 false", () => {
    const legacy = slotAt(600, [{ start_time: "10:00", end_time: "10:30", is_available: true }]);
    expect(legacy.state).toBe("override-open");
    expect(planDayOverrideToggle(legacy)).toEqual({ kind: "set", isAvailable: false });
  });
});

// SPECS-INDEX #1004 補:整天休假(00:00–24:00 共 48 筆 false)那天點單一格,不會用「刪例外」破壞整天休假的辨識。
describe("planDayOverrideToggle × 整天休假(#1004)", () => {
  const windows = [{ start_time: "09:00", end_time: "18:00" }];
  const wholeDayOff = Array.from({ length: 48 }, (_, i) => ({
    start_time: minutesToTime(i * 30),
    end_time: minutesToTime(i * 30 + 30),
    is_available: false,
  }));
  it("整天休假那天每一格都是「不可預約」⇒ 只會出現「開啟」方向,從不會對任何一格做「關閉 → 刪例外」", () => {
    for (let m = 8 * 60; m < 21 * 60; m += 30) {
      const slot = resolveDaySlot({
        slotStartMin: m,
        slotEndMin: m + 30,
        availableWindows: windows,
        overrides: wholeDayOff,
        foreignBookings: [],
      });
      expect(slot.finalAvailable).toBe(false);
      const plan = planDayOverrideToggle(slot);
      // 開啟方向:每週時段內 ⇒ 刪(回到白色);時段外 ⇒ 寫 true(真的例外開啟)
      expect(plan).toEqual(
        slot.templateAvailable ? { kind: "clear" } : { kind: "set", isAvailable: true },
      );
    }
  });
  it("沒有點任何格子時,整天休假的 48 筆完全不受影響(刪除只發生在使用者點的那一格)", () => {
    expect(wholeDayOff).toHaveLength(48);
    expect(wholeDayOff.every((o) => !o.is_available)).toBe(true);
  });
});

describe("countBookingsInSlot(#1004 刪例外時自己算衝突筆數)", () => {
  const b = (id: string, start: string, end: string, status = "accepted") => ({
    id,
    start_at: `2036-03-12T${start}:00+08:00`,
    end_at: `2036-03-12T${end}:00+08:00`,
    status,
  });
  it("跟 set_staff_day_override 同條件:時間重疊才算、已取消不算、同一張單(主要 + 協助)只算一次", () => {
    const list = [
      b("x", "10:00", "11:00"),
      b("x", "10:00", "11:00"), // 同一張單以協助身分又出現一次
      b("y", "10:15", "10:45", "pending_confirmation"),
      b("z", "10:00", "10:30", "cancelled"),
      b("w", "10:30", "11:00"), // 剛好接在後面,不重疊
      b("v", "09:30", "10:00"), // 剛好接在前面,不重疊
    ];
    expect(countBookingsInSlot(list, "2036-03-12", "10:00", "10:30")).toBe(2);
    expect(countBookingsInSlot(list, "2036-03-12", "12:00", "12:30")).toBe(0);
  });
  it("最後一格結束在 24:00、跨午夜的單也算得到", () => {
    const list = [
      {
        id: "n",
        start_at: "2036-03-12T23:45:00+08:00",
        end_at: "2036-03-13T00:30:00+08:00",
        status: "accepted",
      },
    ];
    expect(countBookingsInSlot(list, "2036-03-12", "23:30", "24:00")).toBe(1);
  });
});

describe("canToggleDayOverride(#1023 第 22 批:時段外不給開關)", () => {
  it("時段內:可預約 / 排休都可以開關", () => {
    expect(
      canToggleDayOverride({ isOverride: false, templateAvailable: true, finalAvailable: true }),
    ).toBe(true);
    expect(
      canToggleDayOverride({ isOverride: true, templateAvailable: true, finalAvailable: false }),
    ).toBe(true);
  });
  it("時段外的灰格 ⇒ 不給(唯一的方向是時段外開放)", () => {
    expect(
      canToggleDayOverride({ isOverride: false, templateAvailable: false, finalAvailable: false }),
    ).toBe(false);
  });
  it("時段外的排休斜線(例:整天休假)⇒ 不給", () => {
    expect(
      canToggleDayOverride({ isOverride: true, templateAvailable: false, finalAvailable: false }),
    ).toBe(false);
  });
  it("時段外的舊資料「例外開啟」(淡紫框)⇒ 給「關閉時段」,而且關閉 = 刪例外回到灰格", () => {
    const slot = { isOverride: true, templateAvailable: false, finalAvailable: true };
    expect(canToggleDayOverride(slot)).toBe(true);
    expect(planDayOverrideToggle(slot)).toEqual({ kind: "clear" });
  });
  it("所有會被允許的組合,planDayOverrideToggle 都不會產生「時段外寫 is_available=true」(資料庫會擋的那種)", () => {
    for (const isOverride of [false, true]) {
      for (const templateAvailable of [false, true]) {
        for (const finalAvailable of [false, true]) {
          if (!isOverride && finalAvailable !== templateAvailable) continue; // 沒有例外時兩者一定相同
          const slot = { isOverride, templateAvailable, finalAvailable };
          if (!canToggleDayOverride(slot)) continue;
          const action = planDayOverrideToggle(slot);
          if (action.kind === "set" && action.isAvailable) expect(templateAvailable).toBe(true);
        }
      }
    }
  });
});
