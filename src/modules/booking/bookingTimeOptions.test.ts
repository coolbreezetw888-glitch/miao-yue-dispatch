// SPECS-INDEX #980:時間選單前端這一側的純邏輯。
// 「哪些起點能約」的規則矩陣(營業時間外、每週時段外、單日例外、請假、嚴格衝突開 / 關、無時段限制、
// 編輯時不擋自己、總時長超出邊界)由資料庫決定,測試在 pgTAP:
//   supabase/tests/database/req980_01_list_staff_bookable_start_times.sql
// 這裡測的是前端要決定的事:拿多長工時去問、畫面顯示哪種狀態、原本的時間要不要清掉。
import { describe, expect, it } from "vitest";

import {
  isOriginalBookingSelection,
  resolveBookingTimePanelState,
  resolveScrollAnchorTime,
  resolveSlotQueryDuration,
  shouldClearSelectedTime,
  shouldShowTimeClearedNotice,
} from "./bookingTimeOptions";

describe("resolveSlotQueryDuration:拿多長的工時去問", () => {
  it("還沒選項目(0 分鐘)⇒ 用一格 30 分鐘問", () => {
    expect(resolveSlotQueryDuration(0)).toBe(30);
  });
  it("自訂工時還沒填好(NaN / 負數)⇒ 一樣用 30 分鐘", () => {
    expect(resolveSlotQueryDuration(Number.NaN)).toBe(30);
    expect(resolveSlotQueryDuration(-10)).toBe(30);
  });
  it("一般工時照原值;小數無條件進位(資料庫參數是整數,多算不到一分鐘只會更保守)", () => {
    expect(resolveSlotQueryDuration(90)).toBe(90);
    expect(resolveSlotQueryDuration(70.2)).toBe(71);
  });
  it("總時長超過一天 ⇒ null(直接顯示「這天沒有可預約的時間」,不去問)", () => {
    expect(resolveSlotQueryDuration(1440)).toBe(1440);
    expect(resolveSlotQueryDuration(1441)).toBeNull();
  });
});

describe("resolveBookingTimePanelState:時段區塊顯示什麼", () => {
  const base = {
    staffId: "s1",
    dateKey: "2026-12-07",
    leaveTypeName: null,
    queryDuration: 60 as number | null,
    isLoading: false,
    isError: false,
    options: ["10:00", "10:30"] as string[] | undefined,
  };
  it("尚未選服務人員 ⇒ 維持改版前「請先選擇服務人員」", () => {
    expect(resolveBookingTimePanelState({ ...base, staffId: "" }).kind).toBe("need-staff");
  });
  it("沒選日期 ⇒ need-date", () => {
    expect(resolveBookingTimePanelState({ ...base, dateKey: "" }).kind).toBe("need-date");
  });
  it("整天請假 ⇒ 講清楚假別(比「沒有可約時間」好懂)", () => {
    expect(resolveBookingTimePanelState({ ...base, leaveTypeName: "特休" })).toEqual({
      kind: "on-leave",
      leaveTypeName: "特休",
    });
  });
  it("載入中 ⇒ loading;查詢失敗 ⇒ error(不可以假裝「沒有可約時間」)", () => {
    expect(resolveBookingTimePanelState({ ...base, isLoading: true }).kind).toBe("loading");
    expect(resolveBookingTimePanelState({ ...base, isError: true, options: undefined }).kind).toBe(
      "error",
    );
  });
  it("清單是空的 / 工時超過一天 ⇒ empty(畫面顯示「這天沒有可預約的時間」)", () => {
    expect(resolveBookingTimePanelState({ ...base, options: [] }).kind).toBe("empty");
    expect(resolveBookingTimePanelState({ ...base, queryDuration: null }).kind).toBe("empty");
  });
  it("有清單 ⇒ 原樣列出(不在前端再篩)", () => {
    expect(resolveBookingTimePanelState(base)).toEqual({
      kind: "list",
      options: ["10:00", "10:30"],
    });
  });
});

describe("shouldClearSelectedTime:原本選的時間變得不能選 ⇒ 清空", () => {
  const list = { kind: "list" as const, options: ["10:00", "11:00"] };
  it("還在清單裡 ⇒ 不清", () => {
    expect(shouldClearSelectedTime({ time: "10:00", state: list, keepOriginal: false })).toBe(
      false,
    );
  });
  it("不在清單裡(例:改了項目工時變長、跟既有訂單重疊)⇒ 清", () => {
    expect(shouldClearSelectedTime({ time: "10:30", state: list, keepOriginal: false })).toBe(true);
  });
  it("這天沒有可約時間 / 整天請假 ⇒ 清", () => {
    expect(
      shouldClearSelectedTime({ time: "10:00", state: { kind: "empty" }, keepOriginal: false }),
    ).toBe(true);
    expect(
      shouldClearSelectedTime({
        time: "10:00",
        state: { kind: "on-leave", leaveTypeName: "特休" },
        keepOriginal: false,
      }),
    ).toBe(true);
  });
  it("載入中 / 查詢失敗 / 還沒選服務人員 ⇒ 不清(不能因為網路問題就把使用者的選擇洗掉)", () => {
    for (const state of [
      { kind: "loading" as const },
      { kind: "error" as const },
      { kind: "need-staff" as const },
    ]) {
      expect(shouldClearSelectedTime({ time: "10:30", state, keepOriginal: false })).toBe(false);
    }
  });
  it("編輯時還是原本的服務人員 / 日期 / 時間 / 工時 ⇒ 不清(送出時後端照常檢查)", () => {
    expect(shouldClearSelectedTime({ time: "10:30", state: list, keepOriginal: true })).toBe(false);
  });
  it("時間本來就是空的 ⇒ 不用清", () => {
    expect(shouldClearSelectedTime({ time: "", state: list, keepOriginal: false })).toBe(false);
  });
});

describe("isOriginalBookingSelection", () => {
  const original = { staffId: "s1", dateKey: "2026-12-07", time: "14:00", durationMinutes: 60 };
  const same = {
    original,
    staffId: "s1",
    dateKey: "2026-12-07",
    time: "14:00",
    durationMinutes: 60,
  };
  it("四項都一樣 ⇒ true", () => {
    expect(isOriginalBookingSelection(same)).toBe(true);
  });
  it("任何一項改了(服務人員 / 日期 / 時間 / 工時)⇒ false", () => {
    expect(isOriginalBookingSelection({ ...same, staffId: "s2" })).toBe(false);
    expect(isOriginalBookingSelection({ ...same, dateKey: "2026-12-08" })).toBe(false);
    expect(isOriginalBookingSelection({ ...same, time: "14:30" })).toBe(false);
    expect(isOriginalBookingSelection({ ...same, durationMinutes: 90 })).toBe(false);
  });
  it("新增模式(沒有原本的值)⇒ false", () => {
    expect(isOriginalBookingSelection({ ...same, original: null })).toBe(false);
  });
});

describe("shouldShowTimeClearedNotice(主腦裁決第 2 批第 3 項)", () => {
  it("使用者自己選的時間被清空 ⇒ 提示", () => {
    expect(shouldShowTimeClearedNotice(true)).toBe(true);
  });
  it("系統預設值(新增預約的 10:00)被清空 ⇒ 安靜清空,不提示", () => {
    expect(shouldShowTimeClearedNotice(false)).toBe(false);
  });
});

describe("resolveScrollAnchorTime:時間選單打開時捲到哪裡(#980 追加)", () => {
  // 間隔 5 分鐘:一天 288 個起點
  const every5 = Array.from({ length: 288 }, (_, i) => {
    const m = i * 5;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  });
  it("間隔 5:目前選的時間在清單裡 ⇒ 捲到它", () => {
    expect(resolveScrollAnchorTime(every5, "14:35")).toBe("14:35");
  });
  it("間隔 15:目前時間不在清單裡 ⇒ 捲到第一個比它晚的", () => {
    const every15 = ["09:00", "09:15", "09:30", "09:45", "10:00"];
    expect(resolveScrollAnchorTime(every15, "09:20")).toBe("09:30");
  });
  it("還沒選時間 ⇒ 捲到 09:00 附近;都比目標早 ⇒ 最後一個;空清單 ⇒ null", () => {
    expect(resolveScrollAnchorTime(every5, "")).toBe("09:00");
    expect(resolveScrollAnchorTime(["06:00", "07:00"], "")).toBe("07:00");
    expect(resolveScrollAnchorTime([], "10:00")).toBeNull();
  });
});
