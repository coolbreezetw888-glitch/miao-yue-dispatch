// 模組 11(LINE 通知)§4.2/§7:文案範本變數替換純函式的單元測試。

import { describe, expect, it } from "vitest";

import {
  LINE_STAFF_LEAVE_TEMPLATE_VARIABLE_DEFINITIONS,
  LINE_TEMPLATE_VARIABLE_DEFINITIONS,
  getTemplateVariableDefinitions,
  previewLineMessageTemplate,
  renderLineMessageTemplate,
} from "./templateVariables";

describe("renderLineMessageTemplate(判斷 11)", () => {
  it("找得到的變數會被換成對應值", () => {
    expect(renderLineMessageTemplate("您好 {{customer_name}}", { customer_name: "王小姐" })).toBe(
      "您好 王小姐",
    );
  });

  it("同一個變數出現多次都會被換掉", () => {
    expect(
      renderLineMessageTemplate("{{merchant_name}} - {{merchant_name}}", {
        merchant_name: "示範商家",
      }),
    ).toBe("示範商家 - 示範商家");
  });

  it("對應不到的變數維持原樣,不報錯、不清空", () => {
    expect(renderLineMessageTemplate("金額:{{final_amount}} 元", {})).toBe("金額:{{final_amount}} 元");
  });

  it("變數值為空字串時正確替換成空字串(對應規則 2.4「安靜」精神延伸到變數組裝)", () => {
    expect(renderLineMessageTemplate("備註:{{cancel_reason}}", { cancel_reason: "" })).toBe(
      "備註:",
    );
  });

  it("沒有任何 {{}} 語法的純文字原樣輸出", () => {
    expect(renderLineMessageTemplate("這是一段固定文字", {})).toBe("這是一段固定文字");
  });

  it("不合法/未定義的變數名稱(不在清單內)維持原樣", () => {
    expect(renderLineMessageTemplate("{{unknown_variable}}", { customer_name: "王小姐" })).toBe(
      "{{unknown_variable}}",
    );
  });
});

describe("previewLineMessageTemplate(4.2 即時預覽)", () => {
  it("涵蓋 LINE_TEMPLATE_VARIABLE_DEFINITIONS 列出的每一個變數都能被範例值替換", () => {
    for (const { key } of LINE_TEMPLATE_VARIABLE_DEFINITIONS) {
      const rendered = previewLineMessageTemplate(`{{${key}}}`);
      expect(rendered).not.toContain(`{{${key}}}`);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  it("套用商家建立時的預設文案範本,能正確渲染成可讀的一段話", () => {
    const template =
      "【{{merchant_name}}】有新的預約:{{customer_name}} 於 {{booking_date}} 預約 {{service_names}},金額 {{final_amount}} 元。";
    const rendered = previewLineMessageTemplate(template);
    expect(rendered).toContain("示範美甲工作室");
    expect(rendered).toContain("王小姐");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });

  it("bug fix(SPECS-INDEX 385):套用 staff_leave_created 事件的預設文案範本,能完整渲染不殘留 {{}}", () => {
    const template = "【{{merchant_name}}】{{staff_name}} 登記了一筆請假:{{booking_date}}。";
    const rendered = previewLineMessageTemplate(template);
    expect(rendered).toBe("【示範美甲工作室】陳美美 登記了一筆請假:2026-10-01 14:30。");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe("getTemplateVariableDefinitions(4.2 可用變數清單,bug fix SPECS-INDEX 385)", () => {
  it("staff_leave_created 事件只回傳請假相關變數,不含訂單事件才有的變數", () => {
    const definitions = getTemplateVariableDefinitions("staff_leave_created");
    expect(definitions).toBe(LINE_STAFF_LEAVE_TEMPLATE_VARIABLE_DEFINITIONS);
    const keys = definitions.map((d) => d.key);
    expect(keys).toEqual(["merchant_name", "staff_name", "booking_date", "leave_type_name"]);
    expect(keys).not.toContain("customer_name");
    expect(keys).not.toContain("final_amount");
  });

  it.each(["booking_created", "booking_confirmed", "booking_cancelled", "booking_completed"] as const)(
    "%s 事件回傳完整的訂單變數清單",
    (eventType) => {
      expect(getTemplateVariableDefinitions(eventType)).toBe(LINE_TEMPLATE_VARIABLE_DEFINITIONS);
    },
  );

  it("staff_leave_created 清單裡列出的每一個變數,即時預覽都有對應的範例值可以替換(不殘留 {{}})", () => {
    for (const { key } of LINE_STAFF_LEAVE_TEMPLATE_VARIABLE_DEFINITIONS) {
      const rendered = previewLineMessageTemplate(`{{${key}}}`);
      expect(rendered).not.toContain(`{{${key}}}`);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});
