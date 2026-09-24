// 模組 15(服務人員推播通知)§13.1(SPECS-INDEX #586):推播事件設定頁通知內文變數的單元測試,
// 比照模組 11 templateVariables.test.ts 的既有覆蓋方式。

import { describe, expect, it } from "vitest";

import type { PushNotificationEventType } from "./types";
import { getPushTemplateVariableDefinitions, previewPushTemplate } from "./templateVariables";

describe("getPushTemplateVariableDefinitions(§13.1 可用變數清單,依事件類型只顯示該事件適用的變數)", () => {
  it("booking_created 只回傳 booking_date/customer_name/service_names,不含 change_summary", () => {
    const keys = getPushTemplateVariableDefinitions("booking_created").map((d) => d.key);
    expect(keys).toEqual(["booking_date", "customer_name", "service_names"]);
    expect(keys).not.toContain("change_summary");
  });

  it("booking_cancelled 只回傳 booking_date/customer_name,不含 service_names(對應 §2.2 該事件預設文案沒有用到)", () => {
    const keys = getPushTemplateVariableDefinitions("booking_cancelled").map((d) => d.key);
    expect(keys).toEqual(["booking_date", "customer_name"]);
    expect(keys).not.toContain("service_names");
  });

  it("booking_updated 含 change_summary,不含 service_names", () => {
    const keys = getPushTemplateVariableDefinitions("booking_updated").map((d) => d.key);
    expect(keys).toEqual(["booking_date", "customer_name", "change_summary"]);
    expect(keys).not.toContain("service_names");
  });

  it("booking_reminder_next_day 回傳 booking_date/customer_name/service_names,不含 change_summary", () => {
    const keys = getPushTemplateVariableDefinitions("booking_reminder_next_day").map((d) => d.key);
    expect(keys).toEqual(["booking_date", "customer_name", "service_names"]);
    expect(keys).not.toContain("change_summary");
  });

  it.each([
    "booking_created",
    "booking_cancelled",
    "booking_updated",
    "booking_reminder_next_day",
  ] as PushNotificationEventType[])(
    "%s 清單裡列出的每一個變數,即時預覽都有對應的範例值可以替換(不殘留 {{}})",
    (eventType) => {
      for (const { key } of getPushTemplateVariableDefinitions(eventType)) {
        const rendered = previewPushTemplate(`{{${key}}}`);
        expect(rendered).not.toContain(`{{${key}}}`);
        expect(rendered.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("previewPushTemplate(§13.1 即時預覽)", () => {
  it("套用 2.2 表格的 4 種事件預設文案,都能完整渲染不殘留 {{}}", () => {
    const templates: Record<PushNotificationEventType, { title: string; body: string }> = {
      booking_created: {
        title: "新訂單通知",
        body: "{{booking_date}} {{customer_name}}·{{service_names}}",
      },
      booking_cancelled: {
        title: "訂單已取消",
        body: "{{booking_date}} {{customer_name}} 的預約已取消",
      },
      booking_updated: {
        title: "訂單內容異動",
        body: "{{booking_date}} {{customer_name}}:{{change_summary}}",
      },
      booking_reminder_next_day: {
        title: "明天有預約提醒",
        body: "{{booking_date}} {{customer_name}}·{{service_names}}",
      },
    };
    for (const { title, body } of Object.values(templates)) {
      expect(previewPushTemplate(title)).not.toMatch(/\{\{\w+\}\}/);
      const renderedBody = previewPushTemplate(body);
      expect(renderedBody).not.toMatch(/\{\{\w+\}\}/);
      expect(renderedBody.length).toBeGreaterThan(0);
    }
  });

  it("邊界情況:標題與內文分開渲染,不會被合併成一段(呼叫端各自呼叫一次)", () => {
    const title = previewPushTemplate("{{customer_name}} 的預約");
    const body = previewPushTemplate("{{booking_date}} 記得準時到");
    expect(title).toBe("王小姐 的預約");
    expect(body).toBe("2026-10-01 14:30 記得準時到");
  });

  it("對應不到的變數維持原樣,不報錯", () => {
    expect(previewPushTemplate("{{unknown_variable}}")).toBe("{{unknown_variable}}");
  });

  it("空字串範本渲染後仍是空字串", () => {
    expect(previewPushTemplate("")).toBe("");
  });
});
