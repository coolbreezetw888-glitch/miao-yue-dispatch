// 對應規格書 4.3:行事曆頁面的日期/時間轉換邏輯是本模組風險較高的前端邏輯(時區換算算錯,
// 整個行事曆格線會全部跑掉),依 ARCHITECTURE.md 第八節第 5 條/automated-testing SKILL 的要求,
// 這類轉換邏輯要寫 Vitest,不是只靠肉眼看畫面。
import { describe, expect, it } from "vitest";

import {
  addDays,
  buildTaipeiIso,
  isoToTaipeiDateKey,
  isoToTaipeiTime,
  minutesToTime,
  startOfWeek,
  timeToMinutes,
  toDateKey,
} from "./dateUtils";

describe("toDateKey", () => {
  it("補零成 YYYY-MM-DD 格式", () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toDateKey(new Date(2026, 8, 22))).toBe("2026-09-22");
  });
});

describe("addDays", () => {
  it("正確加減天數,含跨月", () => {
    const base = new Date(2026, 8, 30); // 2026-09-30
    expect(toDateKey(addDays(base, 1))).toBe("2026-10-01");
    expect(toDateKey(addDays(base, -30))).toBe("2026-08-31");
  });
});

describe("startOfWeek", () => {
  it("回傳同一週的星期日", () => {
    // 2026-09-22 是星期二,那一週的星期日是 2026-09-20。
    const tuesday = new Date(2026, 8, 22);
    expect(toDateKey(startOfWeek(tuesday))).toBe("2026-09-20");
    // 星期日當天本身應該回傳自己。
    const sunday = new Date(2026, 8, 20);
    expect(toDateKey(startOfWeek(sunday))).toBe("2026-09-20");
  });
});

describe("buildTaipeiIso", () => {
  it("組出明確帶 +08:00 偏移量的 timestamptz 字串,不依賴瀏覽器時區", () => {
    expect(buildTaipeiIso("2026-09-22", "10:00")).toBe("2026-09-22T10:00:00+08:00");
  });
});

describe("isoToTaipeiDateKey / isoToTaipeiTime", () => {
  it("把 UTC 時間正確換算成 Asia/Taipei 的日曆日跟時鐘時間(跨日情境)", () => {
    // UTC 2026-09-21 16:30 = Asia/Taipei 2026-09-22 00:30(+8 小時,跨過午夜)。
    // 這條測試專門驗證「不能直接假設瀏覽器時區是台灣、也不能忽略跨日」這個最容易算錯的地方。
    const iso = "2026-09-21T16:30:00Z";
    expect(isoToTaipeiDateKey(iso)).toBe("2026-09-22");
    expect(isoToTaipeiTime(iso)).toBe("00:30");
  });

  it("一般情況(不跨日)也正確換算", () => {
    const iso = "2026-09-22T02:00:00Z"; // Taipei 10:00
    expect(isoToTaipeiDateKey(iso)).toBe("2026-09-22");
    expect(isoToTaipeiTime(iso)).toBe("10:00");
  });
});

describe("timeToMinutes / minutesToTime", () => {
  it("互為反函式", () => {
    expect(timeToMinutes("09:30")).toBe(570);
    expect(minutesToTime(570)).toBe("09:30");
    expect(timeToMinutes("00:00")).toBe(0);
    expect(minutesToTime(0)).toBe("00:00");
  });

  it("能處理帶秒數的 Postgres time 字串(只取前 5 碼)", () => {
    expect(timeToMinutes("18:00:00")).toBe(18 * 60);
  });
});
