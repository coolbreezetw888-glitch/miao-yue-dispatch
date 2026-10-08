// SPECS-INDEX #1024(第 22 批):可預約時段直接調時間的檢查(跟資料庫 trigger 同兩條、同一句話)。
import { describe, expect, it } from "vitest";

import {
  availabilityWindowRangeLabel,
  toHhMm,
  validateAvailabilityWindowEdit,
  validateNewAvailabilityWindow,
} from "./availabilityWindowEdit";

const WINDOWS = [
  { id: "a", day_of_week: 1, start_time: "09:00:00", end_time: "12:00:00" },
  { id: "b", day_of_week: 1, start_time: "14:00:00", end_time: "16:00:00" },
  { id: "c", day_of_week: 2, start_time: "10:00:00", end_time: "18:00:00" },
];

describe("validateAvailabilityWindowEdit", () => {
  it("正常改時間 ⇒ null", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "08:30", "12:30")).toBeNull();
  });
  it("開始晚於 / 等於結束 ⇒ 開始時間必須早於結束時間", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "13:00", "12:00")).toBe(
      "開始時間必須早於結束時間",
    );
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "12:00", "12:00")).toBe(
      "開始時間必須早於結束時間",
    );
  });
  it("空白 ⇒ 請填寫", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "", "12:00")).toBe("請填寫開始與結束時間");
  });
  it("跟同一天另一組重疊 ⇒ 講出是哪一組(跟資料庫一字不差)", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "09:00", "14:30")).toBe(
      "這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。",
    );
  });
  it("相接不算重疊;不同天不算", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "a", "09:00", "14:00")).toBeNull();
    expect(validateAvailabilityWindowEdit(WINDOWS, "c", "14:00", "16:00")).toBeNull();
  });
  it("不跟自己比", () => {
    expect(validateAvailabilityWindowEdit(WINDOWS, "b", "14:30", "15:30")).toBeNull();
  });
});

describe("validateNewAvailabilityWindow(主腦裁決:新增也擋重疊)", () => {
  it("跟同一天已設定的重疊 ⇒ 跟編輯時一字不差", () => {
    expect(validateNewAvailabilityWindow(WINDOWS, 1, "11:00", "15:00")).toBe(
      "這個時段跟同一天已設定的「09:00–12:00」重疊，請調整時間。",
    );
  });
  it("相接、不同天、開始晚於結束", () => {
    expect(validateNewAvailabilityWindow(WINDOWS, 1, "12:00", "14:00")).toBeNull();
    expect(validateNewAvailabilityWindow(WINDOWS, 3, "09:00", "12:00")).toBeNull();
    expect(validateNewAvailabilityWindow(WINDOWS, 1, "18:00", "17:00")).toBe(
      "開始時間必須早於結束時間",
    );
  });
});

describe("顯示", () => {
  it("toHhMm / 卡片標題", () => {
    expect(toHhMm("09:00:00")).toBe("09:00");
    expect(availabilityWindowRangeLabel(WINDOWS[0]!)).toBe("星期一 09:00 - 12:00");
  });
});
