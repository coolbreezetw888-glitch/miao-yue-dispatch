// 客戶端第 5 批 5-A(C5-M03):會員中心「LINE 通知」開關的資料存取。
// 介面:.project/notes/c5-contract.md(甲)。只傳預約頁代碼,不傳 member_id / contact_id(伺服器用 auth.uid() 自己找)。
// 🔴 錯誤只留代碼,不把伺服器原文印出來(同 memberCenterApi)。

import { callMemberRpc, MemberCenterError, memberCenterQueryKey } from "./memberCenterApi";
import { parseMemberGate, type MemberGate } from "./memberCenterLogic";
import { parseMemberNotifyPrefs, type MemberNotifyPrefs } from "./lineNotifyLogic";

export const notifyPrefsQueryKey = (slug: string) =>
  [...memberCenterQueryKey(slug), "notify-prefs"] as const;

function toPrefsOrGate(data: unknown): MemberNotifyPrefs | MemberGate {
  const gate = parseMemberGate(data);
  if (gate) return gate;
  const prefs = parseMemberNotifyPrefs(data);
  if (!prefs) throw new MemberCenterError("invalid_response");
  return prefs;
}

/** C5-M03 讀自己的通知偏好。 */
export async function fetchMyNotifyPrefs(slug: string): Promise<MemberNotifyPrefs | MemberGate> {
  return toPrefsOrGate(await callMemberRpc(slug, "customer_get_notify_prefs", { p_slug: slug }));
}

/** C5-M03 改自己的通知偏好(null = 不變)。回傳改完之後的狀態。 */
export async function setMyNotifyPrefs(
  slug: string,
  patch: { notifyBooking?: boolean | null; notifyPromo?: boolean | null },
): Promise<MemberNotifyPrefs | MemberGate> {
  return toPrefsOrGate(
    await callMemberRpc(slug, "customer_set_notify_prefs", {
      p_slug: slug,
      p_notify_booking: patch.notifyBooking ?? null,
      p_notify_promo: patch.notifyPromo ?? null,
    }),
  );
}
