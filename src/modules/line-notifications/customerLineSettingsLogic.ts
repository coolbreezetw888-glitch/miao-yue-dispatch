// 客戶端第 5 批(C5-K02 / C5-N13 / C5-Q01~Q03):後台「LINE 通知事件」頁「通知客人」卡的純邏輯。
// 規格:.project/specs/客戶端第5批-LINE通知與綁定.md;介面:.project/notes/c5-contract.md(甲)。
//
// ・5-A:N01~N06 六種通知。
// ・5-B(#1047):加服務前提醒(N07,含「服務前 N 小時」)、服務完成(N08)、聯絡人通知(N09~N11)、
//   每月客人通知上限(Q01,只有管理員能改)、本月額度(Q02)。
// ・範本代入:前端自己一份小函式(模組 11 判斷 11 的做法),要跟 Edge `customer-line-notify-dispatch`
//   的代入結果一致:變數只代入一次(不遞迴)、對應不到的維持原樣、店家沒填電話 ⇒ 含 {{merchant_phone}}
//   的那一整行拿掉、姓名去掉換行、整則截到 5,000 字。

// =========================================================================
// 種類與範本代碼
// =========================================================================

/** 開關欄位(merchant_customer_line_settings,C5-A02)。 */
export const CUSTOMER_LINE_SWITCH_KEYS = [
  "on_submitted",
  "on_scheduled_by_store",
  "on_confirmed",
  "on_rescheduled",
  "on_cancelled_by_store",
  "on_cancelled_by_customer",
  "on_reminder",
  "on_completed",
  "on_contact_events",
] as const;
export type CustomerLineSwitchKey = (typeof CUSTOMER_LINE_SWITCH_KEYS)[number];

/** 範本代碼(C5-N13)。 */
export const CUSTOMER_LINE_TEMPLATE_CODES = [
  "submitted_pending",
  "submitted_accepted",
  "scheduled_by_store",
  "confirmed",
  "rescheduled",
  "cancelled_by_store",
  "cancelled_by_customer",
  "reminder",
  "completed",
  "contact_request",
  "contact_removed",
  "contact_approved",
  "contact_rejected",
] as const;
export type CustomerLineTemplateCode = (typeof CUSTOMER_LINE_TEMPLATE_CODES)[number];

/** Q1 = A 的預設開關(大多數店沒有設定列,讀取一律用這份補,鐵律 8)。 */
export const CUSTOMER_LINE_SWITCH_DEFAULTS: Record<CustomerLineSwitchKey, boolean> = {
  on_submitted: true,
  on_scheduled_by_store: false,
  on_confirmed: true,
  on_rescheduled: true,
  on_cancelled_by_store: true,
  on_cancelled_by_customer: true,
  on_reminder: false,
  on_completed: false,
  on_contact_events: true,
};

/** C5-A02 / Q2 = A:服務前幾小時提醒(店家可選,預設 24)。 */
export const REMINDER_HOURS_OPTIONS = [2, 3, 6, 12, 24, 48] as const;
export const REMINDER_HOURS_DEFAULT = 24;

export interface CustomerLineKindDefinition {
  key: CustomerLineSwitchKey;
  title: string;
  /** 什麼時候發(白話)。 */
  when: string;
  /** C5-Q03:大約會用掉幾則。 */
  usage: string;
  templates: { code: CustomerLineTemplateCode; label: string | null }[];
}

/** C5-Q03:用量說明集中在這裡,LINE 改價 / 改規則時只改這一份。 */
export const CUSTOMER_LINE_USAGE = {
  perBooking: "每筆預約 1 則；公司會員由第二聯絡人下單時 2 則。",
  perOtherContacts: "會員有其他聯絡人時才會發，每位 1 則。",
  perContactEvent: "每次申請、移除、同意或拒絕 1 則（只發給相關的那一位）。",
  /** 卡片上方常駐說明(免費方案的事實;數字照 2026-10 LINE 台灣官方帳號方案)。 */
  quotaNote:
    "每傳一則給客人，都會用掉官方帳號每月的訊息額度（免費方案每月 200 則、不能加購，用完後這個月所有 LINE 通知都會停）。",
} as const;

export const CUSTOMER_LINE_KINDS: CustomerLineKindDefinition[] = [
  {
    key: "on_submitted",
    title: "收到線上預約",
    when: "客人在線上預約頁送出預約時，告訴客人店家已收到（直接成立的預約會說預約成功）。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [
      { code: "submitted_pending", label: "需要店家確認時" },
      { code: "submitted_accepted", label: "直接成立時" },
    ],
  },
  {
    key: "on_scheduled_by_store",
    title: "店家幫客人建了預約",
    when: "你在後台幫會員建立預約時（例如客人打電話預約）。資料匯入的預約不會通知。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [{ code: "scheduled_by_store", label: null }],
  },
  {
    key: "on_confirmed",
    title: "店家確認",
    when: "待確認的預約被確認時（店家、客服確認，或服務人員確認接單都算）。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [{ code: "confirmed", label: null }],
  },
  {
    key: "on_rescheduled",
    title: "改時間",
    when: "預約時間被改動時。改完 3 分鐘內又改，只會通知最後的時間；改回原本的時間就不通知。服務人員自己改時間、只換服務人員都不通知。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [{ code: "rescheduled", label: null }],
  },
  {
    key: "on_cancelled_by_store",
    title: "店家取消",
    when: "店家這邊取消預約時。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [{ code: "cancelled_by_store", label: null }],
  },
  {
    key: "on_cancelled_by_customer",
    title: "客人取消時通知其他聯絡人",
    when: "客人在會員中心自己取消時，通知這位會員的其他聯絡人（取消的那位不會收到）。",
    usage: CUSTOMER_LINE_USAGE.perOtherContacts,
    templates: [{ code: "cancelled_by_customer", label: null }],
  },
  {
    key: "on_reminder",
    title: "服務前提醒",
    when: "已確認的預約，在服務開始前幾小時提醒客人。晚上 10 點到早上 8 點不發，延到早上 8 點（那時離服務開始不到 1 小時就不發）；在提醒時間之後才約的預約不提醒。",
    usage: "每筆已確認的預約 1 則；公司會員由第二聯絡人下單時 2 則。",
    templates: [{ code: "reminder", label: null }],
  },
  {
    key: "on_completed",
    title: "服務完成",
    when: "預約標記為完成時，謝謝客人光臨。",
    usage: CUSTOMER_LINE_USAGE.perBooking,
    templates: [{ code: "completed", label: null }],
  },
  {
    key: "on_contact_events",
    title: "聯絡人申請與移除",
    when: "有人申請成為會員的聯絡人時通知主要聯絡人；聯絡人被主要聯絡人或店家移除時通知被移除的人；申請被同意或拒絕時通知申請人。自己退出、申請過期不通知。",
    usage: CUSTOMER_LINE_USAGE.perContactEvent,
    templates: [
      { code: "contact_request", label: "有人申請加入時（給主要聯絡人）" },
      { code: "contact_removed", label: "被移除時（給被移除的人）" },
      { code: "contact_approved", label: "申請被同意時（給申請人）" },
      { code: "contact_rejected", label: "申請被拒絕時（給申請人）" },
    ],
  },
];

// =========================================================================
// 預設文案(C5-N13)與變數
// =========================================================================

/** 範本裡的換行一律用 \n(畫面上 `<br>` 的意思)。 */
export const CUSTOMER_LINE_DEFAULT_TEMPLATES: Record<CustomerLineTemplateCode, string> = {
  submitted_pending:
    "「{{merchant_name}}」已收到您的預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n店家確認後會再用 LINE 通知您。\n查看預約：{{member_center_url}}",
  submitted_accepted:
    "「{{merchant_name}}」預約成功：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  scheduled_by_store:
    "「{{merchant_name}}」已為您安排預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n查看預約：{{member_center_url}}",
  confirmed:
    "「{{merchant_name}}」已確認您的預約：\n{{booking_date}} {{booking_time}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  rescheduled:
    "「{{merchant_name}}」調整了您的預約時間：\n原本：{{old_booking_date}} {{old_booking_time}}\n改為：{{booking_date}} {{booking_time}}\n如果時間不方便，請聯絡店家：{{merchant_phone}}",
  cancelled_by_store:
    "「{{merchant_name}}」取消了您 {{booking_date}} {{booking_time}} 的預約。\n有問題請聯絡店家：{{merchant_phone}}",
  cancelled_by_customer:
    "您在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。",
  reminder:
    "提醒您：{{booking_day_word}} {{booking_time}} 在「{{merchant_name}}」有預約。\n{{service_items}}\n查看預約：{{member_center_url}}",
  completed: "謝謝您今天光臨「{{merchant_name}}」！\n查看紀錄：{{member_center_url}}",
  contact_request:
    "{{contact_name}} 申請成為您在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}",
  contact_removed:
    "您已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。",
  contact_approved:
    "您已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}",
  contact_rejected:
    "您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：{{merchant_phone}}",
};

/** 到府產業:預設文案 {{booking_time}} 後面多一句(C5-N13 ⚠️)。 */
export const ON_SITE_TIME_SUFFIX = "（預計抵達時間）";

/** 「時間獨立一行」的範本(到府產業才加「（預計抵達時間）」;跟資料庫 customer_line_default_templates 一致)。 */
const ON_SITE_SUFFIX_CODES = new Set<CustomerLineTemplateCode>([
  "submitted_pending",
  "submitted_accepted",
  "scheduled_by_store",
  "confirmed",
  "rescheduled",
  // 5-B:跟資料庫 private.customer_line_default_templates 一樣,提醒的時間也加。
  "reminder",
]);

/**
 * 某範本的預設文案(伺服器沒給時的保底;正常一律用 get_customer_line_settings 的 default_templates)。
 * 到府產業在「時間獨立一行」的 {{booking_time}} 後面加「（預計抵達時間）」;句中的時間(取消類)、
 * 改時間的「原本」{{old_booking_time}} 不加。
 */
export function defaultCustomerLineTemplate(
  code: CustomerLineTemplateCode,
  isOnSite: boolean,
): string {
  const base = CUSTOMER_LINE_DEFAULT_TEMPLATES[code];
  if (!isOnSite || !ON_SITE_SUFFIX_CODES.has(code)) return base;
  return base.split("{{booking_time}}").join(`{{booking_time}}${ON_SITE_TIME_SUFFIX}`);
}

export const CUSTOMER_LINE_TEMPLATE_MAX = 500;
/** LINE 文字訊息上限。 */
export const LINE_TEXT_MAX = 5000;

export interface CustomerLineVariableDefinition {
  key: string;
  label: string;
}

const VAR = {
  member_name: { key: "member_name", label: "會員姓名" },
  merchant_name: { key: "merchant_name", label: "商家名稱" },
  booking_date: { key: "booking_date", label: "預約日期" },
  booking_time: { key: "booking_time", label: "預約時間" },
  old_booking_date: { key: "old_booking_date", label: "原本的日期" },
  old_booking_time: { key: "old_booking_time", label: "原本的時間" },
  service_items: { key: "service_items", label: "服務項目與數量" },
  staff_name: { key: "staff_name", label: "服務人員（顯示名稱）" },
  merchant_phone: { key: "merchant_phone", label: "商家電話（沒填會整行拿掉）" },
  member_center_url: { key: "member_center_url", label: "會員中心「我的預約」網址" },
  contact_name: { key: "contact_name", label: "取消的那位聯絡人（LINE 名稱）" },
  booking_day_word: {
    key: "booking_day_word",
    label: "今天／明天／後天（更遠就是日期，自動帶入）",
  },
  requester_name: { key: "contact_name", label: "申請的人（LINE 名稱）" },
} satisfies Record<string, CustomerLineVariableDefinition>;

const COMMON_VARS: CustomerLineVariableDefinition[] = [
  VAR.member_name,
  VAR.merchant_name,
  VAR.booking_date,
  VAR.booking_time,
  VAR.service_items,
  VAR.staff_name,
  VAR.merchant_phone,
  VAR.member_center_url,
];

const CONTACT_VARS: CustomerLineVariableDefinition[] = [
  VAR.member_name,
  VAR.merchant_name,
  VAR.merchant_phone,
  VAR.member_center_url,
];

/** 每個範本可以用的變數(只列真的會代入的,C5-N13;不提供金額、地址、內部備註、服務人員本名 / 電話)。 */
export function customerLineTemplateVariables(
  code: CustomerLineTemplateCode,
): CustomerLineVariableDefinition[] {
  if (code === "rescheduled") {
    return [
      ...COMMON_VARS.slice(0, 4),
      VAR.old_booking_date,
      VAR.old_booking_time,
      ...COMMON_VARS.slice(4),
    ];
  }
  if (code === "cancelled_by_customer") return [...COMMON_VARS, VAR.contact_name];
  if (code === "reminder") {
    return [...COMMON_VARS.slice(0, 2), VAR.booking_day_word, ...COMMON_VARS.slice(2)];
  }
  // 聯絡人通知(N09~N11)跟訂單無關 ⇒ 沒有日期、時間、服務項目、服務人員。
  if (code === "contact_request") return [...CONTACT_VARS, VAR.requester_name];
  if (code === "contact_removed" || code === "contact_approved" || code === "contact_rejected") {
    return CONTACT_VARS;
  }
  return COMMON_VARS;
}

/** 預覽用範例值(三欄說明表的「範例值」跟預覽框用同一份)。 */
export function customerLineSampleValues(input: {
  merchantName: string | null | undefined;
  merchantPhone: string | null | undefined;
  bookingSlug: string | null | undefined;
  siteOrigin: string;
}): Record<string, string> {
  const slug = input.bookingSlug?.trim() || "（預約頁代碼）";
  return {
    member_name: "王小明",
    merchant_name: input.merchantName?.trim() || "示範店家",
    booking_date: "10月13日（二）",
    booking_time: "10:00",
    old_booking_date: "10月12日（一）",
    old_booking_time: "14:00",
    service_items: "基本清潔 ×2、加價項目 ×1",
    staff_name: "小陳",
    merchant_phone: input.merchantPhone?.trim() ?? "",
    member_center_url: `${input.siteOrigin.replace(/\/+$/, "")}/booking/${slug}/me/bookings`,
    contact_name: "王太太",
    booking_day_word: "明天",
  };
}

/**
 * 範本代入(C5-N13 / c5-contract 2-3,跟 Edge 依同一個順序):
 *   1. 店家沒填電話(merchant_phone 空白)⇒ 含 {{merchant_phone}} 的那一整行拿掉(以 \n 分行)。
 *   2. 值裡的換行(\r、\n)換成一個半形空白、去頭尾空白(姓名 / 顯示名不能把訊息斷行)。
 *   3. {{變數}} 單次替換、不遞迴(代入後的值裡就算有 {{…}} 也不會再被代入);不認得的維持原樣。
 *   4. 整則截到 5,000 字(Unicode 字元,Array.from)。
 *   (5. 結果去頭尾空白是空字串 ⇒ Edge 不發;預覽框顯示「尚未填寫」。)
 */
export function renderCustomerLineTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const phone = (values["merchant_phone"] ?? "").trim();
  let source = template;
  if (phone === "") {
    source = source
      .split("\n")
      .filter((line) => !line.includes("{{merchant_phone}}"))
      .join("\n");
  }
  const rendered = source.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    // 連續的換行(\r\n)算一個空白,跟 Edge customer-line-notify-dispatch 一致。
    return (values[key] ?? "").replace(/[\r\n]+/g, " ").trim();
  });
  return Array.from(rendered).slice(0, LINE_TEXT_MAX).join("");
}

// =========================================================================
// 設定讀寫(get_customer_line_settings / update_customer_line_settings,C5-K02)
// =========================================================================

export interface CustomerLineSettings {
  /** 店家已接上 LINE 官方帳號(c5-contract 2-1 `connected`)。 */
  isConnected: boolean;
  /** 到府產業(伺服器給的預設文案已依這個給對版本)。null = 伺服器沒回,前端用商家資料判斷。 */
  isOnSite: boolean | null;
  /** 店家已啟用 LINE 登入(沒啟用 ⇒ 客人收不到,灰字提示)。 */
  lineLoginEnabled: boolean;
  /** 這位登入者是商家管理員(每月上限只有管理員看得到、改得到,C5-K02)。null = 伺服器沒回。 */
  isAdmin: boolean | null;
  switches: Record<CustomerLineSwitchKey, boolean>;
  /** 服務前幾小時提醒(2 / 3 / 6 / 12 / 24 / 48)。 */
  reminderHoursBefore: number;
  /** 每月客人通知上限;null = 不限制(Q3 = A 預設)。 */
  monthlyCap: number | null;
  /** LINE 回本月額度用完時停發到這個時間(ISO);null = 沒停發。 */
  quotaBlockedUntil: string | null;
  /** 店家改過的文案(沒改過的範本不在裡面 = 用預設)。 */
  templates: Partial<Record<CustomerLineTemplateCode, string>>;
  /** 伺服器給的預設文案(有給就以伺服器為準,沒給用前端那一份)。 */
  serverDefaults: Partial<Record<CustomerLineTemplateCode, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTemplateCode(key: string): key is CustomerLineTemplateCode {
  return (CUSTOMER_LINE_TEMPLATE_CODES as readonly string[]).includes(key);
}

function parseTemplateMap(raw: unknown): Partial<Record<CustomerLineTemplateCode, string>> {
  const out: Partial<Record<CustomerLineTemplateCode, string>> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isTemplateCode(k) && typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

function parseReminderHours(value: unknown): number {
  return typeof value === "number" && (REMINDER_HOURS_OPTIONS as readonly number[]).includes(value)
    ? value
    : REMINDER_HOURS_DEFAULT;
}

function parseMonthlyCap(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function parseIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * 伺服器回傳(c5-contract 2-1)→ 畫面用的設定。看不懂的欄位一律用預設值(鐵律 8:沒有列 = 預設)。
 */
export function parseCustomerLineSettings(raw: unknown): CustomerLineSettings {
  const r = isRecord(raw) ? raw : {};
  const s = isRecord(r["settings"]) ? r["settings"] : {};
  const switches = { ...CUSTOMER_LINE_SWITCH_DEFAULTS };
  for (const key of CUSTOMER_LINE_SWITCH_KEYS) {
    const v = s[key];
    if (typeof v === "boolean") switches[key] = v;
  }
  return {
    isConnected: r["connected"] === true,
    isOnSite: typeof r["is_on_site"] === "boolean" ? r["is_on_site"] : null,
    lineLoginEnabled: r["line_login_enabled"] === true,
    isAdmin: typeof r["is_admin"] === "boolean" ? r["is_admin"] : null,
    switches,
    reminderHoursBefore: parseReminderHours(s["reminder_hours_before"]),
    monthlyCap: parseMonthlyCap(s["monthly_cap"]),
    quotaBlockedUntil: parseIsoOrNull(s["quota_blocked_until"]),
    templates: parseTemplateMap(r["templates"]),
    serverDefaults: parseTemplateMap(r["default_templates"]),
  };
}

/** 某範本目前生效的文字(店家改過的 > 伺服器預設 > 前端預設)。 */
export function effectiveCustomerLineTemplate(
  settings: Pick<CustomerLineSettings, "templates" | "serverDefaults">,
  code: CustomerLineTemplateCode,
  isOnSite: boolean,
): string {
  return (
    settings.templates[code] ??
    settings.serverDefaults[code] ??
    defaultCustomerLineTemplate(code, isOnSite)
  );
}

export type TemplateDraftError = "too_long" | null;

/** 範本存檔前檢查(伺服器也會擋;這裡讓按鈕停用 + 說原因)。空白 = 恢復預設(合法)。 */
export function validateCustomerLineTemplate(text: string): TemplateDraftError {
  return Array.from(text.trim()).length > CUSTOMER_LINE_TEMPLATE_MAX ? "too_long" : null;
}

export function countTemplateChars(text: string): number {
  return Array.from(text.trim()).length;
}

/** 店家沒接上官方帳號時的黃色 !(C5-K02 畫面 1)。 */
export const NOT_CONNECTED_NOTE = "還沒有接上 LINE 官方帳號，接上之後才會通知客人。";
/** LINE 登入沒啟用時的灰字。 */
export const LINE_LOGIN_OFF_NOTE = "客人要用 LINE 登入加入會員後才收得到。";
/** 卡片下方說明(C5-K02 畫面 4)。 */
export const CUSTOMER_SELF_OPT_OUT_NOTE = "客人可以在會員中心自己關掉預約通知或優惠通知。";
/**
 * C5-K01 規格原文是頁面上方一行「通知客人的設定在下方『通知客人』」;但 C5-K02 把「通知客人」卡放在頁面
 * 最上方,原句的「在下方」會變成錯的 ⇒ 改成放在店家事件區塊的說明,指回上方。
 */
export const CUSTOMER_SETTINGS_POINTER =
  "下面是通知管理員、客服、服務人員的設定；通知客人的設定在上方「通知客人」。";

/** 存檔失敗的句子(依 c5-contract 2-2 的 hint;不顯示資料庫原文)。 */
export function customerLineSaveErrorMessage(err: unknown): string {
  const hint =
    typeof err === "object" && err !== null && "hint" in err
      ? (err as { hint: unknown }).hint
      : null;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code: unknown }).code
      : null;
  if (hint === "forbidden" || code === "42501") return "你沒有修改 LINE 通知設定的權限。";
  if (hint === "template_too_long") return `通知文字最多 ${CUSTOMER_LINE_TEMPLATE_MAX} 字。`;
  if (hint === "reminder_hours_invalid") return "提醒時間只能選 2、3、6、12、24 或 48 小時。";
  if (hint === "monthly_cap_invalid") return MONTHLY_CAP_INVALID_MESSAGE;
  if (hint === "template_code_invalid" || hint === "invalid_patch") {
    return "設定內容有誤，請重新整理後再試。";
  }
  return "可能是網路不穩，請稍後再試。";
}

// =========================================================================
// 5-B:每月客人通知上限(C5-Q01)與本月額度(C5-Q02)
// =========================================================================

export const MONTHLY_CAP_MAX = 100000;
export const MONTHLY_CAP_INVALID_MESSAGE = `每月上限請填 1 到 ${MONTHLY_CAP_MAX.toLocaleString("en-US")} 的整數，留空代表不限制。`;
/** 每月上限欄的 `?` 說明(C5-K02 畫面 2)。 */
export const MONTHLY_CAP_HELP =
  "到上限後這個月就不再通知客人，留下額度給員工通知和行銷。只算通知客人的訊息，員工通知、行銷、生日禮不受這個上限影響。";

export type MonthlyCapParse = { ok: true; value: number | null } | { ok: false };

/** 每月上限輸入框 → 要存的值。空白 = 不限制(null);只收 1 ~ 100,000 的整數(可以有千分位逗號)。 */
export function parseMonthlyCapInput(text: string): MonthlyCapParse {
  const t = text.trim().replace(/[,，]/g, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1 || n > MONTHLY_CAP_MAX) return { ok: false };
  return { ok: true, value: n };
}

/** 客服看到的唯讀上限(c5-contract 5B-1:看得到數字、不能改)。 */
export function formatMonthlyCapReadonly(value: number | null): string {
  return value === null
    ? "每月客人通知上限：不限制（只有商家管理員可以修改）"
    : `每月客人通知上限：${value.toLocaleString("en-US")} 則（只有商家管理員可以修改）`;
}

export function monthlyCapToInput(value: number | null): string {
  return value === null ? "" : String(value);
}

/** 停發中:有停發時間且還沒過(LINE 回本月額度用完,C5-S05)。 */
export function isQuotaBlocked(
  blockedUntil: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!blockedUntil) return false;
  const t = new Date(blockedUntil).getTime();
  return !Number.isNaN(t) && t > now;
}

export const QUOTA_BLOCKED_NOTE = "本月額度已用完，下個月 1 日恢復。";

export interface LineQuotaByCategory {
  customer: number;
  store: number;
  marketing: number;
  birthday: number;
}

/** Edge `line-quota-status` 的回傳(C5-Q02)。 */
export interface LineQuotaStatus {
  /** LINE 官方帳號方案每月則數;null = 沒有上限,或查不到(看 used 是不是也 null)。 */
  planLimit: number | null;
  /** LINE 官方帳號本月已用;null = 查不到(只顯示秒約自己的統計)。 */
  used: number | null;
  byCategory: LineQuotaByCategory;
  blockedUntil: string | null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function parseLineQuotaStatus(raw: unknown): LineQuotaStatus {
  const r = isRecord(raw) ? raw : {};
  const c = isRecord(r["by_category"]) ? r["by_category"] : {};
  return {
    planLimit: nonNegInt(r["plan_limit"]),
    used: nonNegInt(r["used"]),
    byCategory: {
      customer: nonNegInt(c["customer"]) ?? 0,
      store: nonNegInt(c["store"]) ?? 0,
      marketing: nonNegInt(c["marketing"]) ?? 0,
      birthday: nonNegInt(c["birthday"]) ?? 0,
    },
    blockedUntil: parseIsoOrNull(r["blocked_until"]),
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** 括號裡的分類:客人通知、員工通知、行銷一定列;生日禮有發才列。 */
export function formatQuotaBreakdown(c: LineQuotaByCategory): string {
  const parts = [
    `客人通知 ${fmt(c.customer)}`,
    `員工通知 ${fmt(c.store)}`,
    `行銷 ${fmt(c.marketing)}`,
  ];
  if (c.birthday > 0) parts.push(`生日禮 ${fmt(c.birthday)}`);
  return parts.join("、");
}

/**
 * 額度區的主句(C5-K02 畫面 2):
 *   查得到上限與已用 ⇒「本月已用 132／200 則（客人通知 80、員工通知 40、行銷 12）」
 *   方案沒上限 ⇒「本月已用 132 則，你的方案沒有每月上限（…）」
 *   LINE 查不到 ⇒「秒約本月已發 132 則（…）」(只算秒約自己發的)
 */
export function formatQuotaSummary(q: LineQuotaStatus): string {
  const breakdown = `（${formatQuotaBreakdown(q.byCategory)}）`;
  if (q.used !== null && q.planLimit !== null) {
    return `本月已用 ${fmt(q.used)}／${fmt(q.planLimit)} 則${breakdown}`;
  }
  if (q.used !== null) return `本月已用 ${fmt(q.used)} 則，你的方案沒有每月上限${breakdown}`;
  const c = q.byCategory;
  const total = c.customer + c.store + c.marketing + c.birthday;
  return `秒約本月已發 ${fmt(total)} 則${breakdown}`;
}

/** LINE 查不到用量時的補充說明。 */
export const QUOTA_LINE_UNAVAILABLE_NOTE =
  "暫時查不到 LINE 官方帳號的用量，上面只算秒約發出的訊息。";
/** 額度區 `?`:兩個數字為什麼可能對不上。 */
export const QUOTA_HELP =
  "「本月已用」是 LINE 官方帳號算的數字，包含你在 LINE 官方帳號後台自己發的訊息；括號裡是秒約這個月發出的則數。";

/** 用到幾 % 了(查不到上限 ⇒ null)。 */
export function quotaUsedRatio(q: LineQuotaStatus): number | null {
  if (q.used === null || q.planLimit === null || q.planLimit <= 0) return null;
  return q.used / q.planLimit;
}
