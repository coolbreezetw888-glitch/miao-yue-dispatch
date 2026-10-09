// 客戶端第 5 批(C5-K02 / N13 / K03;5-B 加 Q01 / Q02、提醒 / 完成 / 聯絡人):「通知客人」設定 parse、範本代入規則(要跟 Edge 一致)、發送記錄文字。
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
  formatQuotaSummary,
  isQuotaBlocked,
  parseCustomerLineSettings,
  parseLineQuotaStatus,
  parseMonthlyCapInput,
  quotaUsedRatio,
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
    on_reminder: true,
    on_completed: false,
    on_contact_events: true,
    reminder_hours_before: 12,
    monthly_cap: 150,
    quota_blocked_until: "2026-10-31T16:00:00Z",
    updated_at: null,
  },
  templates: { confirmed: "店家改過的文字", reminder: "店家改過的提醒", bogus: "不認得" },
  default_templates: { submitted_pending: "伺服器預設" },
};

describe("parseCustomerLineSettings(c5-contract 2-1)", () => {
  it("讀 connected / line_login_enabled / is_on_site / is_admin / 9 個開關 / 提醒時數 / 上限 / 停發 / 範本", () => {
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
      on_reminder: true,
      on_completed: false,
      on_contact_events: true,
    });
    expect(s.isAdmin).toBe(true);
    expect(s.reminderHoursBefore).toBe(12);
    expect(s.monthlyCap).toBe(150);
    expect(s.quotaBlockedUntil).toBe("2026-10-31T16:00:00Z");
    // 不認得的鍵不收。
    expect(s.templates).toEqual({ confirmed: "店家改過的文字", reminder: "店家改過的提醒" });
    expect(s.serverDefaults).toEqual({ submitted_pending: "伺服器預設" });
  });

  it("什麼都沒回 ⇒ 預設(Q1 = A:店家建單關,其他開)、沒接上", () => {
    const s = parseCustomerLineSettings(null);
    expect(s.isConnected).toBe(false);
    expect(s.isOnSite).toBeNull();
    expect(s.switches).toEqual(CUSTOMER_LINE_SWITCH_DEFAULTS);
    expect(CUSTOMER_LINE_SWITCH_DEFAULTS.on_scheduled_by_store).toBe(false);
    // Q1 = A:提醒、完成預設關;聯絡人申請預設開。Q2 預設 24 小時;Q3 預設不設上限。
    expect(CUSTOMER_LINE_SWITCH_DEFAULTS.on_reminder).toBe(false);
    expect(CUSTOMER_LINE_SWITCH_DEFAULTS.on_completed).toBe(false);
    expect(CUSTOMER_LINE_SWITCH_DEFAULTS.on_contact_events).toBe(true);
    expect(s.reminderHoursBefore).toBe(24);
    expect(s.monthlyCap).toBeNull();
    expect(s.quotaBlockedUntil).toBeNull();
    expect(s.isAdmin).toBeNull();
  });

  it("看不懂的提醒時數 / 上限 ⇒ 預設(24 / 不限制)", () => {
    const s = parseCustomerLineSettings({
      settings: { reminder_hours_before: 5, monthly_cap: 0, quota_blocked_until: "亂寫" },
    });
    expect(s.reminderHoursBefore).toBe(24);
    expect(s.monthlyCap).toBeNull();
    expect(s.quotaBlockedUntil).toBeNull();
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
    expect(toServerPatch({ reminderHoursBefore: 6 })).toEqual({ reminder_hours_before: 6 });
  });

  it("錯誤 hint ⇒ 固定中文,不顯示資料庫原文", () => {
    expect(customerLineSaveErrorMessage({ code: "42501", hint: "forbidden", message: "x" })).toBe(
      "你沒有修改 LINE 通知設定的權限。",
    );
    expect(customerLineSaveErrorMessage({ code: "22023", hint: "template_too_long" })).toBe(
      "通知文字最多 500 字。",
    );
    expect(customerLineSaveErrorMessage({ code: "22023", hint: "reminder_hours_invalid" })).toBe(
      "提醒時間只能選 2、3、6、12、24 或 48 小時。",
    );
    expect(customerLineSaveErrorMessage({ code: "22023", hint: "monthly_cap_invalid" })).toBe(
      "每月上限請填 1 到 100,000 的整數，留空代表不限制。",
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
    booking_day_word: "明天",
  };

  it("預設文案逐字(店家確認)", () => {
    expect(renderCustomerLineTemplate(CUSTOMER_LINE_DEFAULT_TEMPLATES.confirmed, values)).toBe(
      "「涼風工匠」已確認您的預約：\n10月13日（二） 10:00\n服務人員：阿明\n查看或取消：https://example.com/booking/demo/me/bookings",
    );
  });

  it("沒填電話 ⇒ 含 {{merchant_phone}} 的那一整行拿掉(不留「請聯絡店家：」空尾巴)", () => {
    const out = renderCustomerLineTemplate(CUSTOMER_LINE_DEFAULT_TEMPLATES.cancelled_by_store, {
      ...values,
      merchant_phone: "  ",
    });
    expect(out).toBe("「涼風工匠」取消了您 10月13日（二） 10:00 的預約。");
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

describe("C5-K02 卡片內容:9 種通知(5-B 加提醒 / 完成 / 聯絡人)", () => {
  it("順序與範本", () => {
    expect(CUSTOMER_LINE_KINDS.map((k) => k.key)).toEqual([
      "on_submitted",
      "on_scheduled_by_store",
      "on_confirmed",
      "on_rescheduled",
      "on_cancelled_by_store",
      "on_cancelled_by_customer",
      "on_reminder",
      "on_completed",
      "on_contact_events",
    ]);
    const contact = CUSTOMER_LINE_KINDS.find((k) => k.key === "on_contact_events");
    expect(contact?.templates.map((t) => t.code)).toEqual([
      "contact_request",
      "contact_removed",
      "contact_approved",
      "contact_rejected",
    ]);
    expect(CUSTOMER_LINE_USAGE.quotaNote).toContain("200 則");
  });

  it("5-B 預設文案逐字(跟資料庫 customer_line_default_templates 一致);到府提醒加「（預計抵達時間）」", () => {
    expect(defaultCustomerLineTemplate("reminder", false)).toBe(
      "提醒您：{{booking_day_word}} {{booking_time}} 在「{{merchant_name}}」有預約。\n{{service_items}}\n查看預約：{{member_center_url}}",
    );
    expect(defaultCustomerLineTemplate("reminder", true)).toContain(
      "{{booking_day_word}} {{booking_time}}（預計抵達時間） 在",
    );
    expect(defaultCustomerLineTemplate("completed", true)).toBe(
      "謝謝您今天光臨「{{merchant_name}}」！\n查看紀錄：{{member_center_url}}",
    );
    expect(defaultCustomerLineTemplate("contact_rejected", false)).toBe(
      "您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：{{merchant_phone}}",
    );
    // QA #1:電話那句獨立一行(比照店家取消)⇒ 店家沒填電話時整行拿掉,不留空尾巴。
    expect(
      renderCustomerLineTemplate(defaultCustomerLineTemplate("contact_rejected", false), {
        merchant_name: "涼風工匠",
        merchant_phone: "",
      }),
    ).toBe("您申請成為「涼風工匠」會員聯絡人的要求沒有被同意。");
    expect(
      renderCustomerLineTemplate(defaultCustomerLineTemplate("contact_rejected", false), {
        merchant_name: "涼風工匠",
        merchant_phone: "0223456789",
      }),
    ).toBe("您申請成為「涼風工匠」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：0223456789");
  });

  it("提醒可用「今天／明天」;聯絡人通知沒有日期、時間、服務項目", () => {
    const keys = (code: Parameters<typeof customerLineTemplateVariables>[0]) =>
      customerLineTemplateVariables(code).map((v) => v.key);
    expect(keys("reminder")).toContain("booking_day_word");
    expect(keys("confirmed")).not.toContain("booking_day_word");
    expect(keys("contact_request")).toContain("contact_name");
    for (const code of [
      "contact_request",
      "contact_removed",
      "contact_approved",
      "contact_rejected",
    ] as const) {
      expect(keys(code)).not.toContain("booking_date");
      expect(keys(code)).not.toContain("service_items");
      expect(keys(code)).toContain("member_center_url");
    }
  });
});

describe("C5-Q01 每月客人通知上限輸入", () => {
  it("空白 = 不限制;1~100,000 整數(可有逗號);其他不收", () => {
    expect(parseMonthlyCapInput("")).toEqual({ ok: true, value: null });
    expect(parseMonthlyCapInput("  ")).toEqual({ ok: true, value: null });
    expect(parseMonthlyCapInput("150")).toEqual({ ok: true, value: 150 });
    expect(parseMonthlyCapInput("1,000")).toEqual({ ok: true, value: 1000 });
    expect(parseMonthlyCapInput("100000")).toEqual({ ok: true, value: 100000 });
    expect(parseMonthlyCapInput("0")).toEqual({ ok: false });
    expect(parseMonthlyCapInput("100001")).toEqual({ ok: false });
    expect(parseMonthlyCapInput("1.5")).toEqual({ ok: false });
    expect(parseMonthlyCapInput("-3")).toEqual({ ok: false });
    expect(parseMonthlyCapInput("abc")).toEqual({ ok: false });
  });
});

describe("C5-Q02 本月額度", () => {
  const base = {
    plan_limit: 200,
    used: 132,
    by_category: { customer: 80, store: 40, marketing: 12, birthday: 0 },
    cap: null,
    blocked_until: null,
  };

  it("查得到上限 ⇒「本月已用 132／200 則（客人通知 80、員工通知 40、行銷 12）」;生日禮有發才列", () => {
    expect(formatQuotaSummary(parseLineQuotaStatus(base))).toBe(
      "本月已用 132／200 則（客人通知 80、員工通知 40、行銷 12）",
    );
    expect(
      formatQuotaSummary(
        parseLineQuotaStatus({ ...base, by_category: { ...base.by_category, birthday: 3 } }),
      ),
    ).toBe("本月已用 132／200 則（客人通知 80、員工通知 40、行銷 12、生日禮 3）");
    expect(quotaUsedRatio(parseLineQuotaStatus(base))).toBeCloseTo(0.66);
  });

  it("方案沒上限 / LINE 查不到 / 什麼都沒回", () => {
    expect(
      formatQuotaSummary(parseLineQuotaStatus({ ...base, plan_limit: null, used: 3200 })),
    ).toBe("本月已用 3,200 則，你的方案沒有每月上限（客人通知 80、員工通知 40、行銷 12）");
    const unknown = parseLineQuotaStatus({ ...base, plan_limit: null, used: null });
    expect(formatQuotaSummary(unknown)).toBe(
      "秒約本月已發 132 則（客人通知 80、員工通知 40、行銷 12）",
    );
    expect(quotaUsedRatio(unknown)).toBeNull();
    expect(formatQuotaSummary(parseLineQuotaStatus(null))).toBe(
      "秒約本月已發 0 則（客人通知 0、員工通知 0、行銷 0）",
    );
  });

  it("停發中:停發時間還沒過才算", () => {
    const now = Date.UTC(2026, 9, 20);
    expect(isQuotaBlocked("2026-10-31T16:00:00Z", now)).toBe(true);
    expect(isQuotaBlocked("2026-09-30T16:00:00Z", now)).toBe(false);
    expect(isQuotaBlocked(null, now)).toBe(false);
    expect(isQuotaBlocked("亂寫", now)).toBe(false);
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
