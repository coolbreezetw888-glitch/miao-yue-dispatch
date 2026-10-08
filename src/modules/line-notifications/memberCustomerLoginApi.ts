// 客戶端第 2 批(C2-H03):會員詳細頁「客戶端登入」那一行的資料(get_member_customer_login_status)。

import { supabase } from "@/integrations/supabase/client";

export const memberCustomerLoginQueryKey = (memberId: string) =>
  ["line-notifications-module", "member-customer-login", memberId] as const;

export interface MemberCustomerLoginStatus {
  linked: boolean;
  lastLoginAt: string | null;
  /** 店家解除過 LINE 綁定,被解除的客戶帳號目前不能自動接回(c2-contract 4-5)。 */
  relinkBlocked: boolean;
}

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export function parseMemberCustomerLoginStatus(raw: unknown): MemberCustomerLoginStatus {
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const last = r["last_login_at"];
  return {
    linked: r["linked"] === true,
    lastLoginAt: typeof last === "string" && last !== "" ? last : null,
    relinkBlocked: r["relink_blocked"] === true,
  };
}

export async function fetchMemberCustomerLoginStatus(
  memberId: string,
): Promise<MemberCustomerLoginStatus> {
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  const { data, error } = await rpc("get_member_customer_login_status", { p_member_id: memberId });
  if (error) throw error;
  return parseMemberCustomerLoginStatus(data);
}

/** c2-contract 4-5b:允許之前被解除的客戶帳號重新用這支電話接上(權限 = 會員管理)。 */
export async function allowMemberCustomerRelink(memberId: string): Promise<void> {
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  const { error } = await rpc("allow_member_customer_relink", { p_member_id: memberId });
  if (error) throw error;
}

/** 會員管理權限:管理員一律有;客服要有「會員管理」(跟 RequireMembersAccess 同一套判斷)。 */
export function canManageMembers(
  role: string | null | undefined,
  agentMembers: boolean | null | undefined,
): boolean {
  return role === "admin" || (role === "agent" && agentMembers === true);
}

/** 「10月8日」(台北時區)。 */
export function formatLastLoginDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}
