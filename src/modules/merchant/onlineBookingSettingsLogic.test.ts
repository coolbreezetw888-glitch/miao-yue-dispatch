// 客戶端第 1 批(C1-D01 / C1-D02):商家設定「線上預約」卡片的欄位檢查。

import { describe, expect, it } from "vitest";

import {
  COMPLETION_MESSAGE_MAX,
  countCompletionMessageChars,
  validateCompletionMessage,
  LINE_FRIEND_URL_FORMAT_MESSAGE,
  parseMinLeadHours,
  parseTravelBufferMinutes,
  validateLineFriendUrl,
} from "./onlineBookingSettingsLogic";

describe("C1-D02 LINE 好友連結格式", () => {
  it("合法的三種開頭", () => {
    for (const url of [
      "https://line.me/R/ti/p/@abc1234",
      "https://lin.ee/AbCdEf1",
      "https://page.line.me/abc1234",
    ]) {
      expect(validateLineFriendUrl(url)).toEqual({ ok: true, value: url });
    }
  });

  it("前後空白會去掉;空白 = 清除(null)", () => {
    expect(validateLineFriendUrl("  https://lin.ee/x  ")).toEqual({
      ok: true,
      value: "https://lin.ee/x",
    });
    expect(validateLineFriendUrl("   ")).toEqual({ ok: true, value: null });
  });

  it("http://、javascript:、其他網域、假冒網域、夾空白 ⇒ 擋下並給中文提示", () => {
    for (const url of [
      "http://line.me/R/ti/p/@abc",
      "javascript:alert(1)",
      "https://example.com/line",
      "https://line.me.evil.com/x",
      "https://lin.ee.evil.com/x",
      "line.me/R/ti/p/@abc",
      "https://lin.ee/a b",
    ]) {
      expect(validateLineFriendUrl(url)).toEqual({
        ok: false,
        message: LINE_FRIEND_URL_FORMAT_MESSAGE,
      });
    }
  });

  it("超過 300 字 ⇒ 擋下", () => {
    const result = validateLineFriendUrl(`https://lin.ee/${"a".repeat(300)}`);
    expect(result.ok).toBe(false);
  });
});

describe("C1-D01 至少提前幾小時 / 車程緩衝", () => {
  it("至少提前幾小時:0~72 的整數", () => {
    expect(parseMinLeadHours("0")).toEqual({ ok: true, value: 0 });
    expect(parseMinLeadHours("72")).toEqual({ ok: true, value: 72 });
    expect(parseMinLeadHours("２")).toEqual({ ok: true, value: 2 });
    for (const bad of ["73", "-1", "1.5", "abc", ""]) {
      const r = parseMinLeadHours(bad);
      expect(r.ok).toBe(false);
    }
    expect(parseMinLeadHours("73")).toEqual({
      ok: false,
      message: "請填 0～72 之間的整數（單位：小時）。",
    });
  });

  it("車程緩衝:0~240 的整數", () => {
    expect(parseTravelBufferMinutes("240")).toEqual({ ok: true, value: 240 });
    expect(parseTravelBufferMinutes("241")).toEqual({
      ok: false,
      message: "請填 0～240 之間的整數（單位：分鐘）。",
    });
    expect(parseTravelBufferMinutes("-5").ok).toBe(false);
  });
});

describe("C3-H05 完成頁自訂文字", () => {
  it("空白 ⇒ null(用預設句);去頭尾空白;最多 200 字", () => {
    expect(validateCompletionMessage("   ")).toEqual({ ok: true, value: null });
    expect(validateCompletionMessage("  店家會打電話給你。\n請留意來電。 ")).toEqual({
      ok: true,
      value: "店家會打電話給你。\n請留意來電。",
    });
    expect(validateCompletionMessage("字".repeat(COMPLETION_MESSAGE_MAX)).ok).toBe(true);
    expect(validateCompletionMessage("字".repeat(COMPLETION_MESSAGE_MAX + 1))).toEqual({
      ok: false,
      message: "最多 200 個字。",
    });
  });

  it("字數用字元算(emoji 算 1 個字)", () => {
    expect(countCompletionMessageChars(" 謝謝😀 ")).toBe(3);
  });
});
