// 客戶端第 2 批(C2):LINE 登入、填電話、訪客畫面的純函式(vitest 逐條驗)。
// 規格:.project/specs/客戶端第2批-LINE登入與訪客預約.md(🔴「零之二」優先於本文所有章節)。
//
// 這裡只放「會判斷、會轉換」的邏輯,元件只負責呈現;不呼叫任何網路。

import type { PublicSelectedItem } from "./types";

// =========================================================================
// 電話(零之二第 3 點:手機或市話都收)
// =========================================================================

/** 判斷前先去掉的排版符號:空白(含全形空白)、連字號、括號(含全形括號)。 */
const CUSTOMER_PHONE_SEPARATORS = /[\s\u3000()\uFF08\uFF09\-\uFF0D]/g;

/**
 * 去掉排版符號之後的格式:手機 09 開頭共 10 碼,或市話(0 + 區碼第二碼 2~8)共 9~10 碼。
 * ⚠️ 不收分機(零之二第 3 點);跟 src/lib/validation.ts 的 TW_PHONE_COMPACT_REGEX 同一套,只是拿掉 #分機。
 */
export const CUSTOMER_PHONE_COMPACT_REGEX = /^(?:09\d{8}|0[2-8]\d{7,8})$/;

export function compactCustomerPhone(input: string): string {
  return input.replace(CUSTOMER_PHONE_SEPARATORS, "");
}

export function isValidCustomerPhone(input: string): boolean {
  return CUSTOMER_PHONE_COMPACT_REGEX.test(compactCustomerPhone(input));
}

export const CUSTOMER_PHONE_ERROR =
  "請填 0 開頭的電話：手機 10 碼（例如 0912-345-678），市話請連同區碼（例如 02-1234-5678）。";

/** 電話欄的錯誤訊息;空白 / 格式錯 / 正確(null)。 */
export function customerPhoneError(input: string): string | null {
  if (input.trim() === "") return "請填寫電話。";
  return isValidCustomerPhone(input) ? null : CUSTOMER_PHONE_ERROR;
}

// =========================================================================
// 草稿(C2-B04:登入前選好的內容跟著 start 存到伺服器,complete 時原封不動拿回來)
// =========================================================================

/** 畫面上用的草稿(備註欄叫 note);送給 Edge Function 時轉成 toServerDraft 的格式。 */
export interface BookingDraft {
  items: PublicSelectedItem[];
  staff_id: string | null;
  /** YYYY-MM-DD(台北日曆日) */
  date: string;
  /** HH:MM */
  time: string;
  name: string;
  address: string;
  note: string;
}

/** 送給 customer-line-login start 的草稿:備註叫 notes、空白的地址 / 備註送 null。 */
export function toServerDraft(draft: BookingDraft): Record<string, unknown> {
  return {
    items: draft.items.map((i) => ({ service_item_id: i.service_item_id, quantity: i.quantity })),
    staff_id: draft.staff_id,
    date: draft.date,
    time: draft.time,
    name: draft.name,
    address: draft.address === "" ? null : draft.address,
    notes: draft.note === "" ? null : draft.note,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 伺服器還回來的草稿:逐欄檢查,格式不對就當作沒有草稿(null)—— 不讓半殘的資料進到畫面。
 * 多出來的欄位一律忽略(白名單)。
 */
export function parseBookingDraft(raw: unknown): BookingDraft | null {
  if (!isRecord(raw)) return null;
  const items = raw["items"];
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) return null;
  const parsedItems: PublicSelectedItem[] = [];
  for (const it of items) {
    if (!isRecord(it)) return null;
    const id = it["service_item_id"];
    const qty = it["quantity"];
    if (typeof id !== "string" || id === "") return null;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
    parsedItems.push({ service_item_id: id, quantity: qty });
  }
  const staffId = raw["staff_id"];
  if (staffId !== null && staffId !== undefined && typeof staffId !== "string") return null;
  const date = raw["date"];
  const time = raw["time"];
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  if (typeof time !== "string" || !TIME_RE.test(time.slice(0, 5))) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    items: parsedItems,
    staff_id: typeof staffId === "string" && staffId !== "" ? staffId : null,
    date,
    time: time.slice(0, 5),
    name: text(raw["name"]),
    address: text(raw["address"]),
    // Edge Function 存的欄位名是 notes(跟 bookings.notes 一致)。
    note: text(raw["notes"] ?? raw["note"]),
  };
}

// ─── 登入回來之後,草稿怎麼交給預約頁 ───
// 只放在記憶體(同一個分頁、SPA 內換頁才拿得到):重新整理就沒了 ⇒ 預約頁回到 ①(C2-E07)。
// 拿一次就清掉(take),同一份草稿不會被套用兩次。

export interface PendingDraft {
  draft: BookingDraft | null;
  /** 這次回來的原因:登入成功 / 客人在 LINE 畫面按了取消 / LINE 那邊沒有成功(line_error)。 */
  outcome: "logged_in" | "cancelled" | "failed";
}

const pendingDrafts = new Map<string, PendingDraft>();

export function putPendingDraft(slug: string, value: PendingDraft): void {
  pendingDrafts.set(slug, value);
}

export function takePendingDraft(slug: string): PendingDraft | null {
  const value = pendingDrafts.get(slug) ?? null;
  pendingDrafts.delete(slug);
  return value;
}

// ─── 登入失敗時「回店家首頁」要用的代碼 ───
// state 失效時伺服器查不到是哪間店,所以出發前把**預約頁代碼**(不是個資)記在這個分頁的 sessionStorage。

export const LINE_LOGIN_SLUG_STORAGE_KEY = "miaoyue-line-login-slug";

export function rememberLoginSlug(slug: string): void {
  try {
    window.sessionStorage.setItem(LINE_LOGIN_SLUG_STORAGE_KEY, slug);
  } catch {
    // 瀏覽器不讓存也沒關係:只是登入失敗時少一顆「回店家首頁」。
  }
}

export function recallLoginSlug(): string | null {
  try {
    const v = window.sessionStorage.getItem(LINE_LOGIN_SLUG_STORAGE_KEY);
    return v && /^[a-z0-9-]{1,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// ─── C4-B02:從會員中心登入頁出發的 LINE 登入,在 LINE 按「取消」回來時要回到會員中心(不是 ①) ───
// 只記「這次是從會員中心出發」這一件事(不是個資、不是網址),只在這個分頁的 sessionStorage。

export const LINE_LOGIN_ORIGIN_STORAGE_KEY = "miaoyue-line-login-origin";

export function rememberLoginOrigin(origin: "member_center" | null): void {
  try {
    if (origin) window.sessionStorage.setItem(LINE_LOGIN_ORIGIN_STORAGE_KEY, origin);
    else window.sessionStorage.removeItem(LINE_LOGIN_ORIGIN_STORAGE_KEY);
  } catch {
    // 不讓存:取消登入時回 ①,可以接受。
  }
}

/** 拿一次就清掉。 */
export function takeLoginOrigin(): "member_center" | null {
  try {
    const v = window.sessionStorage.getItem(LINE_LOGIN_ORIGIN_STORAGE_KEY);
    window.sessionStorage.removeItem(LINE_LOGIN_ORIGIN_STORAGE_KEY);
    return v === "member_center" ? v : null;
  } catch {
    return null;
  }
}

/** 只看不拿(預約頁第一次 render 決定初始值時用;真正拿走在 effect 裡)。 */
export function peekPendingDraft(slug: string): PendingDraft | null {
  return pendingDrafts.get(slug) ?? null;
}

// =========================================================================
// 登入狀態(C2-C05,依零之二刪掉 pending_* / rejected)
// =========================================================================

export type CustomerSessionState =
  | { state: "anonymous" }
  | { state: "needs_profile"; lineDisplayName: string | null; linePictureUrl: string | null }
  | {
      state: "linked";
      memberName: string;
      memberPhone: string | null;
      /** C4-E05(⚠️範圍 第 3 點):自己的會員地址;預約頁 ⑤ 地址欄空白時帶入。 */
      memberAddress: string | null;
    };

/**
 * get_customer_session_state 的回傳 → 畫面要的狀態。
 * not_customer / line_login_unavailable / channel_mismatch / 看不懂的值 ⇒ 都當「沒登入」(anonymous)。
 */
export function parseCustomerSessionState(raw: unknown): CustomerSessionState {
  if (!isRecord(raw)) return { state: "anonymous" };
  const state = raw["state"];
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  if (state === "needs_profile") {
    return {
      state: "needs_profile",
      lineDisplayName: str(raw["line_display_name"]),
      linePictureUrl: safeImageUrl(raw["line_picture_url"]),
    };
  }
  if (state === "linked") {
    // 資料庫回 member: { name, phone }(只有自己的會員資料);第 4 批起多 address(C4-E05)。
    // address 放在 member 裡或最外層都收(以 c4-contract 為準)。
    const member = isRecord(raw["member"]) ? raw["member"] : {};
    return {
      state: "linked",
      memberName: str(member["name"]) ?? "",
      memberPhone: str(member["phone"]),
      memberAddress: str(member["address"]) ?? str(raw["address"]),
    };
  }
  return { state: "anonymous" };
}

/** C2-F09:頭像只接受 https:// 網址,其他(javascript:、data:、http:)一律不顯示。 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 頭像沒有圖時顯示的字:中文名取最後兩個中文字(同預覽圖「王小明」⇒「小明」);
 * 其他(英文、數字開頭的 LINE 名稱)取第一個字並轉大寫。
 */
export function lineAvatarText(name: string | null): string {
  const chars = [...(name ?? "").replace(/\s/g, "")];
  if (chars.length === 0) return "LINE";
  const cjk = chars.filter((c) => CJK_RE.test(c));
  if (cjk.length > 0) return cjk.slice(-2).join("");
  return (chars[0] ?? "").toUpperCase();
}

// =========================================================================
// customer_complete_profile 的結果(零之二第 1 點)
// =========================================================================

export type CompleteProfileResult =
  | { kind: "linked"; created: boolean; existing: boolean }
  | { kind: "phone_taken" }
  /** 資料庫用 state 回的「不能繼續」:too_many_attempts / line_login_unavailable / channel_mismatch。 */
  | { kind: "rejected"; hint: string };

const COMPLETE_PROFILE_REJECTED_STATES = new Set([
  "too_many_attempts",
  "line_login_unavailable",
  "channel_mismatch",
  "not_customer",
]);

export function parseCompleteProfileResult(raw: unknown): CompleteProfileResult | null {
  if (!isRecord(raw)) return null;
  const state = raw["state"];
  if (state === "phone_taken") return { kind: "phone_taken" };
  if (typeof state === "string" && COMPLETE_PROFILE_REJECTED_STATES.has(state)) {
    return { kind: "rejected", hint: state };
  }
  if (raw["state"] === "linked") {
    return {
      kind: "linked",
      created: raw["created"] === true,
      existing: raw["existing"] === true,
    };
  }
  return null;
}

// =========================================================================
// 錯誤代碼 → 畫面上的話(固定中文,不顯示伺服器原文)
// =========================================================================

/** ⑥-1 按「用 LINE 登入」失敗時。 */
export function lineStartErrorMessage(code: string | null): string {
  switch (code) {
    case "line_login_unavailable":
      return "這間店目前無法使用 LINE 登入，請直接聯絡店家。";
    case "rate_limited":
      return "操作太頻繁，請稍等幾分鐘再試。";
    case "invalid_draft":
      return "預約內容有誤，請回上一步重新確認。";
    case "server_error":
      return "系統忙碌，請稍後再試。";
    default:
      return "目前無法連到 LINE，請稍後再試。";
  }
}

/** /auth/line/callback 失敗時。 */
export function lineCompleteErrorMessage(code: string | null): string {
  switch (code) {
    case "login_expired":
      return "登入逾時，請回到預約頁重新操作。";
    case "line_error":
      return "LINE 登入沒有成功，請再試一次。";
    case "line_login_unavailable":
      return "這間店目前無法使用 LINE 登入，請直接聯絡店家。";
    case "server_error":
      return "系統忙碌，請稍後再試。";
    default:
      return "LINE 登入沒有成功，請再試一次。";
  }
}

/** ⑥-2 按「完成登入」失敗時(依資料庫回的 hint)。 */
export function completeProfileErrorMessage(hint: string | null): string {
  switch (hint) {
    case "too_many_attempts":
      return "嘗試次數太多，請明天再試或直接聯絡店家。";
    case "invalid_phone":
      return CUSTOMER_PHONE_ERROR;
    case "policy_not_agreed":
      return "請先勾選同意會員政策與隱私權政策。";
    case "line_login_unavailable":
      return "這間店目前無法使用 LINE 登入，請直接聯絡店家。";
    case "channel_mismatch":
    case "not_customer":
      return "登入狀態已失效，請重新用 LINE 登入。";
    case "invalid_name":
      return "姓名最多 50 個字，請回上一步修改。";
    case "retry":
      return "系統忙碌，請稍後再試一次。";
    default:
      return "送出失敗，請稍後再試。你填的資料沒有遺失。";
  }
}

/** 這些錯誤代表「登入狀態不能用了」⇒ 畫面要回到 ⑥-1 重新登入。 */
export function isSessionInvalidHint(hint: string | null): boolean {
  return hint === "channel_mismatch" || hint === "not_customer";
}

// =========================================================================
// 轉址安全(C2-F04:不開放轉址)
// =========================================================================

/**
 * start 回來的授權網址只接受兩種:LINE 官方授權頁,或本站自己的 callback(本機 e2e 的模擬回應)。
 * 其他任何網址一律不跳(就算伺服器被騙回傳了奇怪的網址,客人也不會被帶去別的網站)。
 */
export function isAllowedAuthorizeUrl(value: string, siteOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && url.host === "access.line.me") {
    return url.pathname.startsWith("/oauth2/");
  }
  return url.origin === siteOrigin && url.pathname === LINE_CALLBACK_PATH;
}

export const LINE_CALLBACK_PATH = "/auth/line/callback";

/** callback 網址上的參數(只讀這三個,其他一律忽略)。 */
export interface LineCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
}

export function readLineCallbackParams(search: string): LineCallbackParams {
  const params = new URLSearchParams(search);
  const pick = (key: string) => {
    const v = params.get(key);
    return v && v.length <= 2048 ? v : null;
  };
  return { code: pick("code"), state: pick("state"), error: pick("error") };
}

// =========================================================================
// 同意勾選框(C2-C06)
// =========================================================================

/** 商家有開會員政策而且有內容 ⇒「會員政策 與 隱私權政策」;否則只有「隱私權政策」。 */
export function hasMemberPolicy(policy: { enabled: boolean; content: string | null }): boolean {
  return policy.enabled && (policy.content ?? "").trim() !== "";
}
