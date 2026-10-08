// 客戶端第 5 批 5-A(C5-M01 / M02 / M03 / M04):會員中心「LINE 通知」的純邏輯。
// 規格:.project/specs/客戶端第5批-LINE通知與綁定.md(「零之零」優先);預覽圖 ⑧、⑪-1。
//
// ・伺服器回的 line_notify / 通知偏好一律在這裡白名單 parse;看不懂的欄位當「不能用」處理
//   (寧可不顯示,也不要在畫面承諾做不到的事,鐵律「不承諾做不到的功能」)。
// ・🔴 不承諾 5-B 才有的功能:服務前提醒、服務完成、聯絡人申請通知、優惠通知照開關發送,這批都還沒有
//   ⇒ 說明文字不提「服務前提醒」「聯絡人申請」;「優惠通知」開關先不顯示(PROMO_SWITCH_VISIBLE)。
// ・「稍後再說」記在瀏覽器 7 天(C5-M01 ⚠️);讀不到就再顯示一次(可接受)。

export type LineFriendStatus = "friend" | "not_friend" | "unknown";

/** customer_get_member_home 多回的 line_notify(C5-M03)。 */
export interface MemberLineNotify {
  /** 這間店能用 LINE 通知客人(已接上官方帳號 + 至少一種預約通知開著)。 */
  available: boolean;
  /** 這位聯絡人自己的「預約通知」開關。 */
  notifyBooking: boolean;
  friendStatus: LineFriendStatus;
  /** 加好友網址(只收 https://);沒有 = null(不顯示加好友卡)。 */
  addFriendUrl: string | null;
}

/** customer_get_notify_prefs / customer_set_notify_prefs 的回傳(C5-M03)。 */
export interface MemberNotifyPrefs extends MemberLineNotify {
  notifyPromo: boolean;
}

/** 「優惠通知」開關要不要顯示(5-A = false;值放在 src/lib/customerLinePromo.ts,後台聯絡人卡共用)。 */
export { PROMO_SWITCH_VISIBLE } from "@/lib/customerLinePromo";

export const LINE_NOTIFY_SECTION_TITLE = "LINE 通知";
export const BOOKING_SWITCH_TITLE = "預約通知";
/** 5-A 版說明(拿掉 5-B 才有的「服務前提醒」「聯絡人申請」)。 */
export const BOOKING_SWITCH_DESCRIPTION = "預約成立、店家確認、改時間、取消時，用 LINE 通知你。";
export const PROMO_SWITCH_TITLE = "優惠通知";
export const PROMO_SWITCH_DESCRIPTION = "店家的優惠活動與生日禮通知。";
export const NOT_FRIEND_NOTE = "你還沒有加入店家的 LINE 好友，開著也收不到通知。";
export const PREFS_SAVE_FAILED_MESSAGE = "儲存失敗，請稍後再試";
export const ADD_FRIEND_AFTER_NOTE = "加好友後回到這裡重新整理就好。";

/** ⑧ 提示卡標題。 */
export function addFriendCardTitle(merchantName: string): string {
  return `加入「${merchantName}」LINE 好友`;
}
/** ⑧ 提示卡說明(5-A 版,不提「服務前提醒」)。 */
export const ADD_FRIEND_CARD_BODY = "預約確認、改時間、取消都會用 LINE 通知你。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只收 https:// 的網址(加好友連結會直接開新分頁)。 */
export function safeAddFriendUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s.length > 500) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

export function parseFriendStatus(value: unknown): LineFriendStatus {
  return value === "friend" || value === "not_friend" ? value : "unknown";
}

/** 首頁 line_notify(沒回 / 看不懂 ⇒ 當成不能用)。 */
export function parseMemberLineNotify(raw: unknown): MemberLineNotify {
  const r = isRecord(raw) ? raw : {};
  return {
    available: r["available"] === true,
    // 預設開(C5-A01);只有明確 false 才當成關。
    notifyBooking: r["notify_booking"] !== false,
    friendStatus: parseFriendStatus(r["friend_status"]),
    addFriendUrl: safeAddFriendUrl(r["add_friend_url"]),
  };
}

/** 通知偏好(state 不是 ok ⇒ null,呼叫端交給 gate 判斷)。 */
export function parseMemberNotifyPrefs(raw: unknown): MemberNotifyPrefs | null {
  if (!isRecord(raw) || raw["state"] !== "ok") return null;
  return {
    ...parseMemberLineNotify(raw),
    notifyPromo: raw["notify_promo"] !== false,
  };
}

/**
 * C5-M01 ⑧「加入 LINE 好友」提示卡顯示條件(全部成立才顯示):
 *   店家能用 LINE 通知客人、這位聯絡人預約通知開著、好友狀態不是「已加入」、有加好友網址、沒按過「稍後再說」。
 */
export function shouldShowAddFriendCard(
  lineNotify: MemberLineNotify | null | undefined,
  dismissed: boolean,
): boolean {
  if (!lineNotify || dismissed) return false;
  return (
    lineNotify.available &&
    lineNotify.notifyBooking &&
    lineNotify.friendStatus !== "friend" &&
    lineNotify.addFriendUrl !== null
  );
}

/** C5-M02:⑪-1「LINE 通知」區塊要不要顯示(店家沒接上官方帳號 ⇒ 整塊不顯示)。 */
export function shouldShowLineNotifySection(prefs: MemberNotifyPrefs | null | undefined): boolean {
  return prefs?.available === true;
}

/** C5-M02:黃色 !「還沒加好友」只在「確定沒加」時顯示(不確定不顯示)。 */
export function shouldShowNotFriendNote(prefs: MemberNotifyPrefs | null | undefined): boolean {
  return prefs?.available === true && prefs.friendStatus === "not_friend";
}

// -------------------------------------------------------------------------
// 「稍後再說」7 天(C5-M01 ⚠️)
// -------------------------------------------------------------------------

export const ADD_FRIEND_DISMISS_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function addFriendDismissKey(slug: string): string {
  return `miaoyue-member-add-friend-dismissed-${slug}`;
}

/** 讀「稍後再說」:7 天內按過 ⇒ true。讀不到 / 格式不對 / 過期 ⇒ false(再顯示一次)。 */
export function readAddFriendDismissed(slug: string, now: number = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(addFriendDismissKey(slug));
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return false;
    // 時間在未來(改過系統時間)也當成沒按過,避免卡片永遠消失。
    if (at > now) return false;
    return now - at < ADD_FRIEND_DISMISS_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

export function writeAddFriendDismissed(slug: string, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(addFriendDismissKey(slug), String(now));
  } catch {
    // 瀏覽器不讓存:下次打開再顯示一次(規格接受)。
  }
}
