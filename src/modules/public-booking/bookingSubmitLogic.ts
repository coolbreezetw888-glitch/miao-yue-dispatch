// 客戶端第 3 批(C3-D01~D07):送出預約、失敗畫面、完成頁用的純函式(vitest 逐條驗)。
// 規格:.project/specs/客戶端第3批-送出預約與通知店家.md(🔴「零之零」2026-10-09 定案優先於本文)。
//
// 這裡只放「會判斷、會轉換」的邏輯,不呼叫網路;畫面元件只負責呈現。
// 🔴 伺服器回的任何文字(店家自訂完成頁文字、服務人員顯示名、項目名稱)一律當純文字交給 React 文字節點,
//    不解析 HTML(C3-F05)。

import { CUSTOMER_PHONE_ERROR } from "./customerLoginLogic";
import { formatDateWithWeekday } from "./publicBookingLogic";

// =========================================================================
// 送出結果(C3-A05 / C3-B01 / C3-D05)
// =========================================================================

/** Edge Function `customer-booking-submit` 用 state 回的「沒有建立訂單」結果。 */
export const SUBMIT_REJECT_STATES = [
  "unavailable",
  "not_linked",
  "guest_not_allowed",
  "guest_unavailable",
  "slot_taken",
  "too_many_open",
  "contact_store",
  "bot_check_failed",
  "rate_limited",
] as const;
export type SubmitRejectState = (typeof SUBMIT_REJECT_STATES)[number];

/**
 * c3-contract 1-4:HTTP 400 `{ state:'invalid_request', hint }` 的 hint(正常操作不會發生;依代碼顯示對應句子)。
 */
export const SUBMIT_INVALID_HINTS = [
  "invalid_draft",
  "invalid_phone",
  "policy_not_agreed",
  "address_required",
  "invalid_items",
  "no_primary_item",
  "invalid_duration",
  "duration_too_long",
  "invalid_request",
] as const;
export type SubmitInvalidHint = (typeof SUBMIT_INVALID_HINTS)[number];

export function toSubmitInvalidHint(value: unknown): SubmitInvalidHint {
  return typeof value === "string" && (SUBMIT_INVALID_HINTS as readonly string[]).includes(value)
    ? (value as SubmitInvalidHint)
    : "invalid_request";
}

/**
 * 前端自己加的失敗:斷線 / 伺服器錯(403、500、看不懂的回應)/ Turnstile 沒通過 / 400 的 hint。
 * 斷線與伺服器錯重按時沿用同一個 submission_id。
 */
export type SubmitFailureCode =
  SubmitRejectState | SubmitInvalidHint | "network" | "server_error" | "bot_check_error";

export type SubmittedBookingStatus = "pending_confirmation" | "accepted";

/** 完成頁要用的資料(C3-A05 白名單;多出來的欄位一律丟掉)。 */
export interface SubmittedBooking {
  status: SubmittedBookingStatus;
  startAt: string;
  endAt: string;
  /** 零之零 Q5:一律是被排到的那位的顯示名(不指定也回);萬一是 null 畫面顯示「由店家安排」。 */
  staffDisplay: string | null;
  items: { name: string; quantity: number }[];
  address: string | null;
  /** 只有訪客送出才有(訪客自己填的電話)。 */
  phone: string | null;
  estimatedAmount: number;
  isGuest: boolean;
  /** 零之零 Q7:店家自訂的完成頁說明(會員 / 訪客各一段);沒填 ⇒ 伺服器回預設句,前端再保底一次。 */
  completionMessage: string;
}

export type SubmitOutcome =
  { kind: "created"; booking: SubmittedBooking } | { kind: "rejected"; state: SubmitRejectState };

/** 零之零 C3-A05 / c3-contract 1-2:店家沒填時的預設句(由伺服器決定;這裡只是伺服器沒給時的保底)。 */
export const DEFAULT_MEMBER_COMPLETION_MESSAGE = "店家確認後會通知您。";
/** 第 5 批 C5-M04:店家能用 LINE 通知客人時的會員待確認預設句(伺服器沒給時的保底)。 */
export const DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE = "店家確認後會用 LINE 通知您。";
export const DEFAULT_MEMBER_ACCEPTED_COMPLETION_MESSAGE = "服務前店家可能會再跟您聯絡確認。";
export const DEFAULT_GUEST_COMPLETION_MESSAGE = "店家確認後會與您聯絡。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Edge Function 的回應 → 前端結果。看不懂的一律回 null(呼叫端當「伺服器錯」處理,畫面保留、可以重按)。
 * `completion_message` 在**最外層**(跟 state 同層;c3-contract 1-2,主腦 10/9 定案),預設句由伺服器決定。
 */
export function parseSubmitResponse(
  raw: unknown,
  options: {
    /**
     * C5-M04:預約頁 booking_settings.line_notify_available。只影響「伺服器沒給 completion_message」時的
     * 前端保底句;正式的句子(含「店家確認」通知有沒有開)由伺服器決定。
     */
    lineNotifyAvailable?: boolean;
  } = {},
): SubmitOutcome | null {
  if (!isRecord(raw)) return null;
  const state = raw["state"];
  if (typeof state !== "string") return null;
  if ((SUBMIT_REJECT_STATES as readonly string[]).includes(state)) {
    return { kind: "rejected", state: state as SubmitRejectState };
  }
  if (state !== "created") return null;
  const b = raw["booking"];
  if (!isRecord(b)) return null;
  const status = b["status"];
  if (status !== "pending_confirmation" && status !== "accepted") return null;
  const startAt = nonEmptyString(b["start_at"]);
  const endAt = nonEmptyString(b["end_at"]);
  if (!startAt || !endAt || Number.isNaN(new Date(startAt).getTime())) return null;
  const rawItems = Array.isArray(b["items"]) ? b["items"] : [];
  const items: { name: string; quantity: number }[] = [];
  for (const it of rawItems) {
    if (!isRecord(it)) continue;
    const name = nonEmptyString(it["name"]);
    const qty = it["quantity"];
    if (!name || typeof qty !== "number" || !Number.isFinite(qty)) continue;
    items.push({ name, quantity: qty });
  }
  const amount = b["estimated_amount"];
  const isGuest = b["is_guest"] === true;
  const message = nonEmptyString(raw["completion_message"]);
  return {
    kind: "created",
    booking: {
      status,
      startAt,
      endAt,
      staffDisplay: nonEmptyString(b["staff_display"]),
      items,
      address: nonEmptyString(b["address"]),
      phone: isGuest ? nonEmptyString(b["phone"]) : null,
      estimatedAmount:
        typeof amount === "number" && Number.isFinite(amount)
          ? amount
          : typeof amount === "string" && amount.trim() !== "" && Number.isFinite(Number(amount))
            ? Number(amount)
            : 0,
      isGuest,
      completionMessage:
        message ??
        (isGuest
          ? DEFAULT_GUEST_COMPLETION_MESSAGE
          : status === "accepted"
            ? DEFAULT_MEMBER_ACCEPTED_COMPLETION_MESSAGE
            : options.lineNotifyAvailable === true
              ? DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE
              : DEFAULT_MEMBER_COMPLETION_MESSAGE),
    },
  };
}

// =========================================================================
// 失敗畫面(C3-D05):依 state 顯示前端自己的句子,不顯示伺服器原文
// =========================================================================

export interface SubmitFailureView {
  code: SubmitFailureCode;
  message: string;
  /** 顯示「LINE 聯絡店家 / 撥打電話」。 */
  showContacts: boolean;
  /** 顯示「用 LINE 登入」(訪客不開放、店家有 LINE 登入時)。 */
  showLineLogin: boolean;
}

export const SLOT_TAKEN_MESSAGE = "這個時段剛剛被約走了，請重新選一個時間。";
export const BOT_CHECK_FAILED_MESSAGE = "安全檢查沒有通過，請重新整理後再試一次。";
export const GUEST_NOT_OPEN_MESSAGE = "這家店目前不開放不登入預約。";
export const TURNSTILE_UNSUPPORTED_MESSAGE =
  "這個瀏覽器無法完成安全檢查。請改用手機內建瀏覽器開啟，或用 LINE 登入預約。";
export const GUEST_CHECK_UNAVAILABLE_MESSAGE = "目前無法不登入預約，請用 LINE 登入或聯絡店家。";

export function submitFailureView(
  code: SubmitFailureCode,
  ctx: { lineLoginEnabled: boolean },
): SubmitFailureView {
  const base = { code, showContacts: false, showLineLogin: false };
  switch (code) {
    case "slot_taken":
      return { ...base, message: SLOT_TAKEN_MESSAGE };
    case "too_many_open":
      return {
        ...base,
        message: "您目前已有 3 筆尚未完成的預約，請等服務完成後再預約，或直接聯絡店家。",
        showContacts: true,
      };
    case "contact_store":
      return {
        ...base,
        message: "這支電話需要店家協助處理，請直接聯絡店家。",
        showContacts: true,
      };
    case "not_linked":
      return { ...base, message: "登入狀態已失效，請重新用 LINE 登入。" };
    case "guest_not_allowed":
    case "guest_unavailable":
      return {
        ...base,
        message: GUEST_NOT_OPEN_MESSAGE,
        showLineLogin: ctx.lineLoginEnabled,
        showContacts: !ctx.lineLoginEnabled,
      };
    case "bot_check_failed":
    case "bot_check_error":
      return { ...base, message: BOT_CHECK_FAILED_MESSAGE, showContacts: true };
    case "unavailable":
      return {
        ...base,
        message: "這間店目前暫停線上預約，如需預約，請直接聯絡店家。",
        showContacts: true,
      };
    case "rate_limited":
      return { ...base, message: "操作太頻繁，請稍後再試。" };
    // c3-contract 1-4:400 的 hint(正常操作不會發生)
    case "invalid_phone":
      return { ...base, message: CUSTOMER_PHONE_ERROR };
    case "policy_not_agreed":
      return { ...base, message: "請先勾選同意，才能送出預約。" };
    case "address_required":
      return { ...base, message: "到府服務要填服務地址，請回上一步填寫。" };
    case "no_primary_item":
      return { ...base, message: "請至少選一項主要服務，請回上一步重新選擇。" };
    case "duration_too_long":
      return { ...base, message: "選的服務太多，請聯絡店家。", showContacts: true };
    case "invalid_duration":
      return { ...base, message: "這些服務沒有設定工時，請直接聯絡店家。", showContacts: true };
    case "invalid_items":
    case "invalid_draft":
      return { ...base, message: "預約內容有誤，請回上一步重新確認。" };
    case "invalid_request":
    case "network":
    case "server_error":
    default:
      return { ...base, message: "送出時發生問題，請稍後再試。您填的資料沒有遺失。" };
  }
}

// =========================================================================
// 防重送(C3-A03 第 1 步):每次進入「確認送出」畫面產生一個 submission_id;
// 網路錯誤重按時沿用同一個(伺服器看到同一個 id 只會回同一張單)。
// =========================================================================

export function newSubmissionId(): string {
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // 舊瀏覽器保底:依 RFC 4122 v4 格式組(getRandomValues 幾乎所有瀏覽器都有)。
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// =========================================================================
// 完成頁(C3-D06)
// =========================================================================

export type CompletionKind = "member_pending" | "member_accepted" | "guest";

/** ⑦-1 會員待確認 / ⑦-2 會員直接成立 / ⑦-3 訪客(訪客一律待確認)。 */
export function completionKind(
  booking: Pick<SubmittedBooking, "isGuest" | "status">,
): CompletionKind {
  if (booking.isGuest) return "guest";
  return booking.status === "accepted" ? "member_accepted" : "member_pending";
}

const TAIPEI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISO 時間 → 台北的「10月13日（二）10:00」。 */
export function formatSubmittedStart(iso: string): string {
  const parts = TAIPEI_PARTS.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return `${formatDateWithWeekday(date)}${get("hour")}:${get("minute")}`;
}

/** 完成頁「項目」欄:「室內機清洗 ×2、室外機清洗 ×1」。 */
export function formatSubmittedItems(items: { name: string; quantity: number }[]): string {
  return items.map((i) => `${i.name} ×${i.quantity}`).join("、");
}

// =========================================================================
// LINE 內建瀏覽器(C3-D04):Turnstile 不支援時,提供「用瀏覽器開啟」。
// LINE 官方文件〈Using LINE features with the LINE URL scheme〉:網址加 `openExternalBrowser=1`
// ⇒ 從 LINE App 開啟時改用外部瀏覽器(LIFF 除外)。2026-10-09 查證。
// =========================================================================

export function isLineInAppBrowser(userAgent: string): boolean {
  return /\bLine\/\d/i.test(userAgent);
}

/** 目前網址加上 openExternalBrowser=1(保留原本的路徑,不帶 hash)。 */
export function externalBrowserUrl(href: string): string {
  const url = new URL(href);
  url.hash = "";
  url.searchParams.set("openExternalBrowser", "1");
  return url.toString();
}
