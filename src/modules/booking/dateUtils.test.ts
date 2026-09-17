// 對應規格書 4.3:行事曆頁面的日期/時間轉換邏輯是本模組風險較高的前端邏輯(時區換算算錯,
// 整個行事曆格線會全部跑掉),依 ARCHITECTURE.md 第八節第 5 條/automated-testing SKILL 的要求,
// 這類轉換邏輯要寫 Vitest,不是只靠肉眼看畫面。
import { describe, expect, it } from "vitest";

import {
  addDays,
  buildMonthGrid,
  buildTaipeiIso,
  isoToTaipeiDateKey,
  isoToTaipeiDateTimeWithSeconds,
  isoToTaipeiTime,
  minutesToTime,
  startOfMonth,
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

describe("isoToTaipeiDateTimeWithSeconds", () => {
  it("預約詳情資訊擴充與建單備註分類第三節 3.1:換算成 Asia/Taipei 的年/月/日 時:分:秒(跨日情境)", () => {
    // UTC 2026-09-21 16:30:05 = Asia/Taipei 2026-09-22 00:30:05(跨過午夜)。
    const iso = "2026-09-21T16:30:05Z";
    expect(isoToTaipeiDateTimeWithSeconds(iso)).toBe("2026/9/22 00:30:05");
  });

  it("一般情況(不跨日)也正確換算,且不受既有 isoToTaipeiTime(只到分鐘)的行為影響", () => {
    const iso = "2026-09-22T02:00:09Z"; // Taipei 10:00:09
    expect(isoToTaipeiDateTimeWithSeconds(iso)).toBe("2026/9/22 10:00:09");
    // 既有的 isoToTaipeiTime 應該維持原本只到分鐘的行為,沒有被這次新增的函式意外牽動。
    expect(isoToTaipeiTime(iso)).toBe("10:00");
  });
});

describe("buildMonthGrid", () => {
  it("建單功能擴充 1.1:月曆格線一定是完整的 7 欄(含補進來的上下月日期)", () => {
    // 2026-09-01 是星期二,月初前面要補 2 天(週日、週一)才湊滿一週。
    const grid = buildMonthGrid(new Date(2026, 8, 15)); // 任一天在 9 月都應該產生同樣的格線
    expect(grid.length % 7).toBe(0);
    expect(toDateKey(grid[0]!.date)).toBe("2026-08-30"); // 那一週的週日
    expect(grid[0]!.inCurrentMonth).toBe(false);

    const sep1 = grid.find((d) => toDateKey(d.date) === "2026-09-01");
    expect(sep1?.inCurrentMonth).toBe(true);

    const sep30 = grid.find((d) => toDateKey(d.date) === "2026-09-30");
    expect(sep30?.inCurrentMonth).toBe(true);

    // 最後一天應該是完整一週的週六。
    const last = grid[grid.length - 1]!;
    expect(last.date.getDay()).toBe(6);
  });

  it("每一列都對齊星期日開頭", () => {
    const grid = buildMonthGrid(new Date(2026, 1, 10)); // 2026 年 2 月
    for (let i = 0; i < grid.length; i += 7) {
      expect(grid[i]!.date.getDay()).toBe(0);
    }
  });
});

describe("startOfMonth", () => {
  it("回傳該月第一天", () => {
    expect(toDateKey(startOfMonth(new Date(2026, 8, 22)))).toBe("2026-09-01");
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
