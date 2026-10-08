// 客戶端第 4 批 4-B(#1041 多位聯絡人):會員中心聯絡人相關的資料存取。
// 介面以 .project/notes/c4-contract.md「4-B」章節為準。
//
//   ・全部用「這間店的客戶 client」呼叫,不傳 member_id / user_id(伺服器用 auth.uid() + 代碼自己找,C4-A02)。
//   ・邀請落地頁的「查邀請」(customer_peek_contact_invite)沒登入也能叫(anon,伺服器有 IP 上限)。
// 🔴 錯誤只留代碼給畫面挑句子;邀請碼、電話不印到 console(C4-F04 / F05)。

import { getCustomerClient } from "./customerClient";
import { callMemberRpc, MemberCenterError } from "./memberCenterApi";
import { isMemberGate, parseMemberGate, type MemberGate } from "./memberCenterLogic";
import {
  parseAcceptInviteResult,
  parseCreateInviteResult,
  parseInvitePeek,
  parseMemberContacts,
  parseSetMyPhoneResult,
  type AcceptInviteResult,
  type CreateInviteResult,
  type InvitePeekResult,
  type MemberContactsView,
  type SetMyPhoneResult,
} from "./memberContactsLogic";

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: { code?: string | null; hint?: string | null } | null;
}>;

function gateOr<T>(raw: unknown, parse: (raw: unknown) => T | null): T | MemberGate {
  const gate = parseMemberGate(raw);
  if (gate) return gate;
  const value = parse(raw);
  if (value === null) throw new MemberCenterError("invalid_response");
  return value;
}

/** 只回 `{state}` 的動作:ok / not_found / 其他業務代碼(畫面依代碼挑句子)。 */
export type ContactActionOutcome = { state: string } | MemberGate;

function parseActionState(raw: unknown): { state: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = (raw as Record<string, unknown>)["state"];
  return typeof s === "string" ? { state: s } : null;
}

async function action(
  slug: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<ContactActionOutcome> {
  return gateOr(await callMemberRpc(slug, fn, { p_slug: slug, ...args }), parseActionState);
}

/** C4-H09 聯絡人清單(+ 主要聯絡人才有的申請、有效邀請)。 */
export async function fetchMemberContacts(slug: string): Promise<MemberContactsView | MemberGate> {
  return gateOr(
    await callMemberRpc(slug, "customer_list_contacts", { p_slug: slug }),
    parseMemberContacts,
  );
}

/** C4-H03 建立邀請連結。 */
export async function createContactInvite(slug: string): Promise<CreateInviteResult | MemberGate> {
  const raw = await callMemberRpc(slug, "customer_create_contact_invite", { p_slug: slug });
  return gateOr(raw, (r) => parseCreateInviteResult(r, slug, window.location.origin));
}

/** C4-H03 撤銷有效邀請。 */
export function revokeContactInvite(slug: string, inviteId: string) {
  return action(slug, "customer_revoke_contact_invite", { p_invite_id: inviteId });
}

/** C4-H05 主要聯絡人同意 / 拒絕申請。 */
export function resolveContactRequest(slug: string, requestId: string, approve: boolean) {
  return action(slug, "customer_resolve_contact_request", {
    p_request_id: requestId,
    p_approve: approve,
  });
}

/** C4-H10 主要聯絡人移除第二聯絡人。 */
export function removeContact(slug: string, contactId: string) {
  return action(slug, "customer_remove_contact", { p_contact_id: contactId });
}

/** C4-H10 自己退出。 */
export function leaveMember(slug: string) {
  return action(slug, "customer_leave_member", {});
}

/** C4-H10 把主要聯絡人轉給別人。 */
export function transferPrimary(slug: string, contactId: string) {
  return action(slug, "customer_transfer_primary", { p_contact_id: contactId });
}

/** C4-H08 第二聯絡人改自己的電話(空字串 = 清掉)。 */
export async function setMyContactPhone(
  slug: string,
  phone: string,
): Promise<SetMyPhoneResult | MemberGate> {
  const raw = await callMemberRpc(slug, "customer_set_my_contact_phone", {
    p_slug: slug,
    p_phone: phone.trim() === "" ? null : phone.trim(),
  });
  return gateOr(raw, parseSetMyPhoneResult);
}

/** C4-H04「改用其他電話」:取消自己送出的加入申請(回 ⑥-2)。 */
export async function cancelMyJoinRequest(slug: string): Promise<void> {
  const raw = await callMemberRpc(slug, "customer_cancel_contact_request", { p_slug: slug });
  if (isMemberGate(raw)) return;
}

/** C4-H06 查邀請(沒登入也能叫;不回會員姓名)。 */
export async function peekContactInvite(slug: string, token: string): Promise<InvitePeekResult> {
  const client = getCustomerClient(slug);
  const rpc = client.rpc.bind(client) as unknown as UntypedRpc;
  let result: Awaited<ReturnType<UntypedRpc>>;
  try {
    result = await rpc("customer_peek_contact_invite", { p_slug: slug, p_token: token });
  } catch {
    throw new MemberCenterError("network");
  }
  if (result.error) {
    const hint = typeof result.error.hint === "string" ? result.error.hint : null;
    throw new MemberCenterError(hint ?? "network");
  }
  const parsed = parseInvitePeek(result.data);
  if (!parsed) throw new MemberCenterError("invalid_response");
  return parsed;
}

/** C4-H07 接受邀請(要先用 LINE 登入)。被擋(22023)⇒ 丟 MemberCenterError(hint)。 */
export async function acceptContactInvite(params: {
  slug: string;
  /** 網址帶進來的邀請碼;從 LINE 登入回來(伺服器已保留邀請)⇒ null(c4-contract B4-5)。 */
  token: string | null;
  phone: string;
  agreePolicy: boolean;
}): Promise<AcceptInviteResult> {
  const raw = await callMemberRpc(params.slug, "customer_accept_contact_invite", {
    p_slug: params.slug,
    p_token: params.token,
    p_phone: params.phone.trim() === "" ? null : params.phone.trim(),
    p_agree_policy: params.agreePolicy,
  });
  const parsed = parseAcceptInviteResult(raw);
  if (!parsed) throw new MemberCenterError("invalid_response");
  return parsed;
}
