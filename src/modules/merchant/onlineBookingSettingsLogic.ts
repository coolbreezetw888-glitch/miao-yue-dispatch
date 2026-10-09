// 客戶端第 1 批(C1-D01 / C1-D02):商家設定頁「線上預約」卡片的欄位檢查。純函式,vitest 逐條驗。
//
// 🔴 這裡只是前端的第一道;資料庫有 check 當最後一道(C1-C03):
//    line_friend_url = null 或 https:// 開頭且 ≤ 300 字;min_lead_hours 0~72;travel_buffer_minutes 0~240。
//    網域限制(line.me / lin.ee / page.line.me)只放在前端(規格書 C1-C03 的決定)。

export const LINE_FRIEND_URL_MAX_LENGTH = 300;
/** C1-D02:合法的 LINE 加入好友網址開頭(含結尾斜線 ⇒ 主機名稱一定是這幾個,不會被 line.me.example.com 騙過)。 */
export const LINE_FRIEND_URL_PREFIXES = [
  "https://line.me/",
  "https://lin.ee/",
  "https://page.line.me/",
] as const;
export const LINE_FRIEND_URL_FORMAT_MESSAGE =
  "請貼上 LINE 官方帳號的加入好友網址（line.me 或 lin.ee 開頭）";

export const MIN_LEAD_HOURS_MIN = 0;
export const MIN_LEAD_HOURS_MAX = 72;
export const DEFAULT_MIN_LEAD_HOURS = 2;
export const TRAVEL_BUFFER_MINUTES_MIN = 0;
export const TRAVEL_BUFFER_MINUTES_MAX = 240;
export const DEFAULT_TRAVEL_BUFFER_MINUTES = 0;
export const DEFAULT_ALLOW_GUEST_BOOKING = true;
/** 客戶端第 4 批(C4-A01 / K01):客人自己取消的期限(服務開始前幾小時),0 = 服務開始前都可以;最多 7 天。 */
export const CUSTOMER_CANCEL_DEADLINE_HOURS_MIN = 0;
export const CUSTOMER_CANCEL_DEADLINE_HOURS_MAX = 168;
export const DEFAULT_CUSTOMER_CANCEL_DEADLINE_HOURS = 24;

export type LineFriendUrlCheck =
  { ok: true; value: string | null } | { ok: false; message: string };

/** 空白 = 清除(存 null);有填就必須是 LINE 的網址。 */
export function validateLineFriendUrl(raw: string): LineFriendUrlCheck {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > LINE_FRIEND_URL_MAX_LENGTH) {
    return { ok: false, message: `網址太長了，最多 ${LINE_FRIEND_URL_MAX_LENGTH} 個字。` };
  }
  // 網址裡不該有空白或控制字元(貼上時夾帶換行之類的)。
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, message: LINE_FRIEND_URL_FORMAT_MESSAGE };
  }
  const lower = value.toLowerCase();
  if (!LINE_FRIEND_URL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return { ok: false, message: LINE_FRIEND_URL_FORMAT_MESSAGE };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { ok: false, message: LINE_FRIEND_URL_FORMAT_MESSAGE };
  } catch {
    return { ok: false, message: LINE_FRIEND_URL_FORMAT_MESSAGE };
  }
  return { ok: true, value };
}

export type IntegerFieldCheck = { ok: true; value: number } | { ok: false; message: string };

/** 整數欄位(全形數字也收);空白、小數、負數、超出範圍都擋,並給中文提示。 */
export function parseIntegerInRange(
  raw: string,
  range: { min: number; max: number; noun: string; unit: string },
): IntegerFieldCheck {
  const normalized = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const outOfRange = `請填 ${range.min}～${range.max} 之間的整數（單位：${range.unit}）。`;
  if (normalized === "") return { ok: false, message: `請填寫${range.noun}。` };
  if (!/^-?\d+$/.test(normalized)) return { ok: false, message: outOfRange };
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    return { ok: false, message: outOfRange };
  }
  return { ok: true, value };
}

export function parseMinLeadHours(raw: string): IntegerFieldCheck {
  return parseIntegerInRange(raw, {
    min: MIN_LEAD_HOURS_MIN,
    max: MIN_LEAD_HOURS_MAX,
    noun: "提前時數",
    unit: "小時",
  });
}

export function parseCustomerCancelDeadlineHours(raw: string): IntegerFieldCheck {
  return parseIntegerInRange(raw, {
    min: CUSTOMER_CANCEL_DEADLINE_HOURS_MIN,
    max: CUSTOMER_CANCEL_DEADLINE_HOURS_MAX,
    noun: "取消期限",
    unit: "小時",
  });
}

export function parseTravelBufferMinutes(raw: string): IntegerFieldCheck {
  return parseIntegerInRange(raw, {
    min: TRAVEL_BUFFER_MINUTES_MIN,
    max: TRAVEL_BUFFER_MINUTES_MAX,
    noun: "車程緩衝分鐘數",
    unit: "分鐘",
  });
}

// =========================================================================
// 客戶端第 3 批(C3-H05,零之零 Q7):店家自訂完成頁文字(會員 / 訪客各一段)。
// 資料庫:merchant_booking_settings.completion_message_member / completion_message_guest,
// 去頭尾空白後空字串存 null、各最多 200 字(check)。留空 ⇒ 客人看到預設句。
// =========================================================================

export const COMPLETION_MESSAGE_MAX = 200;
/** 留空時客人看到的預設句(跟伺服器 coalesce 的預設一致;畫面當 placeholder)。 */
export const DEFAULT_MEMBER_COMPLETION_MESSAGE = "店家確認後會通知您。";
export const DEFAULT_GUEST_COMPLETION_MESSAGE = "店家確認後會與您聯絡。";

/** 字數(用字元算,跟資料庫 char_length 一致;emoji 算 1 個字)。 */
export function countCompletionMessageChars(raw: string): number {
  return [...raw.trim()].length;
}

export type CompletionMessageCheck =
  { ok: true; value: string | null } | { ok: false; message: string };

export function validateCompletionMessage(raw: string): CompletionMessageCheck {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if ([...value].length > COMPLETION_MESSAGE_MAX) {
    return { ok: false, message: `最多 ${COMPLETION_MESSAGE_MAX} 個字。` };
  }
  return { ok: true, value };
}
