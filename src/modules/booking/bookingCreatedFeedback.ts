// SPECS-INDEX #915 / #916(2026-10-01 第二波):建單表單「送出」這一段跟會員有關的兩個純函式。
// 規格書:.project/specs/建單自動建立會員與會員兩層狀態.md §12.1、§12.3
// 抽出來的理由:規格書 §12.6 要求 vitest 測到「新增模式 memberId 一律 null」與「提示框兩種會員行
// 文案」;這兩件事寫在 CalendarPage 的 handleSubmit 裡面測不到。⇒ 測試在 bookingCreatedFeedback.test.ts。

import { normalizeCustomerPhone } from "@/modules/members/memberPhoneMatch";

import { formatAmount } from "./orderAmount";
import type { Booking } from "./types";

/** 編輯模式「補掛會員」(§12.7 第 2 點):客服在面板上點選的那位會員,連同他的電話一起記下。 */
export interface PendingAttachMember {
  id: string;
  name: string;
  phone: string | null;
  /** §12.8 第 1 點:補掛黑名單客戶時,面板要繼續常駐黑名單提醒。 */
  isBlacklisted: boolean;
  blacklistReason: string | null;
}

/**
 * §12.1 + §12.7:送出時要帶給後端的 member_id。
 *
 * 🔴 新增模式一律 null —— 「這筆訂單要掛在哪位會員底下」只由送出那一刻的電話決定,
 *    由後端 create_booking 自己用完全相等比對(#912)。create_booking 對 p_member_id 是完全尊重、
 *    不比對電話的 ⇒ 前端如果帶了「點過的那位」,客服先點王小明、再把電話改成李小華的號碼,
 *    訂單就會掛在王小明底下,紅利發錯人而且系統不警告。
 *
 * 編輯模式(update_booking 不依電話比對,對 member_id 是無條件覆寫):
 *   ① 已連結會員 → 原 id(跟改版前 `member?.id ?? null` 相同,不讓 update_booking 清掉既有連結);
 *   ② 未連結、沒點選 → null(電話打完整也**不會**自動補掛,補掛一定要客服明確點選);
 *   ③ 未連結、點選了某位會員,而且他的電話(正規化後)等於表單電話欄目前的值 → 該會員 id;
 *   ④ 未連結、點選後電話又被改掉 → null(不可以把 A 的會員掛到電話是 B 的訂單上)。
 *   ④ 在畫面上也會即時反映(改電話當下 CalendarPage 就把補掛狀態清掉),這裡是送出前最後一道防線。
 */
export function resolveSubmitMemberId(input: {
  isEdit: boolean;
  linkedMember: { id: string } | null;
  pendingAttachMember: PendingAttachMember | null;
  customerPhone: string;
}): string | null {
  if (!input.isEdit) return null;
  if (input.linkedMember) return input.linkedMember.id;
  if (
    input.pendingAttachMember &&
    isSamePhone(input.pendingAttachMember.phone, input.customerPhone)
  ) {
    return input.pendingAttachMember.id;
  }
  return null;
}

/** 兩支電話正規化後相等(規則同後端 private.normalize_phone);任一邊正規化後是空的一律不相等。 */
export function isSamePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCustomerPhone(a);
  return na !== null && na === normalizeCustomerPhone(b);
}

/** #916 建單成功提示框的內容(標題 + 描述各行)。 */
export interface BookingCreatedToastContent {
  title: string;
  lines: string[];
}

/** 秒數(規格書 §12.3 / #916 定案 6 秒:這則有 2~3 行要讀,sonner 預設 4 秒是給單行用的)。 */
export const BOOKING_CREATED_TOAST_DURATION_MS = 6000;

/**
 * #916(本波版本:**沒有紅利那一行** —— #917 延到紅利改版那批,不留空殼、不寫「計算中」)。
 *
 * | 位置 | 文案 | 條件 |
 * | 標題 | 已送出訂單(待確認) | 一律 |
 * | 第 1 行 | 已自動建立會員:{姓名} | member_auto_created === true |
 * | 第 1 行 | 已連結既有會員:{姓名} | member_auto_created === false 且 member_id 有值 |
 * | 第 2 行 | 訂單金額 {formatAmount(金額)} | 一律 |
 *
 * {姓名} 用**會員的姓名**(create_booking 回傳列上的 member_name_snapshot,後端從 members 表讀出),
 * 不是這次表單填的姓名 —— #931 規則:會員姓名不會被建單覆蓋,兩者可能不同。
 * 不需要另開後端端點:create_booking 本來就回傳整列 bookings。
 * 萬一 member_id 有值但快照是空的(後端保證不會發生),寧可不顯示這一行,也不拿訂單姓名頂替。
 */
export function buildBookingCreatedToast(
  booking: Pick<
    Booking,
    "member_auto_created" | "member_id" | "member_name_snapshot" | "final_amount_snapshot"
  >,
): BookingCreatedToastContent {
  const lines: string[] = [];
  const memberName = booking.member_name_snapshot;
  if (booking.member_id && memberName) {
    lines.push(
      booking.member_auto_created === true
        ? `已自動建立會員:${memberName}`
        : `已連結既有會員:${memberName}`,
    );
  }
  lines.push(`訂單金額 ${formatAmount(Number(booking.final_amount_snapshot))}`);
  return { title: "已送出訂單(待確認)", lines };
}
