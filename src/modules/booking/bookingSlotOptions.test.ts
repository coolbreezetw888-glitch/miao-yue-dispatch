import { describe, expect, it } from "vitest";

import { buildBookingSlotOptions, type BookingSlotOptionsInput } from "./bookingSlotOptions";

const SLOT_MINUTES = 30;

function input(overrides: Partial<BookingSlotOptionsInput> = {}): BookingSlotOptionsInput {
  return {
    availableWindows: [{ start_time: "09:00", end_time: "12:00" }],
    availabilityOverrides: [],
    onLeave: false,
    totalDurationMinutes: 60,
    slotMinutes: SLOT_MINUTES,
    ...overrides,
  };
}

describe("buildBookingSlotOptions", () => {
  describe("整天請假(on_leave)", () => {
    it("整天請假時回傳空陣列,即使可預約區間照常有資料", () => {
      // 這就是稽核抓到的那個情境:師傅整天請假,行事曆主畫面已經整欄灰掉,
      // 但建單表單的時段清單以前照樣列出他平常的所有時間。
      expect(buildBookingSlotOptions(input({ onLeave: true }))).toEqual([]);
    });

    it("沒有請假時照常列出時段", () => {
      expect(buildBookingSlotOptions(input({ onLeave: false }))).toEqual([
        "09:00",
        "09:30",
        "10:00",
        "10:30",
        "11:00",
      ]);
    });
  });

  describe("總工時要能完整放進可預約區間(既有行為,不能退步)", () => {
    it("工時 60 分鐘時,最後一個起點是 11:00(11:00+60 剛好等於 12:00)", () => {
      const result = buildBookingSlotOptions(input({ totalDurationMinutes: 60 }));
      expect(result.at(-1)).toBe("11:00");
    });

    it("工時 90 分鐘時,最後一個起點縮到 10:30", () => {
      const result = buildBookingSlotOptions(input({ totalDurationMinutes: 90 }));
      expect(result.at(-1)).toBe("10:30");
    });

    it("工時比整個區間還長時沒有任何可選時段", () => {
      expect(buildBookingSlotOptions(input({ totalDurationMinutes: 300 }))).toEqual([]);
    });

    it("多個可預約區間會合併、去重並排序", () => {
      const result = buildBookingSlotOptions(
        input({
          availableWindows: [
            { start_time: "13:00", end_time: "14:00" },
            { start_time: "09:00", end_time: "10:00" },
            // 故意跟第二個區間重疊,驗證去重
            { start_time: "09:00", end_time: "10:00" },
          ],
          totalDurationMinutes: 30,
        }),
      );
      expect(result).toEqual(["09:00", "09:30", "13:00", "13:30"]);
    });
  });

  describe("單日排休(availability_overrides 且 is_available=false)", () => {
    it("起點本身落在排休區間內時不列出", () => {
      const result = buildBookingSlotOptions(
        input({
          totalDurationMinutes: 30,
          availabilityOverrides: [{ start_time: "10:00", end_time: "11:00", is_available: false }],
        }),
      );
      expect(result).toEqual(["09:00", "09:30", "11:00", "11:30"]);
    });

    it("起點不在排休區間、但這次預約會「跨進」排休區間時也不列出", () => {
      // 工時 60 分鐘,10:30 開始會佔用 10:30~11:30,跨進 11:00~11:30 的排休。
      const result = buildBookingSlotOptions(
        input({
          totalDurationMinutes: 60,
          availabilityOverrides: [{ start_time: "11:00", end_time: "11:30", is_available: false }],
        }),
      );
      expect(result).toEqual(["09:00", "09:30", "10:00"]);
    });

    it("is_available=true 的單日例外不會被當成排休擋掉", () => {
      const result = buildBookingSlotOptions(
        input({
          totalDurationMinutes: 30,
          availabilityOverrides: [{ start_time: "10:00", end_time: "11:00", is_available: true }],
        }),
      );
      expect(result).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
    });

    it("沒有完整包住某個格子的例外區間不影響該格子(跟主畫面的判斷條件一致)", () => {
      // 10:15~10:45 沒有完整包住 10:00~10:30 或 10:30~11:00 任何一格,所以都不擋。
      const result = buildBookingSlotOptions(
        input({
          totalDurationMinutes: 30,
          availabilityOverrides: [{ start_time: "10:15", end_time: "10:45", is_available: false }],
        }),
      );
      expect(result).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
    });

    it("還沒選服務項目(總工時 0)時,排休的格子一樣不列出", () => {
      const result = buildBookingSlotOptions(
        input({
          totalDurationMinutes: 0,
          availabilityOverrides: [{ start_time: "10:00", end_time: "11:00", is_available: false }],
        }),
      );
      expect(result).not.toContain("10:00");
      expect(result).not.toContain("10:30");
      expect(result).toContain("09:00");
    });
  });

  it("完全沒有可預約區間時回傳空陣列", () => {
    expect(buildBookingSlotOptions(input({ availableWindows: [] }))).toEqual([]);
  });
});
