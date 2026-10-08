// 客戶端第 4 批 4-B(#1041 多位聯絡人,C4-H03~H10):會員中心「聯絡人」相關的純函式(vitest 逐條驗)。
// 規格:.project/specs/客戶端第4批-會員中心與自己取消.md H 區;介面以 .project/notes/c4-contract.md「4-B」章節為準。
//
// 🔴 伺服器回的 LINE 顯示名、電話一律當純文字交給 React 文字節點,不解析 HTML(C4-F05)。
// 🔴 回傳一律逐欄挑白名單:伺服器多給的欄位畫面也拿不到。
// 🔴 不在畫面承諾第 5 批才有的 LINE 通知(J04)。

import { safeImageUrl } from "./customerLoginLogic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function validIso(value: unknown): string | null {
  const s = text(value);
  return s && !Number.isNaN(new Date(s).getTime()) ? s : null;
}

// =========================================================================
// 邀請碼(C4-F04:網址進來後立刻從網址列拿掉,只留在這個分頁的記憶體)
// =========================================================================

/** 邀請碼格式:32 碼以上的網址安全字元(伺服器產生;格式不對就當沒有,不送給伺服器)。 */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function isValidInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_RE.test(value);
}

/** 邀請落地頁的網址(拿掉邀請碼之後的樣子)。 */
export function invitePath(slug: string): string {
  return `/booking/${slug}/invite`;
}

// 只放記憶體(同一個分頁、SPA 內換頁才拿得到):重新整理就沒了 ⇒ 請客人重新打開邀請連結。
// 不放 sessionStorage / localStorage(C4-H06:邀請碼不存瀏覽器)。
//   token    網址上帶進來的邀請碼(還沒登入 / 已經登入直接按「加入」時用)
//   claimed  從 LINE 登入回來:伺服器已經把邀請保留給這個 LINE 帳號 30 分鐘(c4-contract B4-4),
//            按「加入」時 p_token 傳 null;valid = false ⇒ 邀請已失效
export type PendingInvite = { kind: "token"; token: string } | { kind: "claimed"; valid: boolean };

const pendingInvites = new Map<string, PendingInvite>();

export function putPendingInvite(slug: string, token: string): void {
  if (isValidInviteToken(token)) pendingInvites.set(slug, { kind: "token", token });
}

export function putClaimedInvite(slug: string, valid: boolean): void {
  pendingInvites.set(slug, { kind: "claimed", valid });
}

export function peekPendingInvite(slug: string): PendingInvite | null {
  return pendingInvites.get(slug) ?? null;
}

export function clearPendingInvite(slug: string): void {
  pendingInvites.delete(slug);
}

/**
 * 從目前網址抓出邀請碼並立刻換成沒有邀請碼的網址(history.replaceState,C4-F04)。
 * 回傳抓到的邀請碼(格式不對 ⇒ null,但網址一樣換掉)。
 */
export function captureInviteTokenFromLocation(slug: string): string | null {
  const prefix = `${invitePath(slug)}/`;
  const path = window.location.pathname;
  if (!path.startsWith(prefix)) return null;
  const raw = decodeURIComponent(path.slice(prefix.length).split("/")[0] ?? "");
  window.history.replaceState(window.history.state, "", invitePath(slug));
  if (!isValidInviteToken(raw)) return null;
  putPendingInvite(slug, raw);
  return raw;
}

/** complete 回來的邀請結果(c4-contract B4-4):purpose = invite 時才有。 */
export function parseCompleteInvite(raw: unknown): { valid: boolean } | null {
  if (!isRecord(raw) || raw["purpose"] !== "invite") return null;
  const invite = raw["invite"];
  return { valid: isRecord(invite) && invite["state"] === "valid" };
}

// =========================================================================
// 邀請落地頁(C4-H06)/ 接受邀請(C4-H07)
// =========================================================================

export type InvitePeekResult =
  { state: "valid"; merchantName: string | null } | { state: "invalid" };

export function parseInvitePeek(raw: unknown): InvitePeekResult | null {
  if (!isRecord(raw)) return null;
  if (raw["state"] === "valid") return { state: "valid", merchantName: text(raw["merchant_name"]) };
  if (raw["state"] === "invalid" || raw["state"] === "unavailable") return { state: "invalid" };
  return null;
}

export const INVITE_TITLE = (merchantName: string) => `你被邀請成為「${merchantName}」會員的聯絡人`;
export const INVITE_BODY = "加入後可以一起查看預約、取消預約、查看紅利點數。";
/** c4-contract B4-4 逐字。 */
export const INVITE_INVALID_MESSAGE = "這個邀請連結已經失效，請向主要聯絡人索取新的連結。";
/** 重新整理後記憶體裡的邀請碼沒了 / LINE 登入取消或失敗(邀請碼已經不在伺服器,c4-contract B4-4)。 */
export const INVITE_MISSING_MESSAGE = "請重新打開邀請連結再試一次。";
export const INVITE_CONTACT_LIMIT_MESSAGE = "這位會員的聯絡人已經額滿，請聯絡店家。";
export const INVITE_PHONE_HELP = "店家可以用這支電話找到你們的會員資料。";
export const ALREADY_MEMBER_ELSEWHERE_MESSAGE =
  "你的 LINE 已經是這間店另一位會員的聯絡人，要先退出才能加入。";

export type AcceptPhoneResult = "none" | "saved" | "same_as_member" | "in_use";

export type AcceptInviteResult =
  | { state: "linked"; phoneResult: AcceptPhoneResult }
  | { state: "already_member_elsewhere" }
  | { state: "contact_limit" }
  | { state: "invalid" }
  | { state: "not_linked" }
  | { state: "unavailable" };

export function parseAcceptInviteResult(raw: unknown): AcceptInviteResult | null {
  if (!isRecord(raw)) return null;
  const s = raw["state"];
  if (s === "linked") {
    const pr = raw["phone_result"];
    return {
      state: "linked",
      phoneResult: pr === "saved" || pr === "same_as_member" || pr === "in_use" ? pr : "none",
    };
  }
  if (
    s === "already_member_elsewhere" ||
    s === "contact_limit" ||
    s === "invalid" ||
    s === "unavailable"
  ) {
    return { state: s };
  }
  if (s === "not_linked" || s === "channel_mismatch" || s === "not_customer") {
    return { state: "not_linked" };
  }
  return null;
}

/** customer_accept_contact_invite 被擋(22023 hint)時的句子。 */
export function acceptInviteErrorMessage(hint: string | null): string {
  switch (hint) {
    case "policy_not_agreed":
      return "請先勾選同意，才能加入。";
    case "invalid_phone":
      return "電話格式不對：手機 10 碼，市話請連同區碼（不收分機）。";
    case "too_many_attempts":
      return "嘗試次數太多，請明天再試或直接聯絡店家。";
    default:
      return "加入時發生問題，請稍後再試。";
  }
}

// =========================================================================
// 申請加入(C4-H04 join_pending / C4-H05 被拒絕)
// =========================================================================

/** C4-H04(主腦 10/9 裁決:不暗示即時通知;LINE 通知是第 5 批)。 */
export const JOIN_PENDING_MESSAGE =
  "這支電話已經是會員。主要聯絡人打開會員中心時會看到你的申請，同意後你就能使用會員中心。";
export const JOIN_REJECTED_MESSAGE = "主要聯絡人沒有同意你的申請，請改用其他電話，或聯絡店家。";
export const JOIN_EXPIRED_MESSAGE = "你的申請已經過期，請重新填寫電話，或聯絡店家。";

// =========================================================================
// 聯絡人清單(C4-H09)
// =========================================================================

export interface MemberContact {
  id: string;
  lineDisplayName: string;
  linePictureUrl: string | null;
  isPrimary: boolean;
  /** 只有主要聯絡人和本人看得到(伺服器決定,第二聯絡人看別人時一律 null)。 */
  contactPhone: string | null;
  joinedAt: string | null;
  isMe: boolean;
}

export interface ContactRequest {
  id: string;
  lineDisplayName: string;
  linePictureUrl: string | null;
  phone: string | null;
  createdAt: string | null;
}

export interface ContactInvite {
  id: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface MemberContactsView {
  /** 我是不是主要聯絡人。 */
  isPrimary: boolean;
  contacts: MemberContact[];
  /** 待處理申請(只有主要聯絡人有)。 */
  requests: ContactRequest[];
  /** 有效邀請(只有主要聯絡人有)。 */
  invites: ContactInvite[];
}

function displayName(value: unknown): string {
  return text(value) ?? "LINE 使用者";
}

export function parseMemberContacts(raw: unknown): MemberContactsView | null {
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  const contacts: MemberContact[] = [];
  for (const c of Array.isArray(raw["contacts"]) ? raw["contacts"] : []) {
    if (!isRecord(c)) continue;
    const id = text(c["id"]);
    if (!id) continue;
    contacts.push({
      id,
      lineDisplayName: displayName(c["line_display_name"]),
      linePictureUrl: safeImageUrl(c["line_picture_url"]),
      isPrimary: c["is_primary"] === true,
      contactPhone: text(c["contact_phone"]),
      joinedAt: validIso(c["joined_at"]),
      isMe: c["is_me"] === true,
    });
  }
  // 主要聯絡人排第一,其他照伺服器給的順序(依加入時間)。
  contacts.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  // c4-contract B5-1:`me: { contact_id, is_primary }`;沒有就看清單裡自己那列。
  const meRaw = isRecord(raw["me"]) ? raw["me"] : {};
  const me = contacts.find((c) => c.isMe);
  const isPrimary =
    typeof meRaw["is_primary"] === "boolean" ? meRaw["is_primary"] : (me?.isPrimary ?? false);
  const requests: ContactRequest[] = [];
  const invites: ContactInvite[] = [];
  if (isPrimary) {
    for (const r of Array.isArray(raw["requests"]) ? raw["requests"] : []) {
      if (!isRecord(r)) continue;
      const id = text(r["id"]);
      if (!id) continue;
      requests.push({
        id,
        lineDisplayName: displayName(r["line_display_name"]),
        linePictureUrl: safeImageUrl(r["line_picture_url"]),
        phone: text(r["phone"]),
        createdAt: validIso(r["created_at"]),
      });
    }
    for (const i of Array.isArray(raw["invites"]) ? raw["invites"] : []) {
      if (!isRecord(i)) continue;
      const id = text(i["id"]);
      if (!id) continue;
      invites.push({
        id,
        createdAt: validIso(i["created_at"]),
        expiresAt: validIso(i["expires_at"]),
      });
    }
  }
  return { isPrimary, contacts, requests, invites };
}

/**
 * 聯絡人區塊要顯示什麼(C4-H09):
 *   solo      只有自己一位 ⇒「目前只有你一位聯絡人」+(主要)「邀請聯絡人」
 *   primary   主要聯絡人:清單(含電話)+ 每位第二聯絡人「設為主要聯絡人」「移除」+ 申請 + 邀請
 *   secondary 第二聯絡人:清單(沒有別人的電話)+ 自己那列「退出」
 */
export type ContactsSectionMode = "solo" | "primary" | "secondary";

export function contactsSectionMode(view: MemberContactsView): ContactsSectionMode {
  if (!view.isPrimary) return "secondary";
  const others = view.contacts.filter((c) => !c.isMe);
  if (others.length === 0 && view.requests.length === 0 && view.invites.length === 0) return "solo";
  return "primary";
}

/** 每位會員最多 10 位聯絡人(C4-H01 ⚠️);同時有效的邀請最多 5 個(C4-H03)。 */
export const MAX_CONTACTS = 10;
export const MAX_ACTIVE_INVITES = 5;

/**
 * 「邀請聯絡人」能不能按;不能按 ⇒ 回原因(按鈕上方常駐黃色 !,ui-overlay-patterns 二之三)。
 * 伺服器一樣會擋(contact_limit / invite_limit),這裡只是先講清楚。
 */
export function inviteBlockedReason(view: MemberContactsView): string | null {
  if (view.contacts.length >= MAX_CONTACTS) {
    return `每位會員最多 ${MAX_CONTACTS} 位聯絡人，要先移除一位才能再邀請。`;
  }
  if (view.invites.length >= MAX_ACTIVE_INVITES) {
    return `同時最多 ${MAX_ACTIVE_INVITES} 個有效邀請，請先撤銷不用的邀請。`;
  }
  return null;
}

/** C4-H09 逐字:轉移主要的確認文字。 */
export function transferPrimaryConfirmText(name: string): string {
  return `把主要聯絡人轉給 ${name} 嗎？轉移後只有 ${name} 可以修改會員資料、管理聯絡人。`;
}

export function removeContactConfirmText(name: string): string {
  return `要把 ${name} 從聯絡人移除嗎？移除後 ${name} 不能再查看這位會員的預約；要再加入需要請店家允許。`;
}

export const LEAVE_CONFIRM_TEXT =
  "退出後你的 LINE 不能再查看這位會員的預約，會回到會員中心登入頁。之後要再加入，請主要聯絡人重新邀請。";
export const LEAVE_SOLO_CONFIRM_TEXT =
  "你是這位會員唯一的聯絡人。退出後這位會員就沒有任何 LINE 帳號可以登入會員中心，之後可以用同一支電話重新加入。";
export const LEAVE_PRIMARY_BLOCKED = "請先把主要聯絡人轉給別人，才能退出。";
export const SOLO_CONTACT_TEXT = "目前只有你一位聯絡人";

/** 「10月8日」(台北時區;聯絡人加入時間、申請時間)。 */
export function formatContactDate(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const get = (t: string) => String(Number(parts.find((p) => p.type === t)?.value ?? ""));
  return `${get("month")}月${get("day")}日`;
}

/** 「10月11日 14:00」(邀請有效期限,台北時區)。 */
export function formatInviteExpiry(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${Number(get("month"))}月${Number(get("day"))}日 ${get("hour")}:${get("minute")}`;
}

// =========================================================================
// 建立邀請(C4-H03)
// =========================================================================

export type CreateInviteResult =
  | { state: "ok"; url: string; expiresAt: string | null }
  | { state: "invite_limit" }
  | { state: "contact_limit" };

/**
 * 伺服器回的邀請網址只接受「本站 + /booking/<代碼>/invite/<邀請碼>」(相對路徑也收,補上本站網址)。
 * 其他網址一律當看不懂(不讓客人把奇怪的網址傳給朋友)。
 */
export function normalizeInviteUrl(
  value: unknown,
  slug: string,
  siteOrigin: string,
): string | null {
  const s = text(value);
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s, siteOrigin);
  } catch {
    return null;
  }
  const prefix = `/booking/${slug}/invite/`;
  if (!url.pathname.startsWith(prefix)) return null;
  if (!isValidInviteToken(url.pathname.slice(prefix.length))) return null;
  // 正式站伺服器用 PUBLIC_SITE_URL 組網址;本機 / 預覽網址不同源時一律換成目前這個站,客人才點得開。
  return `${siteOrigin}${url.pathname}`;
}

export function parseCreateInviteResult(
  raw: unknown,
  slug: string,
  siteOrigin: string,
): CreateInviteResult | null {
  if (!isRecord(raw)) return null;
  if (raw["state"] === "invite_limit") return { state: "invite_limit" };
  if (raw["state"] === "contact_limit") return { state: "contact_limit" };
  if (raw["state"] !== "ok") return null;
  // c4-contract B4-1:伺服器回 path,網址由前端組(window.location.origin + path)。
  const url = normalizeInviteUrl(raw["path"] ?? raw["url"], slug, siteOrigin);
  const invite = isRecord(raw["invite"]) ? raw["invite"] : {};
  if (!url) return null;
  return { state: "ok", url, expiresAt: validIso(invite["expires_at"] ?? raw["expires_at"]) };
}

/** C4-H03 逐字:「邀請你成為『店名』會員『王小明』的聯絡人：<網址>(72 小時內有效)」。 */
export function inviteShareText(merchantName: string, memberName: string, url: string): string {
  return `邀請你成為「${merchantName}」會員「${memberName}」的聯絡人：${url}（72 小時內有效）`;
}

/** LINE 官方「分享文字」網址(developers.line.biz → Using LINE URL scheme:text 要 UTF-8 百分比編碼)。 */
export function lineShareUrl(message: string): string {
  return `https://line.me/R/share?text=${encodeURIComponent(message)}`;
}

// =========================================================================
// 各種動作的結果 → 畫面上的話(不顯示伺服器原文)
// =========================================================================

/** 處理申請(C4-H05;c4-contract B5-2:成功回 approved / rejected)。 */
export function resolveRequestMessage(state: string, approve: boolean): string | null {
  switch (state) {
    case "ok":
    case "approved":
    case "rejected":
      return null;
    case "already_member_elsewhere":
      return "這位申請人已經是這間店另一位會員的聯絡人，不能加入。";
    case "contact_limit":
      return `每位會員最多 ${MAX_CONTACTS} 位聯絡人，要先移除一位才能${approve ? "同意" : "處理"}。`;
    default:
      return "這筆申請已經處理過或已經失效，請重新整理。";
  }
}

/** 一般聯絡人動作(移除 / 轉移 / 撤銷邀請)。 */
export function contactActionMessage(state: string): string | null {
  switch (state) {
    case "ok":
      return null;
    case "primary_has_others":
      return LEAVE_PRIMARY_BLOCKED;
    case "invite_limit":
      return `同時最多 ${MAX_ACTIVE_INVITES} 個有效邀請，請先撤銷不用的邀請。`;
    case "contact_limit":
      return `每位會員最多 ${MAX_CONTACTS} 位聯絡人，要先移除一位才能再邀請。`;
    default:
      return "這位聯絡人的狀態已經變更，請重新整理後再看看。";
  }
}

/** 22023 hint → 句子(聯絡人相關)。 */
export function contactErrorMessage(hint: string | null): string {
  switch (hint) {
    case "not_primary":
      return "只有主要聯絡人可以管理聯絡人。";
    case "invalid_phone":
      return "電話格式不對：手機 10 碼，市話請連同區碼（不收分機）。";
    case "primary_uses_member_phone":
      return "主要聯絡人用的是會員電話，要更換請聯絡店家。";
    default:
      return "操作沒有成功，請稍後再試。";
  }
}

// =========================================================================
// 第二聯絡人自己的電話(C4-H08)
// =========================================================================

export const MY_PHONE_HELP = "店家可以用這支電話找到你們的會員資料。留空表示不留自己的電話。";
export const MY_PHONE_IN_USE_MESSAGE = "這支電話已經是其他會員的電話，沒有加上。";
export const MY_PHONE_SAME_AS_MEMBER_NOTE = "跟會員電話相同，不用另外加上。";

export type SetMyPhoneResult =
  { state: "ok"; contactPhone: string | null } | { state: "phone_in_use" };

export function parseSetMyPhoneResult(raw: unknown): SetMyPhoneResult | null {
  if (!isRecord(raw)) return null;
  if (raw["state"] === "phone_in_use") return { state: "phone_in_use" };
  if (raw["state"] === "ok") return { state: "ok", contactPhone: text(raw["contact_phone"]) };
  return null;
}

/** 首頁黃色提示卡(C4-C02):「有 1 位想加入成為聯絡人」。 */
export function pendingRequestsTitle(count: number): string {
  return `有 ${count} 位想加入成為聯絡人`;
}
