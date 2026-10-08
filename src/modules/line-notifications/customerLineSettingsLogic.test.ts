// 客戶端第 5 批 5-A(C5-K02 / N13 / K03):「通知客人」設定 parse、範本代入規則(要跟 Edge 一致)、發送記錄文字。
import { describe, expect, it } from "vitest";

import { toServerPatch } from "./customerLineSettingsApi";
import {
  CUSTOMER_LINE_DEFAULT_TEMPLATES,
  CUSTOMER_LINE_KINDS,
  CUSTOMER_LINE_SWITCH_DEFAULTS,
  CUSTOMER_LINE_USAGE,
  customerLineSaveErrorMessage,
  customerLineTemplateVariables,
  defaultCustomerLineTemplate,
  effectiveCustomerLineTemplate,
  parseCustomerLineSettings,
  renderCustomerLineTemplate,
  validateCustomerLineTemplate,
} from "./customerLineSettingsLogic";
import {
  CUSTOMER_LINE_LOG_EVENT_LABELS,
  LINE_LOG_SKIP_REASON_LABELS,
  lineLogEventLabel,
  lineLogTargetLabel,
} from "./types";

const CONTRACT_SAMPLE = {
  connected: true,
  line_login_enabled: false,
  is_on_site: true,
  is_admin: true,
  settings: {
    on_submitted: true,
    on_scheduled_by_store: false,
    on_confirmed: false,
    on_rescheduled: true,
    on_cancelled_by_store: true,
    on_cancelled_by_customer: true,
    on_reminder: false,
    on_completed: false,
    on_contact_events: true,
    reminder_hours_before: 24,
    monthly_cap: null,
    quota_blocked_until: null,
    updated_at: null,
  },
  templates: { confirmed: "店家改過的文字", reminder: "5-B 的", bogus: "不認得" },
  default_templates: { submitted_pending: "伺服器預設" },
};

describe("parseCustomerLineSettings(c5-contract 2-1)", () => {
  it("讀 connected / line_login_enabled / is_on_site / 6 個 5-A 開關 / 店家改過的範本", () => {
    const s = parseCustomerLineSettings(CONTRACT_SAMPLE);
    expect(s.isConnected).toBe(true);
    expect(s.lineLoginEnabled).toBe(false);
    expect(s.isOnSite).toBe(true);
    expect(s.switches).toEqual({
      on_submitted: true,
      on_scheduled_by_store: false,
      on_confirmed: false,
      on_rescheduled: true,
      on_cancelled_by_store: true,
      on_cancelled_by_customer: true,
    });
    // 5-B 的範本代碼與不認得的鍵都不收。
    expect(s.templates).toEqual({ confirmed: "店家改過的文字" });
    expect(s.serverDefaults).toEqual({ submitted_pending: "伺服器預設" });
  });

  it("什麼都沒回 ⇒ 預設(Q1 = A:店家建單關,其他開)、沒接上", () => {
    const s = parseCustomerLineSettings(null);
    expect(s.isConnected).toBe(false);
    expect(s.isOnSite).toBeNull();
    expect(s.switches).toEqual(CUSTOMER_LINE_SWITCH_DEFAULTS);
    expect(CUSTOMER_LINE_SWITCH_DEFAULTS.on_scheduled_by_store).toBe(false);
  });

  it("生效文字:店家改過的 > 伺服器預設 > 前端預設(到府加「（預計抵達時間）」)", () => {
    const s = parseCustomerLineSettings(CONTRACT_SAMPLE);
    expect(effectiveCustomerLineTemplate(s, "confirmed", true)).toBe("店家改過的文字");
    expect(effectiveCustomerLineTemplate(s, "submitted_pending", true)).toBe("伺服器預設");
    expect(effectiveCustomerLineTemplate(s, "rescheduled", true)).toContain(
      "改為：{{booking_date}} {{booking_time}}（預計抵達時間）",
    );
    expect(effectiveCustomerLineTemplate(s, "rescheduled", true)).toContain(
      "原本：{{old_booking_date}} {{old_booking_time}}\n",
    );
    expect(effectiveCustomerLineTemplate(s, "rescheduled", false)).toBe(
      CUSTOMER_LINE_DEFAULT_TEMPLATES.rescheduled,
    );
    // 句中的時間(店家取消)不加。
    expect(defaultCustomerLineTemplate("cancelled_by_store", true)).toBe(
      CUSTOMER_LINE_DEFAULT_TEMPLATES.cancelled_by_store,
    );
  });

  it("存檔只送有改的鍵;範本空字串 = 恢復預設", () => {
    expect(toServerPatch({ switches: { on_confirmed: false } })).toEqual({ on_confirmed: false });
    expect(toServerPatch({ templates: { confirmed: "" } })).toEqual({
      templates: { confirmed: "" },
    });
  });

  it("錯誤 hint ⇒ 固定中文,不顯示資料庫原文", () => {
    expect(customerLineSaveErrorMessage({ code: "42501", hint: "forbidden", message: "x" })).toBe(
      "你沒有修改 LINE 通知設定的權限。",
    );
    expect(customerLineSaveErrorMessage({ code: "22023", hint: "template_too_long" })).toBe(
      "通知文字最多 500 字。",
    );
    expect(customerLineSaveErrorMessage(new Error("raw db text"))).not.toContain("raw");
  });
});

describe("C5-N13 範本代入(c5-contract 2-3,跟 Edge 同規則)", () => {
  const values = {
    member_name: "王小明",
    merchant_name: "涼風工匠",
    booking_date: "10月13日（二）",
    booking_time: "10:00",
    old_booking_date: "10月12日（一）",
    old_booking_time: "14:00",
    service_items: "室內機清洗 ×2",
    staff_name: "阿明",
    merchant_phone: "0223456789",
    member_center_url: "https://example.com/booking/demo/me/bookings",
    contact_name: "王太太",
  };

  it("預設文案逐字(店家確認)", () => {
    expect(renderCustomerLineTemplate(CUSTOMER_LINE_DEFAULT_TEMPLATES.confirmed, values)).toBe(
      "「涼風工匠」已確認你的預約：\n10月13日（二） 10:00\n服務人員：阿明\n查看或取消：https://example.com/booking/demo/me/bookings",
    );
  });

  it("沒填電話 ⇒ 含 {{merchant_phone}} 的那一整行拿掉(不留「請聯絡店家：」空尾巴)", () => {
    const out = renderCustomerLineTemplate(CUSTOMER_LINE_DEFAULT_TEMPLATES.cancelled_by_store, {
      ...values,
      merchant_phone: "  ",
    });
    expect(out).toBe("「涼風工匠」取消了你 10月13日（二） 10:00 的預約。");
  });

  it("值裡的換行換成空白、去頭尾空白;單次替換不遞迴;不認得的原樣", () => {
    const out = renderCustomerLineTemplate("{{member_name}}|{{contact_name}}|{{unknown}}", {
      ...values,
      member_name: " 王\r\n小明 ",
      contact_name: "{{member_name}}",
    });
    expect(out).toBe("王 小明|{{member_name}}|{{unknown}}");
  });

  it("截到 5,000 字(Unicode 字元)", () => {
    const out = renderCustomerLineTemplate("😀".repeat(6000), values);
    expect(Array.from(out)).toHaveLength(5000);
  });

  it("每個範本的變數只列真的會代入的(不含金額、地址、備註)", () => {
    const keys = (code: Parameters<typeof customerLineTemplateVariables>[0]) =>
      customerLineTemplateVariables(code).map((v) => v.key);
    expect(keys("rescheduled")).toContain("old_booking_time");
    expect(keys("confirmed")).not.toContain("old_booking_time");
    expect(keys("cancelled_by_customer")).toContain("contact_name");
    for (const code of Object.keys(CUSTOMER_LINE_DEFAULT_TEMPLATES)) {
      const k = keys(code as Parameters<typeof customerLineTemplateVariables>[0]);
      expect(k).not.toContain("final_amount");
      expect(k).not.toContain("address");
    }
  });

  it("範本上限 500 字(空白 = 恢復預設,合法)", () => {
    expect(validateCustomerLineTemplate("字".repeat(500))).toBeNull();
    expect(validateCustomerLineTemplate("字".repeat(501))).toBe("too_long");
    expect(validateCustomerLineTemplate("   ")).toBeNull();
  });

  it("前端預設文案用全形標點、不寫「師傅」", () => {
    for (const code of Object.keys(CUSTOMER_LINE_DEFAULT_TEMPLATES)) {
      const t = defaultCustomerLineTemplate(
        code as keyof typeof CUSTOMER_LINE_DEFAULT_TEMPLATES,
        false,
      );
      expect(t).not.toMatch(/[,:;!?](?!\/)/);
      expect(t).not.toContain("師傅");
    }
  });
});

describe("C5-K02 卡片內容只有 5-A 的 6 種通知", () => {
  it("6 種、不含服務前提醒 / 服務完成 / 聯絡人通知", () => {
    expect(CUSTOMER_LINE_KINDS.map((k) => k.key)).toEqual([
      "on_submitted",
      "on_scheduled_by_store",
      "on_confirmed",
      "on_rescheduled",
      "on_cancelled_by_store",
      "on_cancelled_by_customer",
    ]);
    const all = JSON.stringify(CUSTOMER_LINE_KINDS);
    expect(all).not.toContain("提醒");
    expect(all).not.toContain("服務完成");
    expect(CUSTOMER_LINE_USAGE.quotaNote).toContain("200 則");
  });
});

describe("C5-K03 發送記錄文字", () => {
  it("新略過原因中文", () => {
    expect(LINE_LOG_SKIP_REASON_LABELS["customer_opted_out"]).toBe("客人關閉通知");
    expect(LINE_LOG_SKIP_REASON_LABELS["not_friend"]).toBe("客人沒加好友");
    expect(LINE_LOG_SKIP_REASON_LABELS["monthly_cap"]).toBe("已達本月上限");
    expect(LINE_LOG_SKIP_REASON_LABELS["quota_exhausted"]).toBe("LINE 額度用完");
    expect(LINE_LOG_SKIP_REASON_LABELS["stale"]).toBe("狀態已變更");
    expect(LINE_LOG_SKIP_REASON_LABELS["superseded"]).toBe("時間已改回");
  });

  it("事件名稱認得 11 種 customer_*,不認得的原樣", () => {
    expect(Object.keys(CUSTOMER_LINE_LOG_EVENT_LABELS)).toHaveLength(11);
    expect(lineLogEventLabel("customer_confirmed")).toBe("通知客人：店家確認");
    expect(lineLogEventLabel("booking_confirmed")).toBe("訂單確認時");
    expect(lineLogEventLabel("whatever")).toBe("whatever");
  });

  it("對象欄:會員〇〇（聯絡人：顯示名）;沒顯示名只寫會員〇〇;店家這邊照舊", () => {
    expect(
      lineLogTargetLabel({
        target_type: "member",
        target_member_name: "王小明",
        target_contact_display_name: "小明",
      }),
    ).toBe("會員王小明（聯絡人：小明）");
    expect(
      lineLogTargetLabel({
        target_type: "member",
        target_member_name: "王小明",
        target_contact_display_name: null,
      }),
    ).toBe("會員王小明");
    expect(lineLogTargetLabel({ target_type: "member" })).toBe("會員");
    expect(lineLogTargetLabel({ target_type: "staff", target_member_name: null })).toBe("服務人員");
  });
});
