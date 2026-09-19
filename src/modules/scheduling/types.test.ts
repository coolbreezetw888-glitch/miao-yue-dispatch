// 模組 7(排班與休假管理)§4.3/§4.4:純函式測試(不用整個渲染頁面元件)。

import { describe, expect, it } from "vitest";

import { describeScheduleCell, getLeaveRecordDisplayStatus, type ScheduleOverviewDay } from "./types";

describe("getLeaveRecordDisplayStatus", () => {
  const base = { start_date: "2026-09-25", end_date: "2026-09-27" };

  it("status=cancelled 一律顯示「已取消」,不論日期為何", () => {
    expect(getLeaveRecordDisplayStatus({ ...base, status: "cancelled" }, "2026-09-26")).toBe(
      "cancelled",
    );
    expect(getLeaveRecordDisplayStatus({ ...base, status: "cancelled" }, "2026-01-01")).toBe(
      "cancelled",
    );
  });

  it("今天早於開始日期顯示「即將開始」", () => {
    expect(getLeaveRecordDisplayStatus({ ...base, status: "confirmed" }, "2026-09-24")).toBe(
      "upcoming",
    );
  });

  it("今天落在區間內(含頭尾)顯示「進行中」", () => {
    expect(getLeaveRecordDisplayStatus({ ...base, status: "confirmed" }, "2026-09-25")).toBe(
      "ongoing",
    );
    expect(getLeaveRecordDisplayStatus({ ...base, status: "confirmed" }, "2026-09-26")).toBe(
      "ongoing",
    );
    expect(getLeaveRecordDisplayStatus({ ...base, status: "confirmed" }, "2026-09-27")).toBe(
      "ongoing",
    );
  });

  it("今天晚於結束日期顯示「已結束」", () => {
    expect(getLeaveRecordDisplayStatus({ ...base, status: "confirmed" }, "2026-09-28")).toBe(
      "ended",
    );
  });
});

describe("describeScheduleCell(規格書 §4.4 第 2 點顯示優先權)", () => {
  const emptyDay: ScheduleOverviewDay = {
    date: "2026-09-26",
    windows: [],
    overrides: [],
    on_leave: null,
    booking_count: 0,
  };

  it("優先權 1:有請假時一律顯示請假,不論其他欄位為何", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [{ start_time: "09:00:00", end_time: "10:00:00", is_available: false }],
      on_leave: { leave_record_id: "r1", leave_type_name: "特休" },
    };
    expect(describeScheduleCell(day, false)).toEqual({ tone: "leave", label: "休假:特休" });
  });

  it("優先權 2:原本有時段、但整天被單日例外關閉(只有關閉、沒有開啟的例外)顯示「臨時關閉」", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [{ start_time: "09:00:00", end_time: "18:00:00", is_available: false }],
    };
    expect(describeScheduleCell(day, false)).toEqual({ tone: "closed", label: "臨時關閉" });
  });

  it("優先權 2 不適用於 no_time_slot_limit=true 但被整天關閉的情境,一樣顯示臨時關閉", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [],
      overrides: [{ start_time: "09:00:00", end_time: "18:00:00", is_available: false }],
    };
    expect(describeScheduleCell(day, true)).toEqual({ tone: "closed", label: "臨時關閉" });
  });

  it("優先權 3:沒有時段設定、也沒有任何開啟例外,顯示「未設定」", () => {
    expect(describeScheduleCell(emptyDay, false)).toEqual({ tone: "unset", label: "未設定" });
  });

  it("優先權 4:no_time_slot_limit=true 時顯示「不受時段限制」+ 預約筆數", () => {
    const day: ScheduleOverviewDay = { ...emptyDay, booking_count: 3 };
    expect(describeScheduleCell(day, true)).toEqual({
      tone: "normal",
      label: "不受時段限制・3 筆預約",
    });
  });

  it("優先權 4:有設定時段時顯示時段區間文字 + 預約筆數", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "10:00:00", end_time: "18:00:00" }],
      booking_count: 2,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "10:00-18:00・2 筆預約",
    });
  });

  it("有開啟例外但沒有原本的時段設定,不算「未設定」也不算「臨時關閉」,走正常分支顯示", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [],
      overrides: [{ start_time: "14:00:00", end_time: "16:00:00", is_available: true }],
      booking_count: 1,
    };
    const result = describeScheduleCell(day, false);
    expect(result.tone).toBe("normal");
  });
});
