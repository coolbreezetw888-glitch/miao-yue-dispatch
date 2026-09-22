// 模組 15(服務人員推播通知)規則 4.5:訂單內容異動的一句話摘要,涵蓋「只改時間」「只改服務
// 項目」「同時改多項」「沒有明顯差異」四種情境(規格書 4.5 測試要求逐字列出的四種)。

import { describe, expect, it } from "vitest";
import { computeBookingChangeSummary, detectChangedFields } from "./changeSummary";

const BASE_ORIGINAL = {
  startAt: "2026-09-25T07:00:00.000Z",
  serviceItemIds: ["item-a", "item-b"],
  staffId: "staff-1",
};

describe("detectChangedFields", () => {
  it("完全沒有變動時回傳空陣列", () => {
    const changed = detectChangedFields({
      original: BASE_ORIGINAL,
      next: { ...BASE_ORIGINAL },
    });
    expect(changed).toEqual([]);
  });

  it("服務項目順序不同但集合相同時,不算變動(比較的是集合,不是順序)", () => {
    const changed = detectChangedFields({
      original: BASE_ORIGINAL,
      next: { ...BASE_ORIGINAL, serviceItemIds: ["item-b", "item-a"] },
    });
    expect(changed).toEqual([]);
  });
});

describe("computeBookingChangeSummary(規則 4.5 核心必測四種情境)", () => {
  it("情境一:只改時間 → 「預約時間改為 ...」", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: {
        ...BASE_ORIGINAL,
        startAt: "2026-09-26T07:00:00.000Z",
        formattedStartAt: "09/26 15:00",
      },
    });
    expect(summary).toBe("預約時間改為 09/26 15:00");
  });

  it("情境二:只改服務項目 → 「服務項目改為 ...」(用 + 串接名稱)", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: {
        ...BASE_ORIGINAL,
        serviceItemIds: ["item-a", "item-c"],
        serviceNames: ["洗髮", "燙髮"],
      },
    });
    expect(summary).toBe("服務項目改為 洗髮+燙髮");
  });

  it("情境二邊界:只改服務人員 → 「服務人員改為 ...」", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: {
        ...BASE_ORIGINAL,
        staffId: "staff-2",
        staffName: "王小明",
      },
    });
    expect(summary).toBe("服務人員改為 王小明");
  });

  it("情境三:同時改很多項 → 通用文字,不逐一列出", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: {
        ...BASE_ORIGINAL,
        startAt: "2026-09-26T07:00:00.000Z",
        formattedStartAt: "09/26 15:00",
        staffId: "staff-2",
        staffName: "王小明",
      },
    });
    expect(summary).toBe("您的預約內容已更新,請至系統查看最新內容");
  });

  it("情境四:沒有明顯差異 → 通用文字", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: { ...BASE_ORIGINAL },
    });
    expect(summary).toBe("您的預約內容已更新,請至系統查看最新內容");
  });

  it("邊界情況:服務項目變動但沒有提供 serviceNames 時退回通用文字(避免顯示空字串)", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: { ...BASE_ORIGINAL, serviceItemIds: ["item-x"] },
    });
    expect(summary).toBe("您的預約內容已更新,請至系統查看最新內容");
  });

  it("邊界情況:服務人員變動但沒有提供 staffName 時退回通用文字", () => {
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: { ...BASE_ORIGINAL, staffId: "staff-9" },
    });
    expect(summary).toBe("您的預約內容已更新,請至系統查看最新內容");
  });

  it("超過 60 字時在前端就先截斷", () => {
    const longName = "服".repeat(80);
    const summary = computeBookingChangeSummary({
      original: BASE_ORIGINAL,
      next: {
        ...BASE_ORIGINAL,
        serviceItemIds: ["item-x"],
        serviceNames: [longName],
      },
    });
    expect(summary.length).toBeLessThanOrEqual(60);
  });
});
