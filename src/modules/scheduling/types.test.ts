// 模組 7(排班與休假管理)§4.3/§4.4:純函式測試(不用整個渲染頁面元件)。

import { describe, expect, it } from "vitest";

import {
  describeScheduleCell,
  getLeaveRecordDisplayStatus,
  type ScheduleOverviewDay,
} from "./types";

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

  it("優先權 2 也適用於 no_time_slot_limit=true:整天(00:00 到隔日 00:00)被關閉時顯示臨時關閉", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ unrestricted: true }],
      // 後端 3.8 合併相鄰半小時格子時用 `max(slot_start_time) + 30 分鐘`,最後一格 23:30 加完會
      // 在 PostgreSQL 的 time 型別繞回 '00:00:00',所以整天關閉回傳的就是這個形狀。
      overrides: [{ start_time: "00:00:00", end_time: "00:00:00", is_available: false }],
    };
    expect(describeScheduleCell(day, true)).toEqual({ tone: "closed", label: "臨時關閉" });
  });

  // -------------------------------------------------------------------------
  // 2026-09-24 深夜巡檢問題 3:只關掉其中一格半小時,不該顯示成整天「臨時關閉」。
  // -------------------------------------------------------------------------
  it("問題 3:09:00-18:00 正常上班、只把 14:00-14:30 這一格關閉,不能顯示成整天「臨時關閉」", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [{ start_time: "14:00:00", end_time: "14:30:00", is_available: false }],
      booking_count: 3,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "09:00-18:00・3 筆預約・部分時段臨時關閉",
    });
  });

  it("問題 3:關閉區間把固定時段整段吃光(含跨越前後多關一點)時,仍然是「臨時關閉」", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [{ start_time: "08:00:00", end_time: "20:00:00", is_available: false }],
    };
    expect(describeScheduleCell(day, false)).toEqual({ tone: "closed", label: "臨時關閉" });
  });

  it("問題 3:兩段固定時段只有其中一段被完全關閉,另一段還在,走正常顯示並標記部分關閉", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [
        { start_time: "09:00:00", end_time: "12:00:00" },
        { start_time: "14:00:00", end_time: "18:00:00" },
      ],
      overrides: [{ start_time: "09:00:00", end_time: "12:00:00", is_available: false }],
      booking_count: 1,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "09:00-12:00、14:00-18:00・1 筆預約・部分時段臨時關閉",
    });
  });

  it("問題 3:關閉區間完全落在固定時段之外時,不加「部分時段臨時關閉」標記", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [{ start_time: "20:00:00", end_time: "21:00:00", is_available: false }],
      booking_count: 2,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "09:00-18:00・2 筆預約",
    });
  });

  it("問題 3:no_time_slot_limit=true 只關掉一格半小時時,照常顯示「不受時段限制」並標記部分關閉", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ unrestricted: true }],
      overrides: [{ start_time: "14:00:00", end_time: "14:30:00", is_available: false }],
      booking_count: 4,
    };
    expect(describeScheduleCell(day, true)).toEqual({
      tone: "normal",
      label: "不受時段限制・4 筆預約・部分時段臨時關閉",
    });
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

  // -------------------------------------------------------------------------
  // 2026-09-24 深夜巡檢問題 4:只有單日例外開啟、沒有每週固定時段的那天,不能顯示成開頭掛著一個
  // 頓號的「・0 筆預約」,要看得出這天是被臨時開放的、開放到幾點。
  // -------------------------------------------------------------------------
  it("問題 4:沒有每週固定時段、只用單日例外臨時開放 10:00-12:00,顯示臨時開放的區間文字", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [],
      overrides: [{ start_time: "10:00:00", end_time: "12:00:00", is_available: true }],
      booking_count: 0,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "10:00-12:00(臨時開放)・0 筆預約",
    });
  });

  it("問題 4:標籤絕對不會以頓號開頭(回歸這次修掉的「・0 筆預約」顯示)", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [],
      overrides: [{ start_time: "10:00:00", end_time: "12:00:00", is_available: true }],
    };
    expect(describeScheduleCell(day, false).label.startsWith("・")).toBe(false);
  });

  it("問題 4:多段臨時開放區間全部列出,相鄰的半小時格子會被合併成一段", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [],
      overrides: [
        { start_time: "10:00:00", end_time: "11:00:00", is_available: true },
        { start_time: "11:00:00", end_time: "12:00:00", is_available: true },
        { start_time: "15:00:00", end_time: "16:00:00", is_available: true },
      ],
      booking_count: 2,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "10:00-12:00、15:00-16:00(臨時開放)・2 筆預約",
    });
  });

  it("同一天同時有臨時開放跟臨時關閉時,只要還有剩餘可預約時間就走正常顯示", () => {
    const day: ScheduleOverviewDay = {
      ...emptyDay,
      windows: [{ start_time: "09:00:00", end_time: "18:00:00" }],
      overrides: [
        { start_time: "09:00:00", end_time: "18:00:00", is_available: false },
        { start_time: "19:00:00", end_time: "21:00:00", is_available: true },
      ],
      booking_count: 1,
    };
    expect(describeScheduleCell(day, false)).toEqual({
      tone: "normal",
      label: "09:00-18:00・1 筆預約・部分時段臨時關閉",
    });
  });
});
