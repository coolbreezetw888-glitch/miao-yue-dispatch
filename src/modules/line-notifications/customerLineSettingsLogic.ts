// 客戶端第 5 批 5-A(C5-K02 / C5-N13 / C5-Q03):後台「LINE 通知事件」頁「通知客人」卡的純邏輯。
// 規格:.project/specs/客戶端第5批-LINE通知與綁定.md;介面:.project/notes/c5-contract.md(甲)。
//
// ・只放 5-A 的 6 種通知(N01~N06)。服務前提醒(N07)、服務完成(N08)、聯絡人通知(N09~N11)、
//   每月上限 / 額度(Q01、Q02、Q04)是 5-B,這裡不出現(不承諾還沒做的功能)。
// ・範本代入:前端自己一份小函式(模組 11 判斷 11 的做法),要跟 Edge `customer-line-notify-dispatch`
//   的代入結果一致:變數只代入一次(不遞迴)、對應不到的維持原樣、店家沒填電話 ⇒ 含 {{merchant_phone}}
//   的那一整行拿掉、姓名去掉換行、整則截到 5,000 字。

// =========================================================================
// 種類與範本代碼
// =========================================================================

/** 5-A 的開關欄位(merchant_customer_line_settings,C5-A02)。 */
export const CUSTOMER_LINE_SWITCH_KEYS = [
  "on_submitted",
  "on_scheduled_by_store",
  "on_confirmed",
  "on_rescheduled",
  "on_cancelled_by_store",
  "on_cancelled_by_customer",
] as const;
export type CustomerLineSwitchKey = (typeof CUSTOMER_LINE_SWITCH_KEYS)[number];

/** 5-A 的範本代碼(C5-N13)。 */
export const CUSTOMER_LINE_TEMPLATE_CODES = [
  "submitted_pending",
  "submitted_accepted",
  "scheduled_by_store",
  "confirmed",
  "rescheduled",
  "cancelled_by_store",
  "cancelled_by_customer",
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
};

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
];

// =========================================================================
// 預設文案(C5-N13)與變數
// =========================================================================

/** 範本裡的換行一律用 \n(畫面上 `<br>` 的意思)。 */
export const CUSTOMER_LINE_DEFAULT_TEMPLATES: Record<CustomerLineTemplateCode, string> = {
  submitted_pending:
    "「{{merchant_name}}」已收到你的預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n店家確認後會再用 LINE 通知你。\n查看預約：{{member_center_url}}",
  submitted_accepted:
    "「{{merchant_name}}」預約成功：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  scheduled_by_store:
    "「{{merchant_name}}」已為你安排預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n查看預約：{{member_center_url}}",
  confirmed:
    "「{{merchant_name}}」已確認你的預約：\n{{booking_date}} {{booking_time}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
  rescheduled:
    "「{{merchant_name}}」調整了你的預約時間：\n原本：{{old_booking_date}} {{old_booking_time}}\n改為：{{booking_date}} {{booking_time}}\n如果時間不方便，請聯絡店家：{{merchant_phone}}",
  cancelled_by_store:
    "「{{merchant_name}}」取消了你 {{booking_date}} {{booking_time}} 的預約。\n有問題請聯絡店家：{{merchant_phone}}",
  cancelled_by_customer:
    "你們在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。",
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
  switches: Record<CustomerLineSwitchKey, boolean>;
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

/**
 * 伺服器回傳(c5-contract 2-1)→ 畫面用的設定。看不懂的欄位一律用預設值(鐵律 8:沒有列 = 預設)。
 * 5-B 的欄位(提醒、完成、聯絡人、上限、停發)伺服器會回,這裡先不讀(畫面不顯示)。
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
    switches,
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
export const CUSTOMER_SELF_OPT_OUT_NOTE = "客人可以在會員中心自己關掉預約通知。";
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
  if (hint === "template_code_invalid" || hint === "invalid_patch") {
    return "設定內容有誤，請重新整理後再試。";
  }
  return "可能是網路不穩，請稍後再試。";
}
