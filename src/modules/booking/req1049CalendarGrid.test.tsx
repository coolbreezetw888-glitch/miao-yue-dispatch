// SPECS-INDEX #1049 / #1050:行事曆格子顯示一致化 + 排程狀態顏色透明度(純函式 + 自動捲動 hook)。
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));

import {
  dayCellAppearance,
  outsideBusinessHoursStyle,
  staffAvailableSlotStyle,
  tintedLuminanceOnWhite,
  CALENDAR_LIGHT_INK,
} from "./bookingBlockLayout";
import { computeDropTarget } from "./bookingDragMove";
import {
  buildFullDaySlots,
  buildStaffDayAvailableWindows,
  businessRangeMinutes,
  classifyDayCell,
  dayGridInitialScrollMin,
} from "./daySlotGrid";
import {
  buildCalendarStateStyleMap,
  calendarStateBlockStyle,
  DEFAULT_CALENDAR_STATE_STYLES,
  normalizeCalendarStateOpacity,
  scaleCalendarAlpha,
  type CalendarStateStyleMap,
} from "./types";
import { useDayGridInitialScroll } from "./useDayGridInitialScroll";
import { parseMyCalendarStateStyles } from "@/modules/staff-portal/api";

const HOURS_9_18 = {
  has_setting: true,
  is_closed: false,
  open_time: "09:00:00",
  close_time: "18:00:00",
};
const BUSINESS = businessRangeMinutes(HOURS_9_18)!;
const WINDOWS_9_15 = [{ start_time: "09:00:00", end_time: "15:00:00" }];

function cellAt(hhmm: string, extra: Partial<Parameters<typeof classifyDayCell>[0]> = {}) {
  const [h, m] = hhmm.split(":").map(Number);
  const start = h! * 60 + m!;
  return classifyDayCell({
    slotStartMin: start,
    slotEndMin: start + 30,
    onLeave: false,
    business: BUSINESS,
    availableWindows: WINDOWS_9_15,
    overrides: [],
    foreignBookings: [],
    ...extra,
  });
}

afterEach(() => cleanup());

describe("#1049 R1 buildFullDaySlots", () => {
  it("30 分一格 ⇒ 48 格,00:00 開始、最後一格 23:30–24:00", () => {
    const slots = buildFullDaySlots(30);
    expect(slots).toHaveLength(48);
    expect(slots[0]).toEqual({ start: "00:00", end: "00:30", startMin: 0, endMin: 30 });
    expect(slots[47]).toEqual({ start: "23:30", end: "24:00", startMin: 1410, endMin: 1440 });
  });
  it("0 或負數 ⇒ 空", () => {
    expect(buildFullDaySlots(0)).toEqual([]);
  });
});

describe("#1049 R2 dayGridInitialScrollMin", () => {
  it("有營業時間 ⇒ 營業開始", () => {
    expect(dayGridInitialScrollMin(HOURS_9_18, 30)).toBe(540);
  });
  it("不在格線上 ⇒ 往下取到格線(09:15 ⇒ 09:00)", () => {
    expect(dayGridInitialScrollMin({ ...HOURS_9_18, open_time: "09:15:00" }, 30)).toBe(540);
  });
  it("沒設定 / 公休 / 沒資料 ⇒ 08:00", () => {
    expect(dayGridInitialScrollMin({ ...HOURS_9_18, has_setting: false }, 30)).toBe(480);
    expect(dayGridInitialScrollMin({ ...HOURS_9_18, is_closed: true }, 30)).toBe(480);
    expect(dayGridInitialScrollMin({ ...HOURS_9_18, open_time: null }, 30)).toBe(480);
    expect(dayGridInitialScrollMin(null, 30)).toBe(480);
  });
});

describe("#1049 businessRangeMinutes", () => {
  it("一般 / 24:00 / 公休 / 沒設定", () => {
    expect(BUSINESS).toEqual({ openMin: 540, closeMin: 1080 });
    expect(businessRangeMinutes({ ...HOURS_9_18, close_time: "24:00:00" })).toEqual({
      openMin: 540,
      closeMin: 1440,
    });
    expect(businessRangeMinutes({ ...HOURS_9_18, is_closed: true })).toBeNull();
    expect(businessRangeMinutes({ ...HOURS_9_18, has_setting: false })).toBeNull();
    expect(businessRangeMinutes(undefined)).toBeNull();
  });
});

describe("#1049 R3 classifyDayCell 優先順序(兩端共用)", () => {
  it("規格驗收情境:9-18 營業、9-15 時段 ⇒ 00-09 / 18-24 深色、9-15 自訂色、15-18 白色", () => {
    expect(cellAt("00:00").kind).toBe("outside_business_hours");
    expect(cellAt("08:30").kind).toBe("outside_business_hours");
    expect(cellAt("09:00").kind).toBe("available");
    expect(cellAt("14:30").kind).toBe("available");
    expect(cellAt("15:00").kind).toBe("unavailable");
    expect(cellAt("17:30").kind).toBe("unavailable");
    expect(cellAt("18:00").kind).toBe("outside_business_hours");
    expect(cellAt("23:30").kind).toBe("outside_business_hours");
    expect(cellAt("08:30").outsideBusinessHours).toBe(true);
    expect(cellAt("08:30").slotState).toBe("outside-business-hours");
    expect(cellAt("09:00").slotState).toBe("available");
    expect(cellAt("15:00").slotState).toBe("unavailable");
  });

  it("1. 全天休假最優先(不論營業時間內外、有沒有外店 / 例外)", () => {
    const foreign = [{ start_at: "2036-03-12T02:00:00Z", end_at: "2036-03-12T03:00:00Z" }];
    const c = cellAt("10:00", { onLeave: true, foreignBookings: foreign });
    expect(c.kind).toBe("full_day_leave");
    expect(c.slotState).toBe("full-day-leave");
    expect(cellAt("02:00", { onLeave: true }).kind).toBe("full_day_leave");
  });

  it("2. 外店佔用 > 單日例外 > 營業時間外", () => {
    // 台北 10:00–11:00 = UTC 02:00–03:00
    const foreign = [{ start_at: "2036-03-12T02:00:00Z", end_at: "2036-03-12T03:00:00Z" }];
    const overrides = [{ start_time: "10:00:00", end_time: "10:30:00", is_available: false }];
    expect(cellAt("10:00", { foreignBookings: foreign, overrides }).kind).toBe(
      "cross_store_occupied",
    );
    // 營業時間外的外店佔用也照畫
    const early = [{ start_at: "2036-03-11T23:00:00Z", end_at: "2036-03-11T23:30:00Z" }];
    expect(cellAt("07:00", { foreignBookings: early }).kind).toBe("cross_store_occupied");
  });

  it("3. 單日例外關閉 = 時段排休、例外開啟;營業時間外的例外也照既有樣式", () => {
    const overrides = [
      { start_time: "10:00:00", end_time: "10:30:00", is_available: false },
      { start_time: "16:00:00", end_time: "16:30:00", is_available: true },
      { start_time: "02:00:00", end_time: "02:30:00", is_available: false },
    ];
    expect(cellAt("10:00", { overrides }).kind).toBe("override_closed");
    expect(cellAt("10:00", { overrides }).slotState).toBe("override-closed");
    expect(cellAt("16:00", { overrides }).kind).toBe("override_open");
    const outside = cellAt("02:00", { overrides });
    expect(outside.kind).toBe("override_closed");
    expect(outside.outsideBusinessHours).toBe(true);
  });

  it("營業時間外的格子一律不可預約(就算可約區間給錯也一樣)", () => {
    const c = cellAt("08:00", { availableWindows: [{ start_time: "00:00", end_time: "24:00" }] });
    expect(c.kind).toBe("outside_business_hours");
    expect(c.resolved.finalAvailable).toBe(false);
    expect(c.resolved.templateAvailable).toBe(false);
  });

  it("一格只有一部分在營業時間內(09:15 開)⇒ 算營業時間外", () => {
    const business = businessRangeMinutes({ ...HOURS_9_18, open_time: "09:15:00" });
    expect(cellAt("09:00", { business }).kind).toBe("outside_business_hours");
    expect(cellAt("09:30", { business }).kind).toBe("available");
  });

  it("商家後台編輯無時段限制 ⇒ 營業時間內全部可預約(自訂色),營業時間外仍是深色", () => {
    const windows = buildStaffDayAvailableWindows({
      hasSetting: true,
      isClosed: false,
      openTime: "09:00:00",
      closeTime: "18:00:00",
      unlimitedBackendEdit: true,
      dayOfWeek: 3,
      weeklyWindows: [],
    });
    expect(cellAt("17:30", { availableWindows: windows }).kind).toBe("available");
    expect(cellAt("18:00", { availableWindows: windows }).kind).toBe("outside_business_hours");
  });

  it("公休 / 沒設定(business = null)⇒ 整天都算營業時間外", () => {
    expect(cellAt("10:00", { business: null }).kind).toBe("outside_business_hours");
  });
});

describe("#1049 dayCellAppearance", () => {
  const colors = DEFAULT_CALENDAR_STATE_STYLES;
  it("每週時段外 = 白色,不再是灰色", () => {
    const a = dayCellAppearance("unavailable", colors);
    expect(a.className).toBe("bg-background");
    expect(a.style).toBeUndefined();
  });
  it("可預約 = 自訂色、營業時間外 = 深色 + 淺色字、例外開啟 = 淡紫框", () => {
    expect(dayCellAppearance("available", colors).style).toEqual({ backgroundColor: "#dcfce7" });
    expect(dayCellAppearance("outside_business_hours", colors).style).toEqual({
      backgroundColor: "#334155",
      color: CALENDAR_LIGHT_INK,
    });
    expect(dayCellAppearance("override_open", colors).className).toMatch(/ring-brand/);
  });
  it("休假 / 排休 / 外店 = 既有圖樣", () => {
    expect(dayCellAppearance("full_day_leave", colors).style).toEqual(
      calendarStateBlockStyle(colors, "full_day_leave"),
    );
    expect(dayCellAppearance("override_closed", colors).style).toEqual(
      calendarStateBlockStyle(colors, "partial_leave"),
    );
    expect(dayCellAppearance("cross_store_occupied", colors).style).toEqual(
      calendarStateBlockStyle(colors, "cross_store_occupied"),
    );
  });
});

describe("#1050 透明度", () => {
  const withOpacity = (
    patch: Partial<CalendarStateStyleMap["opacity"]>,
  ): CalendarStateStyleMap => ({
    ...DEFAULT_CALENDAR_STATE_STYLES,
    opacity: { ...DEFAULT_CALENDAR_STATE_STYLES.opacity, ...patch },
  });

  it("normalizeCalendarStateOpacity:夾到 10~100、非數字 ⇒ 100", () => {
    expect(normalizeCalendarStateOpacity(50)).toBe(50);
    expect(normalizeCalendarStateOpacity("35")).toBe(35);
    expect(normalizeCalendarStateOpacity(0)).toBe(10);
    expect(normalizeCalendarStateOpacity(500)).toBe(100);
    expect(normalizeCalendarStateOpacity(null)).toBe(100);
    expect(normalizeCalendarStateOpacity("abc")).toBe(100);
  });

  it("scaleCalendarAlpha:乘在既有 alpha 上;100% 原樣", () => {
    expect(scaleCalendarAlpha(0.12, 100)).toBe(0.12);
    expect(scaleCalendarAlpha(0.55, 100)).toBe(0.55);
    expect(scaleCalendarAlpha(0.12, 50)).toBe(0.06);
    expect(scaleCalendarAlpha(0.55, 50)).toBe(0.275);
    expect(scaleCalendarAlpha(1, 35)).toBe(0.35);
  });

  it("opacity 100 ⇒ 圖樣狀態跟改版前逐字相同(底 0.12、線 0.55、文字原色)", () => {
    const style = calendarStateBlockStyle(DEFAULT_CALENDAR_STATE_STYLES, "partial_leave");
    expect(style.backgroundColor).toBe("rgba(168, 162, 158, 0.12)");
    expect(style.borderColor).toBe("rgba(168, 162, 158, 0.55)");
    expect(style.backgroundImage).toBe(
      "repeating-linear-gradient(45deg, rgba(168, 162, 158, 0.55) 0px, rgba(168, 162, 158, 0.55) 2px, transparent 2px, transparent 12px)",
    );
    expect(style.color).toBe("#a8a29e");
  });

  it("opacity 50 ⇒ 底 / 線都減半,文字不變淡", () => {
    const style = calendarStateBlockStyle(
      withOpacity({ crossStoreOccupied: 50 }),
      "cross_store_occupied",
    );
    expect(style.backgroundColor).toBe("rgba(194, 65, 12, 0.06)");
    expect(style.borderColor).toBe("rgba(194, 65, 12, 0.275)");
    expect(style.backgroundImage).toContain("rgba(194, 65, 12, 0.275)");
    expect(style.color).toBe("#c2410c");
    // 別的狀態不受影響
    expect(
      calendarStateBlockStyle(withOpacity({ crossStoreOccupied: 50 }), "full_day_leave")
        .backgroundColor,
    ).toBe("rgba(120, 113, 108, 0.12)");
  });

  it("純色狀態:100% 原色碼;50% ⇒ rgba(…, 0.5)", () => {
    expect(staffAvailableSlotStyle(DEFAULT_CALENDAR_STATE_STYLES)).toEqual({
      backgroundColor: "#dcfce7",
    });
    expect(staffAvailableSlotStyle(withOpacity({ staffAvailableSlot: 50 }))).toEqual({
      backgroundColor: "rgba(220, 252, 231, 0.5)",
    });
    expect(
      outsideBusinessHoursStyle(withOpacity({ outsideBusinessHours: 50 })).backgroundColor,
    ).toBe("rgba(51, 65, 85, 0.5)");
  });

  it("營業時間外:底色夠深 ⇒ 淺色字;調淡到看起來是淺色 ⇒ 不設定(維持灰字)", () => {
    expect(outsideBusinessHoursStyle(DEFAULT_CALENDAR_STATE_STYLES).color).toBe(CALENDAR_LIGHT_INK);
    expect(
      outsideBusinessHoursStyle(withOpacity({ outsideBusinessHours: 20 })).color,
    ).toBeUndefined();
    expect(
      outsideBusinessHoursStyle({
        ...DEFAULT_CALENDAR_STATE_STYLES,
        outsideBusinessHours: "#f1f5f9",
      }).color,
    ).toBeUndefined();
    expect(tintedLuminanceOnWhite("#ffffff", 100)).toBeCloseTo(1, 5);
    expect(tintedLuminanceOnWhite("#000000", 100)).toBeCloseTo(0, 5);
  });

  it("營業時間外色碼不合法 ⇒ 退回預設(資安:不把任意字串放進 style)", () => {
    expect(
      outsideBusinessHoursStyle({
        ...DEFAULT_CALENDAR_STATE_STYLES,
        outsideBusinessHours: "red;background:url(x)",
      }).backgroundColor,
    ).toBe("#334155");
  });
});

describe("#1050 讀取 fallback", () => {
  it("buildCalendarStateStyleMap:缺的狀態 / 透明度用預設,不認得的 state_type 略過", () => {
    const map = buildCalendarStateStyleMap([
      { state_type: "full_day_leave", color: "#111111", opacity: 40 },
      { state_type: "outside_business_hours", color: "#222222", opacity: null },
      { state_type: "unknown", color: "#333333", opacity: 10 },
    ]);
    expect(map.fullDayLeave).toBe("#111111");
    expect(map.opacity.fullDayLeave).toBe(40);
    expect(map.outsideBusinessHours).toBe("#222222");
    expect(map.opacity.outsideBusinessHours).toBe(100);
    expect(map.partialLeave).toBe(DEFAULT_CALENDAR_STATE_STYLES.partialLeave);
    expect(map.opacity.partialLeave).toBe(100);
    // 預設值物件本身沒有被改到
    expect(DEFAULT_CALENDAR_STATE_STYLES.opacity.fullDayLeave).toBe(100);
  });

  it("parseMyCalendarStateStyles:新格式(含 opacity)/ 舊格式 / 讀到奇怪的東西", () => {
    const map = parseMyCalendarStateStyles({
      full_day_leave: "#111111",
      outside_business_hours: "#222222",
      opacity: { full_day_leave: 55, outside_business_hours: 70 },
    });
    expect(map.fullDayLeave).toBe("#111111");
    expect(map.opacity.fullDayLeave).toBe(55);
    expect(map.opacity.outsideBusinessHours).toBe(70);
    const legacy = parseMyCalendarStateStyles({ partial_leave: "#444444" });
    expect(legacy.partialLeave).toBe("#444444");
    expect(legacy.opacity.partialLeave).toBe(100);
    expect(parseMyCalendarStateStyles(null)).toEqual(DEFAULT_CALENDAR_STATE_STYLES);
    expect(parseMyCalendarStateStyles([1, 2])).toEqual(DEFAULT_CALENDAR_STATE_STYLES);
  });
});

describe("#1049 拖拉落點夾在營業時間內(dropRange)", () => {
  const base = {
    pointerClientX: 50,
    grabOffsetY: 0,
    gridTopClientY: 0,
    gridStartMin: 0,
    slotMinutes: 30,
    slotPx: 30,
    slotCount: 48,
    durationMin: 60,
    columnRects: [{ staffId: "s1", left: 0, right: 100 }],
    dropRange: { startMin: 540, endMin: 1080 },
  };
  it("拖到 02:00 ⇒ 夾回 09:00;拖到 20:00 ⇒ 夾回 17:00(尾端 = 18:00)", () => {
    expect(computeDropTarget({ ...base, pointerClientY: 4 * 30 })?.startTime).toBe("09:00");
    expect(computeDropTarget({ ...base, pointerClientY: 40 * 30 })?.startTime).toBe("17:00");
    expect(computeDropTarget({ ...base, pointerClientY: 24 * 30 })?.startTime).toBe("12:00");
  });
  it("有吸附間隔時一樣夾", () => {
    expect(computeDropTarget({ ...base, snapMinutes: 15, pointerClientY: 30 })?.startTime).toBe(
      "09:00",
    );
    expect(
      computeDropTarget({ ...base, snapMinutes: 15, pointerClientY: 47 * 30 })?.startTime,
    ).toBe("17:00");
  });
  it("沒帶 dropRange ⇒ 整條格線(改版前行為)", () => {
    const { dropRange: _omit, ...noRange } = base;
    void _omit;
    expect(computeDropTarget({ ...noRange, pointerClientY: 0 })?.startTime).toBe("00:00");
    expect(computeDropTarget({ ...noRange, pointerClientY: 47 * 30 })?.startTime).toBe("23:00");
  });
});

describe("#1049 R2 useDayGridInitialScroll", () => {
  function Harness({ dateKey, target }: { dateKey: string; target: number | null }) {
    const attach = useDayGridInitialScroll(dateKey, target);
    return <div data-testid="box" ref={attach} />;
  }

  it("同一天只捲一次(資料更新不拉回);換日期才再捲;還不知道營業時間時先不捲", () => {
    const { getByTestId, rerender } = render(<Harness dateKey="2036-03-12" target={null} />);
    const box = getByTestId("box");
    expect(box.scrollTop).toBe(0);
    rerender(<Harness dateKey="2036-03-12" target={540} />);
    expect(box.scrollTop).toBe(540);
    // 使用者自己捲到別的地方,資料重查(target 不變或改變)都不拉回去
    act(() => {
      box.scrollTop = 100;
    });
    rerender(<Harness dateKey="2036-03-12" target={600} />);
    expect(box.scrollTop).toBe(100);
    // 換日期 ⇒ 再捲一次
    rerender(<Harness dateKey="2036-03-13" target={480} />);
    expect(box.scrollTop).toBe(480);
  });

  it("QA L1:同一天捲動框被拆掉重掛(週 → 月 → 回週)⇒ 新的框再捲一次;同一個框資料更新仍不拉回", () => {
    function Toggle({ show, target }: { show: boolean; target: number }) {
      const attach = useDayGridInitialScroll("2036-03-12", target);
      return show ? <div data-testid="box" ref={attach} /> : <p>月檢視</p>;
    }
    const { getByTestId, rerender, queryByTestId } = render(<Toggle show target={540} />);
    expect(getByTestId("box").scrollTop).toBe(540);
    act(() => {
      getByTestId("box").scrollTop = 0;
    });
    // 同一個框:資料重查(target 一樣)⇒ 不拉回
    rerender(<Toggle show target={540} />);
    expect(getByTestId("box").scrollTop).toBe(0);
    // 拆掉(切到月檢視)再掛回來 ⇒ 新的框 ⇒ 再捲一次
    rerender(<Toggle show={false} target={540} />);
    expect(queryByTestId("box")).toBeNull();
    rerender(<Toggle show target={540} />);
    const fresh = getByTestId("box");
    expect(fresh.scrollTop).toBe(540);
    // 新框也一樣:使用者捲走之後資料更新不拉回
    act(() => {
      fresh.scrollTop = 30;
    });
    rerender(<Toggle show target={600} />);
    expect(getByTestId("box").scrollTop).toBe(30);
  });
});
