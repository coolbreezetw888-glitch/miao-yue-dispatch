// SPECS-INDEX #876:「行事曆檢視」的說明要告訴管理員「關閉後也不會收到訂單推播與 LINE 通知」。
// 資料庫端由 private.staff_calendar_view_allows_notifications 守門(pgTAP req876_01),這裡釘住
// 管理員撥開關時眼睛看的那一行文字,避免之後改說明時把這個後果拿掉。
import { describe, expect, it } from "vitest";

import { STAFF_PERMISSION_SECTIONS } from "./types";

describe("服務人員權限說明文字(#876)", () => {
  it("「行事曆檢視」說明寫出關閉後不會收到訂單推播與 LINE 通知", () => {
    const section = STAFF_PERMISSION_SECTIONS.find((s) => s.key === "staff_calendar_view");
    expect(section?.description).toContain("關閉後也不會收到訂單推播與 LINE 通知");
  });

  it("其他三項沒有被誤加這句(只有行事曆檢視會影響通知)", () => {
    for (const s of STAFF_PERMISSION_SECTIONS.filter((x) => x.key !== "staff_calendar_view")) {
      expect(s.description).not.toContain("推播");
    }
  });
});
