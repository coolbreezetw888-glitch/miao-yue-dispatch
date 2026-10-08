// 客戶端第 4 批 4-A:會員中心的資料存取(C4-C01、C03、W02、E01、E03 資料庫函式 + C4-D03 Edge Function)。
//
//   ・資料庫函式一律用「這間店的客戶 client」(customerClient.ts)呼叫,**不用**後台 client,
//     也**不傳**任何 member_id / user_id(伺服器用 auth.uid() + 預約頁代碼自己找會員,C4-A02)。
//   ・取消預約走 Edge Function `customer-booking-cancel`(C4-D03),帶客人 access token。
//
// 🔴 錯誤一律只留「代碼」給畫面挑中文句子,不把伺服器原文、token 印到 console(C4-F05)。
// 🔴 回傳一律經過 memberCenterLogic 的 parse(白名單逐欄),看不懂 ⇒ invalid_response。

import { getCustomerClient, readSupabaseEnv } from "./customerClient";
import { hasCustomerSession } from "./customerAuthApi";
import {
  parseCancelResponse,
  parseMemberBookingPage,
  parseMemberHome,
  parseMemberProfile,
  parseMemberWalletPage,
  toProfileUpdateArgs,
  type CancelFailureCode,
  type MemberBookingPage,
  type MemberBookingScope,
  type MemberGate,
  type MemberHome,
  type MemberProfile,
  type MemberWalletPage,
  type ProfileFormValues,
} from "./memberCenterLogic";

export const CUSTOMER_BOOKING_CANCEL_FUNCTION = "customer-booking-cancel";

/** react-query 的 key(登出 / 登入失效時整批清掉)。 */
export const memberCenterQueryKey = (slug: string) => ["member-center", slug] as const;

export class MemberCenterError extends Error {
  /** network / invalid_response / 資料庫的 hint(例:birthday_locked)。 */
  readonly code: string;
  constructor(code: string) {
    super(`member-center:${code}`);
    this.name = "MemberCenterError";
    this.code = code;
  }
}

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: { code?: string | null; hint?: string | null } | null;
}>;

const NOT_LINKED: MemberGate = { state: "not_linked" };

/** 登入狀態過期 / 被撤銷 / 不是客人帳號的錯誤代碼(同 customerAuthApi.fetchCustomerSessionState)。 */
function isAuthErrorCode(code: string | null | undefined): boolean {
  return code === "PGRST301" || code === "42501" || code === "28000";
}

async function callMemberRpc(
  slug: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!(await hasCustomerSession(slug))) return NOT_LINKED;
  const client = getCustomerClient(slug);
  const rpc = client.rpc.bind(client) as unknown as UntypedRpc;
  let result: Awaited<ReturnType<UntypedRpc>>;
  try {
    result = await rpc(fn, args);
  } catch {
    throw new MemberCenterError("network");
  }
  if (result.error) {
    const hint = typeof result.error.hint === "string" ? result.error.hint : null;
    if (isAuthErrorCode(result.error.code) || hint === "not_customer") return NOT_LINKED;
    throw new MemberCenterError(hint ?? "network");
  }
  return result.data;
}

function ensure<T>(value: T | null): T {
  if (value === null) throw new MemberCenterError("invalid_response");
  return value;
}

/** C4-C01 首頁。 */
export async function fetchMemberHome(slug: string): Promise<MemberHome | MemberGate> {
  return ensure(
    parseMemberHome(await callMemberRpc(slug, "customer_get_member_home", { p_slug: slug })),
  );
}

/** C4-C03 我的預約(游標分頁)。 */
export async function fetchMyBookings(
  slug: string,
  scope: MemberBookingScope,
  cursor: string | null,
): Promise<MemberBookingPage | MemberGate> {
  return ensure(
    parseMemberBookingPage(
      await callMemberRpc(slug, "customer_list_my_bookings", {
        p_slug: slug,
        p_scope: scope,
        p_cursor: cursor,
        p_limit: 20,
      }),
    ),
  );
}

/** C4-W02 我的錢包(點數明細游標分頁)。 */
export async function fetchMyWallet(
  slug: string,
  cursor: string | null,
): Promise<MemberWalletPage | MemberGate> {
  return ensure(
    parseMemberWalletPage(
      await callMemberRpc(slug, "customer_get_wallet", {
        p_slug: slug,
        p_cursor: cursor,
        p_limit: 30,
      }),
    ),
  );
}

/** C4-E01 我的資料。 */
export async function fetchMyProfile(slug: string): Promise<MemberProfile | MemberGate> {
  return ensure(
    parseMemberProfile(await callMemberRpc(slug, "customer_get_profile", { p_slug: slug })),
  );
}

/**
 * C4-E03 改資料(只有主要聯絡人)。成功回 ok;登入失效回 not_linked;被擋 ⇒ 丟 MemberCenterError(hint)。
 */
export async function updateMyProfile(
  slug: string,
  values: ProfileFormValues,
): Promise<"ok" | "not_linked" | "unavailable"> {
  const args = toProfileUpdateArgs(values);
  const data = await callMemberRpc(slug, "customer_update_profile", {
    p_slug: slug,
    p_name: args.name,
    p_birthday: args.birthday,
    p_address: args.address,
    p_email: args.email,
  });
  const gate =
    typeof data === "object" && data !== null && "state" in data
      ? (data as { state: unknown }).state
      : null;
  if (gate === "not_linked" || gate === "channel_mismatch" || gate === "not_customer") {
    return "not_linked";
  }
  if (gate === "unavailable") return "unavailable";
  return "ok";
}

/** 這間店客戶 client 的 access token(沒有登入狀態 = null)。 */
async function customerAccessToken(slug: string): Promise<string | null> {
  try {
    const { data } = await getCustomerClient(slug).auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * C4-D03 取消預約。業務結果 HTTP 200 + `{state}`;429 = rate_limited;400 / 403 / 500 / 看不懂 ⇒ server_error;
 * 斷線 ⇒ network(畫面保留確認窗,可以再按一次;伺服器本身冪等)。
 */
export async function cancelMyBooking(slug: string, bookingId: string): Promise<CancelFailureCode> {
  const token = await customerAccessToken(slug);
  if (!token) return "not_linked";
  const { url, key } = readSupabaseEnv();
  let res: Response;
  try {
    res = await fetch(
      `${url.replace(/\/+$/, "")}/functions/v1/${CUSTOMER_BOOKING_CANCEL_FUNCTION}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ slug, booking_id: bookingId }),
      },
    );
  } catch {
    return "network";
  }
  if (res.status === 429) return "rate_limited";
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) return "server_error";
  return parseCancelResponse(data) ?? "server_error";
}
