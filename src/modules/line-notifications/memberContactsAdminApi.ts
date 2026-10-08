// 客戶端第 4 批 4-B(#1041,C4-K04 / C4-H05 ⚠️範圍 第 4 點):會員詳細頁「聯絡人」卡的資料存取。
// 介面:.project/notes/c4-contract.md B6(權限 = 會員管理,沒權限 42501;回傳不含 LINE userId)。

import { supabase } from "@/integrations/supabase/client";

export const memberContactsAdminQueryKey = (memberId: string) =>
  ["line-notifications-module", "member-contacts", memberId] as const;

export type ContactJoinedVia = "first_login" | "invite" | "request" | "store" | "backfill";

export interface AdminMemberContact {
  id: string;
  lineDisplayName: string;
  linePictureUrl: string | null;
  isPrimary: boolean;
  contactPhone: string | null;
  joinedVia: ContactJoinedVia | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
}

export interface AdminContactRequest {
  id: string;
  lineDisplayName: string;
  phone: string | null;
  createdAt: string | null;
}

export interface AdminMemberContacts {
  contacts: AdminMemberContact[];
  requests: AdminContactRequest[];
  relinkBlocked: boolean;
}

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

function rpc(): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** https:// 才顯示頭像(同客戶端 safeImageUrl)。 */
function httpsUrl(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

const JOINED_VIA = new Set<ContactJoinedVia>([
  "first_login",
  "invite",
  "request",
  "store",
  "backfill",
]);

export function parseAdminMemberContacts(raw: unknown): AdminMemberContacts {
  const r = isRecord(raw) ? raw : {};
  const contacts: AdminMemberContact[] = [];
  for (const c of Array.isArray(r["contacts"]) ? r["contacts"] : []) {
    if (!isRecord(c)) continue;
    const id = str(c["id"]);
    if (!id) continue;
    const via = c["joined_via"];
    contacts.push({
      id,
      lineDisplayName: str(c["line_display_name"]) ?? "LINE 使用者",
      linePictureUrl: httpsUrl(c["line_picture_url"]),
      isPrimary: c["is_primary"] === true,
      contactPhone: str(c["contact_phone"]),
      joinedVia:
        typeof via === "string" && JOINED_VIA.has(via as ContactJoinedVia)
          ? (via as ContactJoinedVia)
          : null,
      joinedAt: str(c["joined_at"]),
      lastLoginAt: str(c["last_login_at"]),
    });
  }
  contacts.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const requests: AdminContactRequest[] = [];
  for (const q of Array.isArray(r["requests"]) ? r["requests"] : []) {
    if (!isRecord(q)) continue;
    const id = str(q["id"]);
    if (!id) continue;
    requests.push({
      id,
      lineDisplayName: str(q["line_display_name"]) ?? "LINE 使用者",
      phone: str(q["phone"]),
      createdAt: str(q["created_at"]),
    });
  }
  return { contacts, requests, relinkBlocked: r["relink_blocked"] === true };
}

/** c4-contract B6-1 加入方式中文。 */
export function joinedViaLabel(via: ContactJoinedVia | null): string {
  switch (via) {
    case "first_login":
      return "第一次登入";
    case "invite":
      return "邀請連結";
    case "request":
      return "申請加入";
    case "store":
      return "店家指定";
    case "backfill":
      return "既有綁定";
    default:
      return "加入";
  }
}

export async function fetchAdminMemberContacts(memberId: string): Promise<AdminMemberContacts> {
  const { data, error } = await rpc()("list_member_contacts", { p_member_id: memberId });
  if (error) throw error;
  return parseAdminMemberContacts(data);
}

function stateOf(data: unknown): string {
  return isRecord(data) && typeof data["state"] === "string" ? data["state"] : "unknown";
}

export async function merchantSetPrimaryContact(contactId: string): Promise<string> {
  const { data, error } = await rpc()("merchant_set_primary_contact", { p_contact_id: contactId });
  if (error) throw error;
  return stateOf(data);
}

/** 移除主要聯絡人且還有其他人時要帶新的主要聯絡人(否則回 need_new_primary)。 */
export async function merchantRemoveMemberContact(
  contactId: string,
  newPrimaryContactId: string | null,
): Promise<string> {
  const { data, error } = await rpc()("merchant_remove_member_contact", {
    p_contact_id: contactId,
    p_new_primary_contact_id: newPrimaryContactId,
  });
  if (error) throw error;
  return stateOf(data);
}

export async function merchantResolveContactRequest(
  requestId: string,
  approve: boolean,
): Promise<string> {
  const { data, error } = await rpc()("merchant_resolve_contact_request", {
    p_request_id: requestId,
    p_approve: approve,
  });
  if (error) throw error;
  return stateOf(data);
}

/** 動作回來的 state → 失敗時的句子(成功 ⇒ null)。 */
export function adminContactActionMessage(state: string): string | null {
  switch (state) {
    case "ok":
    case "approved":
    case "rejected":
      return null;
    case "need_new_primary":
      return "這位是主要聯絡人，請先選一位新的主要聯絡人。";
    case "already_member_elsewhere":
      return "申請人已經是這間店另一位會員的聯絡人，不能加入。";
    case "contact_limit":
      return "這位會員已經有 10 位聯絡人，要先移除一位才能同意。";
    default:
      return "資料已經變更，請重新整理後再試。";
  }
}
