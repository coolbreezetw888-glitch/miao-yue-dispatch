// 模組 15(手機推播通知)§7.1:public/push-sw.js 的 push/notificationclick 處理邏輯,
// 純函式版本測試(service worker 執行環境依賴 self/clients/registration,測試環境沒有)。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次 §4.7:預設目的地原本是 '/app/my-calendar',
//    而 src/App.tsx 裡根本沒有這個路由 —— 這些期望值跟著改成 '/app'(唯一允許的 fallback)。
//    另外新增 §5.5(角色 → 目的地)與 §6.3(ack)的測試。

import { describe, expect, it } from "vitest";
import {
  appendPushTestAckParam,
  buildShowNotificationOptions,
  parsePushPayload,
  PUSH_FALLBACK_URL,
  PUSH_TARGET_URLS,
  resolveNotificationClickUrl,
  resolvePushUrlForTarget,
  shouldAcknowledgePush,
} from "./pushPayload";

describe("parsePushPayload", () => {
  it("正常 payload:正確解析 title/body/url", () => {
    const result = parsePushPayload({
      title: "新訂單通知",
      body: "王小明 10:00",
      url: "/app/calendar",
    });
    expect(result).toEqual({
      title: "新訂單通知",
      body: "王小明 10:00",
      url: "/app/calendar",
      kind: null,
      ackUrl: null,
    });
  });

  it("查無 raw 資料時回傳預設值(§4.7:fallback 是 /app,不是已經不存在的 /app/my-calendar)", () => {
    const result = parsePushPayload(null);
    expect(result).toEqual({ title: "秒約", body: "", url: "/app", kind: null, ackUrl: null });
  });

  it("raw 不是物件時回傳預設值", () => {
    expect(parsePushPayload("not an object")).toEqual({
      title: "秒約",
      body: "",
      url: "/app",
      kind: null,
      ackUrl: null,
    });
    expect(parsePushPayload(123).url).toBe("/app");
  });

  it("欄位型別不對時個別 fallback 成預設值,不影響其他正確欄位", () => {
    const result = parsePushPayload({ title: 123, body: "內文正確", url: null });
    expect(result.title).toBe("秒約");
    expect(result.body).toBe("內文正確");
    expect(result.url).toBe("/app");
  });

  it("title 是空字串時 fallback 成預設標題(避免通知完全沒有標題)", () => {
    const result = parsePushPayload({ title: "", body: "x", url: "/app/calendar" });
    expect(result.title).toBe("秒約");
  });

  it("§6.3:測試推播的 kind / ack_url 會被解析出來", () => {
    const result = parsePushPayload({
      title: "秒約測試通知",
      body: "這是一則測試通知。",
      url: "/app",
      kind: "test",
      ack_url: "https://example.supabase.co/functions/v1/push-test-ack?token=abc",
    });
    expect(result.kind).toBe("test");
    expect(result.ackUrl).toBe("https://example.supabase.co/functions/v1/push-test-ack?token=abc");
  });

  it("§6.3:kind 不是 test 時一律視為 null(不會亂回報)", () => {
    expect(parsePushPayload({ kind: "booking_created" }).kind).toBeNull();
  });
});

describe("resolvePushUrlForTarget(§4.7/§5.5:三種角色的落點)", () => {
  it("服務人員導到 /app/calendar(不是不存在的 /app/my-calendar)", () => {
    expect(resolvePushUrlForTarget("staff")).toBe("/app/calendar");
  });

  it("管理員/客服導到訂單管理頁", () => {
    expect(resolvePushUrlForTarget("admin")).toBe("/app/orders");
    expect(resolvePushUrlForTarget("agent")).toBe("/app/orders");
  });

  it("查無角色時 fallback 到 /app", () => {
    expect(resolvePushUrlForTarget(null)).toBe("/app");
    expect(resolvePushUrlForTarget(undefined)).toBe("/app");
  });

  it("§4.7:對照表裡不可以再出現已經不存在的 /app/my-calendar", () => {
    expect(Object.values(PUSH_TARGET_URLS)).not.toContain("/app/my-calendar");
    expect(PUSH_FALLBACK_URL).toBe("/app");
  });
});

describe("resolveNotificationClickUrl", () => {
  it("正常情況:回傳 data.url", () => {
    expect(resolveNotificationClickUrl({ url: "/app/calendar" })).toBe("/app/calendar");
  });

  it("查無資料時 fallback 到 /app", () => {
    expect(resolveNotificationClickUrl(null)).toBe("/app");
    expect(resolveNotificationClickUrl(undefined)).toBe("/app");
  });

  it("url 欄位型別不對時 fallback", () => {
    expect(resolveNotificationClickUrl({ url: 123 })).toBe("/app");
  });
});

describe("appendPushTestAckParam(§6.3 備援路徑)", () => {
  it("把 ack token 接在目的地網址後面", () => {
    expect(
      appendPushTestAckParam("/app", "https://x.supabase.co/functions/v1/push-test-ack?token=t1"),
    ).toBe("/app?push_test_ack=t1");
  });

  it("目的地已經有 querystring 時用 & 接", () => {
    expect(
      appendPushTestAckParam(
        "/app?a=1",
        "https://x.supabase.co/functions/v1/push-test-ack?token=t1",
      ),
    ).toBe("/app?a=1&push_test_ack=t1");
  });

  it("沒有 ackUrl 或解析不出 token 時,網址原樣不動", () => {
    expect(appendPushTestAckParam("/app", null)).toBe("/app");
    expect(appendPushTestAckParam("/app", "not a url")).toBe("/app");
    expect(appendPushTestAckParam("/app", "https://x.supabase.co/functions/v1/push-test-ack")).toBe(
      "/app",
    );
  });
});

describe("shouldAcknowledgePush(§6.3 第 2 點)", () => {
  it("只有 kind=test 而且有 ack_url 時才回報", () => {
    expect(
      shouldAcknowledgePush({
        title: "",
        body: "",
        url: "/app",
        kind: "test",
        ackUrl: "https://x",
      }),
    ).toBe(true);
  });

  it("一般推播不回報", () => {
    expect(
      shouldAcknowledgePush({ title: "", body: "", url: "/app", kind: null, ackUrl: "https://x" }),
    ).toBe(false);
    expect(
      shouldAcknowledgePush({ title: "", body: "", url: "/app", kind: "test", ackUrl: null }),
    ).toBe(false);
  });
});

describe("buildShowNotificationOptions", () => {
  it("正確組出 showNotification 的第二個參數", () => {
    const options = buildShowNotificationOptions({
      title: "新訂單通知",
      body: "王小明 10:00",
      url: "/app/calendar",
      kind: null,
      ackUrl: null,
    });
    expect(options).toEqual({
      body: "王小明 10:00",
      icon: "/icons/icon-192.png",
      data: { url: "/app/calendar", kind: null, ackUrl: null },
    });
  });
});
