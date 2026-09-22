// 模組 15(服務人員推播通知)§7.1:public/push-sw.js 的 push/notificationclick 處理邏輯,
// 純函式版本測試(service worker 執行環境依賴 self/clients/registration,測試環境沒有)。

import { describe, expect, it } from "vitest";
import {
  buildShowNotificationOptions,
  parsePushPayload,
  resolveNotificationClickUrl,
} from "./pushPayload";

describe("parsePushPayload", () => {
  it("正常 payload:正確解析 title/body/url", () => {
    const result = parsePushPayload({ title: "新訂單通知", body: "王小明 10:00", url: "/app/my-calendar" });
    expect(result).toEqual({ title: "新訂單通知", body: "王小明 10:00", url: "/app/my-calendar" });
  });

  it("查無 raw 資料時回傳預設值", () => {
    const result = parsePushPayload(null);
    expect(result).toEqual({ title: "秒約", body: "", url: "/app/my-calendar" });
  });

  it("raw 不是物件時回傳預設值", () => {
    expect(parsePushPayload("not an object")).toEqual({ title: "秒約", body: "", url: "/app/my-calendar" });
    expect(parsePushPayload(123)).toEqual({ title: "秒約", body: "", url: "/app/my-calendar" });
  });

  it("欄位型別不對時個別 fallback 成預設值,不影響其他正確欄位", () => {
    const result = parsePushPayload({ title: 123, body: "內文正確", url: null });
    expect(result).toEqual({ title: "秒約", body: "內文正確", url: "/app/my-calendar" });
  });

  it("title 是空字串時 fallback 成預設標題(避免通知完全沒有標題)", () => {
    const result = parsePushPayload({ title: "", body: "x", url: "/app/my-calendar" });
    expect(result.title).toBe("秒約");
  });
});

describe("resolveNotificationClickUrl", () => {
  it("正常情況:回傳 data.url", () => {
    expect(resolveNotificationClickUrl({ url: "/app/my-calendar" })).toBe("/app/my-calendar");
  });

  it("查無資料時 fallback 到我的行事曆首頁", () => {
    expect(resolveNotificationClickUrl(null)).toBe("/app/my-calendar");
    expect(resolveNotificationClickUrl(undefined)).toBe("/app/my-calendar");
  });

  it("url 欄位型別不對時 fallback", () => {
    expect(resolveNotificationClickUrl({ url: 123 })).toBe("/app/my-calendar");
  });
});

describe("buildShowNotificationOptions", () => {
  it("正確組出 showNotification 的第二個參數", () => {
    const options = buildShowNotificationOptions({
      title: "新訂單通知",
      body: "王小明 10:00",
      url: "/app/my-calendar",
    });
    expect(options).toEqual({
      body: "王小明 10:00",
      icon: "/icons/icon-192.png",
      data: { url: "/app/my-calendar" },
    });
  });
});
