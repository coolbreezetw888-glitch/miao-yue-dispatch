// 客戶端第 4 批 4-A(C4-B~E、W):會員中心 `/booking/<代碼>/me` 的純函式(vitest 逐條驗)。
// 規格:.project/specs/客戶端第4批-會員中心與自己取消.md(🔴「零之零」2026-10-09 定案優先於本文)。
//
// 這裡只放「會判斷、會轉換」的邏輯,不呼叫網路;畫面元件只負責呈現。
// 🔴 伺服器回的任何文字(服務人員顯示名、項目名稱、會員姓名、地址)一律當純文字交給 React 文字節點,
//    不解析 HTML(C4-F05)。
// 🔴 回傳一律逐欄挑白名單:伺服器多給的欄位(就算哪天不小心多回了內部備註)畫面也拿不到。

import { REFERRAL_UI_HIDDEN } from "@/modules/members/referralVisibility";
import { EMAIL_REGEX } from "@/lib/validation";

import type { StatusTone } from "@/components/patterns";

import { formatSubmittedItems, formatSubmittedStart } from "./bookingSubmitLogic";
import type { CustomerSessionState } from "./customerLoginLogic";
import { parseMemberLineNotify, type MemberLineNotify } from "./lineNotifyLogic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function validIso(value: unknown): string | null {
  const s = text(value);
  return s && !Number.isNaN(new Date(s).getTime()) ? s : null;
}

// =========================================================================
// 網址(C4 第二節)
// =========================================================================

export type MemberCenterTab = "home" | "bookings" | "wallet" | "profile";

export function memberCenterPath(slug: string, tab: MemberCenterTab = "home"): string {
  return tab === "home" ? `/booking/${slug}/me` : `/booking/${slug}/me/${tab}`;
}

// =========================================================================
// 會員中心狀態機(C4-B02 / B03 / B05)
// =========================================================================

/**
 * 打開 `/me` 要顯示哪一種畫面:
 *   closed  這間店沒有開放會員中心(停用 / 找不到 / 沒啟用 LINE 登入;零之一第 1 點:只開給有 LINE 登入的店)
 *   loading 還在問伺服器登入狀態
 *   login   C4-B02 會員中心登入頁(沒登入 / 登入失效)
 *   profile ⑥-2 填電話「加入會員」(用 LINE 登入了、還沒接上會員)
 *   join_pending  C4-H04 填的電話已經是別人的會員,加入聯絡人申請等主要聯絡人確認中
 *   center  會員中心本體
 */
export type MemberCenterView =
  "closed" | "loading" | "login" | "profile" | "join_pending" | "center";

export function resolveMemberCenterView(input: {
  pageStatus: "ok" | "not_found" | "unavailable";
  lineLoginEnabled: boolean;
  session: CustomerSessionState | null;
}): MemberCenterView {
  if (input.pageStatus !== "ok" || !input.lineLoginEnabled) return "closed";
  if (input.session === null) return "loading";
  switch (input.session.state) {
    case "linked":
      return "center";
    case "needs_profile":
      return "profile";
    case "join_pending":
      return "join_pending";
    default:
      return "login";
  }
}

/** 伺服器說「這個登入狀態在這間店不能用」⇒ 回 C4-B02(C4-B05、C4-H10「等於登出」)。 */
export const MEMBER_SESSION_LOST_STATES = new Set([
  "not_linked",
  "channel_mismatch",
  "not_customer",
]);

/**
 * 登入回來時跳一次的提示(C4-B03):
 *   既有連結再登入 ⇒「已登入『店名』會員中心」;這次才接上 / 新建會員 ⇒「已加入『店名』會員」。
 */
export function memberArrivalToast(merchantName: string, joinedNow: boolean): string {
  return joinedNow ? `已加入「${merchantName}」會員` : `已登入「${merchantName}」會員中心`;
}

// =========================================================================
// 會員端預約摘要(C4-A03 白名單)
// =========================================================================

export type MemberBookingStatus = "pending_confirmation" | "accepted" | "completed" | "cancelled";

export interface MemberBookingItem {
  name: string;
  quantity: number;
}

export interface MemberBooking {
  id: string;
  startAt: string;
  endAt: string;
  status: MemberBookingStatus;
  staffDisplay: string | null;
  items: MemberBookingItem[];
  address: string | null;
  amount: number;
  pointsRedeemed: number;
  bookedBy: string | null;
  canCancel: boolean;
  cancelDeadlineAt: string | null;
}

/** C4-A03:`pending_reply / dispatching`(目前沒用到)一律當「待確認」;看不懂的值也當待確認。 */
export function normalizeMemberBookingStatus(value: unknown): MemberBookingStatus {
  if (value === "accepted" || value === "completed" || value === "cancelled") return value;
  return "pending_confirmation";
}

export function parseMemberBooking(raw: unknown): MemberBooking | null {
  if (!isRecord(raw)) return null;
  const id = text(raw["id"]);
  const startAt = validIso(raw["start_at"]);
  const endAt = validIso(raw["end_at"]) ?? startAt;
  if (!id || !startAt || !endAt) return null;
  const items: MemberBookingItem[] = [];
  for (const it of Array.isArray(raw["items"]) ? raw["items"] : []) {
    if (!isRecord(it)) continue;
    const name = text(it["name"]);
    const quantity = num(it["quantity"], NaN);
    if (!name || !Number.isFinite(quantity)) continue;
    items.push({ name, quantity });
  }
  const canCancel = raw["can_cancel"] === true;
  return {
    id,
    startAt,
    endAt,
    status: normalizeMemberBookingStatus(raw["status"]),
    staffDisplay: text(raw["staff_display"]),
    items,
    address: text(raw["address"]),
    amount: num(raw["amount"]),
    pointsRedeemed: num(raw["points_redeemed"]),
    bookedBy: text(raw["booked_by"]),
    canCancel,
    cancelDeadlineAt: validIso(raw["cancel_deadline_at"]),
  };
}

/** 狀態標籤:文字 + 顏色(沿用後台 StatusTag 的語意色:要處理=黃、正常=綠、結束=灰、取消=紅)。 */
export function memberBookingStatusView(status: MemberBookingStatus): {
  label: string;
  tone: StatusTone;
} {
  switch (status) {
    case "accepted":
      return { label: "已確認", tone: "success" };
    case "completed":
      return { label: "已完成", tone: "neutral" };
    case "cancelled":
      return { label: "已取消", tone: "danger" };
    default:
      return { label: "待確認", tone: "warning" };
  }
}

const TAIPEI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function taipeiParts(iso: string) {
  const parts = TAIPEI_PARTS.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: String(Number(get("month"))),
    day: String(Number(get("day"))),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * 卡片上的時間:即將到來「10月13日（二）10:00」;歷史分頁加年份「2026年10月2日（五）14:00」(預覽圖 ⑨-3)。
 */
export function formatMemberBookingTime(iso: string, withYear: boolean): string {
  const base = formatSubmittedStart(iso);
  return withYear ? `${taipeiParts(iso).year}年${base}` : base;
}

/** 取消期限「10月12日 10:00」(預覽圖 ⑨-1,不寫星期)。 */
export function formatCancelDeadline(iso: string): string {
  const p = taipeiParts(iso);
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
}

/** 「室內機清洗 ×2、室外機清洗 ×1」(同完成頁 ⑦)。 */
export function formatMemberBookingItems(items: MemberBookingItem[]): string {
  return formatSubmittedItems(items);
}

/** 讀不到店家設定時的取消期限(C4-A01 預設 24 小時;鐵律 8 coalesce)。 */
export const DEFAULT_CUSTOMER_CANCEL_DEADLINE_HOURS = 24;

export function normalizeCancelDeadlineHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 168 ? n : DEFAULT_CUSTOMER_CANCEL_DEADLINE_HOURS;
}

/**
 * 卡片下方的取消區(C4-C04、C4-D01):
 *   can_cancel ⇒「10月12日 10:00 以前可以取消」+「取消預約」
 *   不能取消、但還是待確認 / 已確認 ⇒「服務前 N 小時內不能線上取消，請直接聯絡店家」+ 聯絡按鈕
 *   已完成 / 已取消 ⇒ 沒有取消區
 * 「能不能取消」只看伺服器給的 can_cancel(C4-D01:看得到按鈕 = 取消得了),前端不自己算期限。
 */
export type CancelAreaView =
  { kind: "can_cancel"; text: string } | { kind: "contact"; text: string } | { kind: "none" };

export function cancelAreaView(booking: MemberBooking, deadlineHours: number): CancelAreaView {
  if (booking.status === "completed" || booking.status === "cancelled") return { kind: "none" };
  if (booking.canCancel) {
    return {
      kind: "can_cancel",
      text: booking.cancelDeadlineAt
        ? `${formatCancelDeadline(booking.cancelDeadlineAt)} 以前可以取消`
        : "服務開始前可以取消",
    };
  }
  // N = 0(服務開始前都能取消)還不能取消 ⇒ 服務已經開始了,「服務前 0 小時內」讀起來不通。
  if (deadlineHours === 0) {
    return { kind: "contact", text: "服務已經開始，不能線上取消，請直接聯絡店家" };
  }
  return {
    kind: "contact",
    text: `服務前 ${deadlineHours} 小時內不能線上取消，請直接聯絡店家`,
  };
}

/** ⑨-2 取消確認窗(C4-D06,逐字)。 */
export function cancelConfirmTitle(booking: MemberBooking): string {
  return `確定要取消 ${formatSubmittedStart(booking.startAt)} 的預約嗎？`;
}
export const CANCEL_CONFIRM_BODY =
  "取消後這個時段會開放給其他人預約，店家也會收到通知。想改時間的話，請取消後重新預約。";

// =========================================================================
// 取消結果(C4-D03 / C4-D06)
// =========================================================================

export const CANCEL_RESULT_STATES = [
  "cancelled",
  "already_cancelled",
  "deadline_passed",
  "not_cancellable",
  "not_found",
  "not_linked",
  "unavailable",
  "rate_limited",
] as const;
export type CancelResultState = (typeof CANCEL_RESULT_STATES)[number];

export type CancelFailureCode = CancelResultState | "network" | "server_error";

export interface CancelResultView {
  /** 關掉確認窗(false = 保留視窗、可以再按一次)。 */
  closeDialog: boolean;
  /** 成功 toast。 */
  toast: string | null;
  /** 畫面上要顯示的說明(關窗的顯示在清單上方;保留視窗的顯示在窗裡)。 */
  message: string | null;
  showContacts: boolean;
  /** 重新讀清單。 */
  reload: boolean;
  /** 登入狀態不能用了 ⇒ 回 C4-B02。 */
  relogin: boolean;
}

/** c4-contract 第 0 節:會員中心函式回 unavailable ⇒ 這一句。 */
export const MEMBER_CENTER_CLOSED_MESSAGE = "這間店目前沒有開放會員中心，請直接聯絡店家。";
export const CANCEL_DEADLINE_PASSED_MESSAGE = "已經超過可以線上取消的時間，請直接聯絡店家。";
export const CANCEL_STATE_CHANGED_MESSAGE = "這筆預約的狀態已經變更，請重新整理後再看看。";
export const CANCEL_RATE_LIMITED_MESSAGE = "操作太頻繁，請稍後再試";
export const CANCEL_FAILED_MESSAGE = "取消時發生問題，請稍後再試。";

export function cancelResultView(code: CancelFailureCode): CancelResultView {
  const base: CancelResultView = {
    closeDialog: true,
    toast: null,
    message: null,
    showContacts: false,
    reload: true,
    relogin: false,
  };
  switch (code) {
    case "cancelled":
    case "already_cancelled":
      return { ...base, toast: "已取消預約" };
    case "deadline_passed":
      return { ...base, message: CANCEL_DEADLINE_PASSED_MESSAGE, showContacts: true };
    case "not_cancellable":
    case "not_found":
      return { ...base, message: CANCEL_STATE_CHANGED_MESSAGE };
    case "not_linked":
      return { ...base, reload: false, relogin: true };
    case "unavailable":
      return {
        ...base,
        message: MEMBER_CENTER_CLOSED_MESSAGE,
        showContacts: true,
      };
    case "rate_limited":
      return { ...base, closeDialog: false, reload: false, message: CANCEL_RATE_LIMITED_MESSAGE };
    default:
      return { ...base, closeDialog: false, reload: false, message: CANCEL_FAILED_MESSAGE };
  }
}

export function parseCancelResponse(raw: unknown): CancelResultState | null {
  if (!isRecord(raw)) return null;
  const state = raw["state"];
  if (state === "channel_mismatch") return "not_linked";
  return typeof state === "string" && (CANCEL_RESULT_STATES as readonly string[]).includes(state)
    ? (state as CancelResultState)
    : null;
}

// =========================================================================
// 首頁(C4-C01 / C4-C02)
// =========================================================================

export type MissingProfileField = "birthday" | "email" | "address";

export interface MemberWalletSummary {
  pointsEnabled: boolean;
  pointsBalance: number | null;
  /** 儲值金 #1038 還沒做:一律 null(C4-W01)。 */
  storedValueEnabled: boolean;
}

export interface MemberHome {
  memberName: string;
  isPrimary: boolean;
  missing: MissingProfileField[];
  nextBooking: MemberBooking | null;
  upcomingCount: number;
  wallet: MemberWalletSummary;
  /** C4-C01:待處理的加入聯絡人申請(只有主要聯絡人有值,第二聯絡人一律 0)。 */
  pendingContactRequests: number;
  /** C5-M03:這位聯絡人的 LINE 通知狀態(沒回 ⇒ available = false,首頁不顯示加好友卡)。 */
  lineNotify: MemberLineNotify;
}

/** 會員中心函式「不是 ok」的結果:登入失效 / 店家停用。 */
export type MemberGate = { state: "not_linked" } | { state: "unavailable" };

export function parseMemberGate(raw: unknown): MemberGate | null {
  if (!isRecord(raw)) return null;
  const state = raw["state"];
  if (typeof state === "string" && MEMBER_SESSION_LOST_STATES.has(state)) {
    return { state: "not_linked" };
  }
  if (state === "unavailable") return { state: "unavailable" };
  return null;
}

const MISSING_ORDER: MissingProfileField[] = ["birthday", "address", "email"];

function parseWalletSummary(raw: unknown): MemberWalletSummary {
  const w = isRecord(raw) ? raw : {};
  const pointsEnabled = w["points_enabled"] === true;
  return {
    pointsEnabled,
    pointsBalance: pointsEnabled ? num(w["points_balance"]) : null,
    storedValueEnabled: w["stored_value"] !== null && w["stored_value"] !== undefined,
  };
}

export function parseMemberHome(raw: unknown): MemberHome | MemberGate | null {
  const gate = parseMemberGate(raw);
  if (gate) return gate;
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  const member = isRecord(raw["member"]) ? raw["member"] : {};
  const missingRaw = Array.isArray(member["missing"]) ? member["missing"] : [];
  const isPrimary = member["is_primary"] !== false;
  return {
    memberName: text(member["name"]) ?? "",
    isPrimary,
    missing: MISSING_ORDER.filter((f) => missingRaw.includes(f)),
    nextBooking: parseMemberBooking(raw["next_booking"]),
    upcomingCount: num(raw["upcoming_count"]),
    wallet: parseWalletSummary(raw["wallet"]),
    pendingContactRequests: isPrimary ? Math.max(0, num(raw["pending_contact_requests"])) : 0,
    lineNotify: parseMemberLineNotify(raw["line_notify"]),
  };
}

export function isMemberGate(value: unknown): value is MemberGate {
  return isRecord(value) && (value["state"] === "not_linked" || value["state"] === "unavailable");
}

const MISSING_LABELS: Record<MissingProfileField, string> = {
  birthday: "生日",
  address: "地址",
  email: "Email",
};

/** 「補上生日、地址和 Email」(依缺的欄位組);沒有缺 ⇒ null(不顯示提示卡)。 */
export function missingProfileTitle(missing: MissingProfileField[]): string | null {
  const labels = MISSING_ORDER.filter((f) => missing.includes(f)).map((f) => MISSING_LABELS[f]);
  if (labels.length === 0) return null;
  // 中文接英文(Email)中間留一個半形空白,同規格「補上生日、地址和 Email」。
  const joinWord = (before: string, word: string) =>
    /^[A-Za-z]/.test(word) ? `${before} ${word}` : `${before}${word}`;
  if (labels.length === 1) return joinWord("補上", labels[0] ?? "");
  return joinWord(`補上${labels.slice(0, -1).join("、")}和`, labels[labels.length - 1] ?? "");
}

/** 提示卡「略過」記在瀏覽器(C4-C02 ⚠️:讀不到就再顯示一次,可接受)。 */
export function missingProfileDismissKey(slug: string): string {
  return `miaoyue-member-missing-dismissed-${slug}`;
}

export function readMissingProfileDismissed(slug: string): boolean {
  try {
    return window.localStorage.getItem(missingProfileDismissKey(slug)) === "1";
  } catch {
    return false;
  }
}

export function writeMissingProfileDismissed(slug: string): void {
  try {
    window.localStorage.setItem(missingProfileDismissKey(slug), "1");
  } catch {
    // 瀏覽器不讓存:下次打開再顯示一次(規格接受)。
  }
}

// =========================================================================
// 我的預約(C4-C03 / C4-C04)
// =========================================================================

export type MemberBookingScope = "upcoming" | "history";

export function parseBookingScope(value: string | null): MemberBookingScope {
  return value === "history" ? "history" : "upcoming";
}

export interface MemberBookingPage {
  items: MemberBooking[];
  nextCursor: string | null;
  counts: { upcoming: number; history: number } | null;
}

export function parseMemberBookingPage(raw: unknown): MemberBookingPage | MemberGate | null {
  const gate = parseMemberGate(raw);
  if (gate) return gate;
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  const items = (Array.isArray(raw["items"]) ? raw["items"] : [])
    .map(parseMemberBooking)
    .filter((b): b is MemberBooking => b !== null);
  const counts = isRecord(raw["counts"])
    ? { upcoming: num(raw["counts"]["upcoming"]), history: num(raw["counts"]["history"]) }
    : null;
  return { items, nextCursor: text(raw["next_cursor"]), counts };
}

// =========================================================================
// 我的錢包(C4-W01~W03)
// =========================================================================

/** C4-W01:紅利開著或儲值金有開 ⇒ 底部選單有「錢包」。兩個都沒有 ⇒ 不出現。 */
export function walletVisible(wallet: MemberWalletSummary | null | undefined): boolean {
  return Boolean(wallet && (wallet.pointsEnabled || wallet.storedValueEnabled));
}

export interface MemberNavItem {
  tab: MemberCenterTab;
  label: string;
}

/** 底部選單:首頁、我的預約、錢包(依 C4-W01)、我的資料。 */
export function memberNavItems(showWallet: boolean): MemberNavItem[] {
  const items: MemberNavItem[] = [
    { tab: "home", label: "首頁" },
    { tab: "bookings", label: "我的預約" },
  ];
  if (showWallet) items.push({ tab: "wallet", label: "錢包" });
  items.push({ tab: "profile", label: "我的資料" });
  return items;
}

export interface PointHistoryEntry {
  type: string;
  delta: number;
  createdAt: string;
  bookingSummary: string | null;
}

export interface MemberWalletPage {
  points: {
    enabled: boolean;
    balance: number;
    history: PointHistoryEntry[];
    nextCursor: string | null;
  } | null;
  storedValueEnabled: boolean;
}

export function parseMemberWalletPage(raw: unknown): MemberWalletPage | MemberGate | null {
  const gate = parseMemberGate(raw);
  if (gate) return gate;
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  const p = raw["points"];
  let points: MemberWalletPage["points"] = null;
  if (isRecord(p) && p["enabled"] !== false) {
    const history: PointHistoryEntry[] = [];
    for (const h of Array.isArray(p["history"]) ? p["history"] : []) {
      if (!isRecord(h)) continue;
      const createdAt = validIso(h["created_at"]);
      const type = text(h["type"]);
      if (!createdAt || !type) continue;
      history.push({
        type,
        delta: num(h["delta"]),
        createdAt,
        bookingSummary: text(h["booking_summary"]),
      });
    }
    points = {
      enabled: true,
      balance: num(p["balance"]),
      history,
      nextCursor: text(p["next_cursor"]),
    };
  }
  return {
    points,
    storedValueEnabled: raw["stored_value"] !== null && raw["stored_value"] !== undefined,
  };
}

/**
 * C4-W03 客人看到的點數類型名稱(跟後台不同,後台 MEMBER_POINT_TRANSACTION_TYPE_LABELS 不變)。
 * 推薦類吃同一個 REFERRAL_UI_HIDDEN 開關(#1037,不另開開關)。
 * 不認得的代碼一律「點數異動」(不顯示原始代碼給客人)。
 */
export function customerPointTypeLabel(
  type: string,
  referralHidden: boolean = REFERRAL_UI_HIDDEN,
): string {
  switch (type) {
    case "earn_booking":
      return "消費累積";
    case "birthday_bonus":
      return "生日禮";
    case "manual_adjustment":
      return "店家調整";
    case "redeem":
    case "redeem_booking":
      return "折抵消費";
    case "redeem_booking_refund":
      return "折抵退回";
    case "earn_booking_reversal":
      return "消費點數收回";
    case "referral_bonus":
    case "referral_repeat_bonus":
      return referralHidden ? "活動贈點" : "推薦獎勵";
    case "referral_bonus_reversal":
      return referralHidden ? "活動點數收回" : "推薦獎勵收回";
    default:
      return "點數異動";
  }
}

/** 「+50」/「−100」(負號用全形減號 U+2212,同預覽圖)。 */
export function formatPointDelta(delta: number): string {
  const abs = Math.abs(delta).toLocaleString("en-US");
  return delta < 0 ? `\u2212${abs}` : `+${abs}`;
}

/** 「2026年10月2日」(點數明細的日期,台北時區)。 */
export function formatPointDate(iso: string): string {
  const p = taipeiParts(iso);
  return `${p.year}年${p.month}月${p.day}日`;
}

/** 明細第二行:日期 + 全形空白 + 訂單摘要(有的話),例「2026年10月2日(全形空白)室內機清洗 ×2」。 */
export function pointEntrySubtitle(entry: PointHistoryEntry): string {
  const date = formatPointDate(entry.createdAt);
  if (!entry.bookingSummary) return date;
  // c4-contract 第 5 節:booking_summary =「M月D日(全形空白)項目 ×數量」(訂單的日期)。
  // 訂單日期跟這筆點數的日期同一天 ⇒ 只留年份完整的那個日期,不重複寫兩次(同預覽圖 ⑩-3)。
  const p = taipeiParts(entry.createdAt);
  const sameDayPrefix = `${p.month}月${p.day}日\u3000`;
  const summary = entry.bookingSummary.startsWith(sameDayPrefix)
    ? entry.bookingSummary.slice(sameDayPrefix.length)
    : entry.bookingSummary;
  return `${date}\u3000${summary}`;
}

// =========================================================================
// 我的資料(C4-E01~E03,Q3=A 生日鎖定)
// =========================================================================

export interface MemberProfile {
  member: {
    name: string;
    phone: string | null;
    birthday: string | null;
    address: string | null;
    email: string | null;
  };
  me: { lineDisplayName: string | null; linePictureUrl: string | null; isPrimary: boolean };
  canEdit: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseMemberProfile(raw: unknown): MemberProfile | MemberGate | null {
  const gate = parseMemberGate(raw);
  if (gate) return gate;
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  const m = isRecord(raw["member"]) ? raw["member"] : {};
  const me = isRecord(raw["me"]) ? raw["me"] : {};
  const birthday = text(m["birthday"]);
  const isPrimary = me["is_primary"] !== false;
  return {
    member: {
      name: text(m["name"]) ?? "",
      phone: text(m["phone"]),
      birthday: birthday && DATE_RE.test(birthday.slice(0, 10)) ? birthday.slice(0, 10) : null,
      address: text(m["address"]),
      email: text(m["email"]),
    },
    me: {
      lineDisplayName: text(me["line_display_name"]),
      linePictureUrl: text(me["line_picture_url"]),
      isPrimary,
    },
    canEdit: typeof raw["can_edit"] === "boolean" ? raw["can_edit"] : isPrimary,
  };
}

/** Q3 = A:生日第一次可以自己填,填了之後只能請店家在後台改。 */
export function isBirthdayLocked(profile: Pick<MemberProfile, "member">): boolean {
  return profile.member.birthday !== null;
}

export const BIRTHDAY_LOCKED_NOTE = "生日填寫後不能自行修改，要更改請聯絡店家。";
export const PHONE_READONLY_NOTE = "手機號碼不能自行修改，要更換請聯絡店家。";
export const NOT_PRIMARY_NOTE = "只有主要聯絡人可以修改會員資料。";
export const PROFILE_UNCHANGED_NOTE = "還沒有修改任何資料";

export const PROFILE_NAME_MAX = 50;
export const PROFILE_ADDRESS_MAX = 200;
export const PROFILE_EMAIL_MAX = 254;
export const PROFILE_BIRTHDAY_MIN = "1900-01-01";

export interface ProfileFormValues {
  name: string;
  birthday: string;
  address: string;
  email: string;
}

export function profileFormFrom(profile: MemberProfile): ProfileFormValues {
  return {
    name: profile.member.name,
    birthday: profile.member.birthday ?? "",
    address: profile.member.address ?? "",
    email: profile.member.email ?? "",
  };
}

function chars(value: string): number {
  return [...value].length;
}

/** 有沒有改任何東西(去頭尾空白後比較;沒改 ⇒「儲存」停用 + 常駐黃色 !)。 */
export function isProfileDirty(values: ProfileFormValues, original: ProfileFormValues): boolean {
  return (
    values.name.trim() !== original.name.trim() ||
    values.birthday !== original.birthday ||
    values.address.trim() !== original.address.trim() ||
    values.email.trim() !== original.email.trim()
  );
}

export type ProfileFormErrors = Partial<Record<keyof ProfileFormValues, string>>;

/**
 * 前端第一道檢查(伺服器 C4-E03 會再檢查一次):
 *   姓名去頭尾空白 1~50 字(必填);Email 可空,格式同後台會員 Email(lib/validation EMAIL_REGEX)、≤ 254;
 *   地址可空、≤ 200;生日可空、不能是未來、不能早於 1900-01-01;已有生日 ⇒ 不能改。
 * @param today 台北的今天 YYYY-MM-DD
 */
export function validateProfileForm(
  values: ProfileFormValues,
  ctx: { originalBirthday: string | null; today: string },
): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  const name = values.name.trim();
  if (name === "") errors.name = "請填寫姓名。";
  else if (chars(name) > PROFILE_NAME_MAX) errors.name = `姓名最多 ${PROFILE_NAME_MAX} 個字。`;
  const email = values.email.trim();
  if (email !== "" && (!EMAIL_REGEX.test(email) || chars(email) > PROFILE_EMAIL_MAX)) {
    errors.email = "請輸入正確的 Email 格式，例如 name@example.com";
  }
  if (chars(values.address.trim()) > PROFILE_ADDRESS_MAX) {
    errors.address = `地址最多 ${PROFILE_ADDRESS_MAX} 個字。`;
  }
  const birthday = values.birthday;
  if (ctx.originalBirthday !== null) {
    if (birthday !== ctx.originalBirthday) errors.birthday = BIRTHDAY_LOCKED_NOTE;
  } else if (birthday !== "") {
    if (!DATE_RE.test(birthday)) errors.birthday = "請選擇正確的日期。";
    else if (birthday > ctx.today) errors.birthday = "生日不能是未來的日期。";
    else if (birthday < PROFILE_BIRTHDAY_MIN) errors.birthday = "請選擇正確的生日。";
  }
  return errors;
}

/** 送給 customer_update_profile 的參數(空字串存 null;已鎖定的生日照原值送,C4-E03)。 */
export function toProfileUpdateArgs(values: ProfileFormValues): {
  name: string;
  birthday: string | null;
  address: string | null;
  email: string | null;
} {
  const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    name: values.name.trim(),
    birthday: values.birthday === "" ? null : values.birthday,
    address: orNull(values.address),
    email: orNull(values.email),
  };
}

/** customer_update_profile 被擋時(依 hint)顯示的句子;不顯示資料庫原文。 */
export function profileSaveErrorMessage(hint: string | null): string {
  switch (hint) {
    // c4-contract 6-2 建議句子
    case "invalid_name":
      return `請填寫姓名（最多 ${PROFILE_NAME_MAX} 字）。`;
    case "invalid_email":
      return "請輸入正確的 Email 格式，例如 name@example.com";
    case "invalid_address":
      return `地址最多 ${PROFILE_ADDRESS_MAX} 字。`;
    case "invalid_birthday":
      return "生日日期不正確。";
    case "birthday_locked":
      return BIRTHDAY_LOCKED_NOTE;
    case "not_primary":
      return NOT_PRIMARY_NOTE;
    default:
      return "儲存失敗，請稍後再試。你填的資料沒有遺失。";
  }
}

// =========================================================================
// 完成頁 ⑦ 文案(C4-B04)
// =========================================================================

/** ⑦-1 / ⑦-2(會員):取消說明(依店家設定的 N 小時)。 */
export function memberCompletionCancelText(deadlineHours: number): string {
  if (deadlineHours === 0) {
    return "服務開始前都可以到會員中心取消；要改時間請取消後重新預約，或聯絡店家。";
  }
  return `要取消可以在服務前 ${deadlineHours} 小時以前到會員中心操作；要改時間請取消後重新預約，或聯絡店家。`;
}

/** ⑦-3(訪客):取消說明維持請客人直接聯絡店家。 */
export const GUEST_CANCEL_OR_RESCHEDULE_TEXT = "要取消或改時間請直接聯絡店家";

/** ⑦-3「加入會員」區塊的說明(原本「這筆預約之後會出現在會員中心（即將推出）」)。 */
export const GUEST_JOIN_MEMBER_TEXT = "用 LINE 登入加入會員後，可以在會員中心查看和取消這筆預約。";
