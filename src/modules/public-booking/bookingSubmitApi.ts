// 客戶端第 3 批(C3-B01):送出預約 —— 呼叫 Edge Function `customer-booking-submit`。
//
//   ・會員:帶「這間店的客戶 client」的 access token(Authorization: Bearer),不帶 guest。
//   ・訪客:不帶 Authorization(舊版 JWT 形式的公開金鑰才放 anon key),一定帶 guest(電話、同意、Turnstile token)。
//   ・兩者都帶 ⇒ 伺服器回 400(規格 C3-B01),所以這裡兩種請求嚴格分開組。
//
// 🔴 錯誤只回「代碼」給畫面挑中文句子;不把伺服器原文、token、電話印到 console(C3-F06)。
// 🔴 金額、單價、狀態、member_id 一律不送(C3-F01):草稿只有項目 id + 數量、服務人員、日期時間、姓名、地址、備註。

import { getCustomerClient, readSupabaseEnv } from "./customerClient";
import { toServerDraft, type BookingDraft } from "./customerLoginLogic";
import {
  parseSubmitResponse,
  toSubmitInvalidHint,
  type SubmitFailureCode,
  type SubmitOutcome,
} from "./bookingSubmitLogic";

export const CUSTOMER_BOOKING_SUBMIT_FUNCTION = "customer-booking-submit";

export class BookingSubmitError extends Error {
  readonly code: SubmitFailureCode;
  constructor(code: SubmitFailureCode) {
    super(`booking-submit:${code}`);
    this.name = "BookingSubmitError";
    this.code = code;
  }
}

export interface GuestSubmitInput {
  phone: string;
  agreePolicy: boolean;
  turnstileToken: string;
}

function functionUrl(): string {
  const { url } = readSupabaseEnv();
  return `${url.replace(/\/+$/, "")}/functions/v1/${CUSTOMER_BOOKING_SUBMIT_FUNCTION}`;
}

/** 會員送出要帶的 access token(這間店的客戶 client;沒有登入狀態 = null)。 */
async function customerAccessToken(slug: string): Promise<string | null> {
  try {
    const { data } = await getCustomerClient(slug).auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * 送出預約。
 * @param guest 有值 = 訪客送出;null = 會員送出(用客戶 client 的登入狀態)。
 * @returns created / rejected(state);斷線、500、看不懂的回應 ⇒ 丟 BookingSubmitError(畫面保留,可用同一個
 *          submissionId 重按)。
 */
export async function submitCustomerBooking(params: {
  slug: string;
  submissionId: string;
  draft: BookingDraft;
  guest: GuestSubmitInput | null;
}): Promise<SubmitOutcome> {
  const { key } = readSupabaseEnv();
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: key };
  const body: Record<string, unknown> = {
    slug: params.slug,
    submission_id: params.submissionId,
    draft: toServerDraft(params.draft),
  };
  if (params.guest) {
    body["guest"] = {
      phone: params.guest.phone,
      agree_policy: params.guest.agreePolicy,
      turnstile_token: params.guest.turnstileToken,
    };
    // 舊版金鑰(JWT 形式)才放 Authorization;新版 sb_publishable_ 不能當 Bearer(同 customerAuthApi)。
    if (!key.startsWith("sb_")) headers["Authorization"] = `Bearer ${key}`;
  } else {
    const token = await customerAccessToken(params.slug);
    // 沒有登入狀態 ⇒ 不用問伺服器,直接當「沒接上會員」(畫面回 ⑥-1)。
    if (!token) return { kind: "rejected", state: "not_linked" };
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(functionUrl(), { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new BookingSubmitError("network");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 429) return { kind: "rejected", state: "rate_limited" };
  // c3-contract 1-4:400 依 hint 顯示對應句子(電話格式、沒勾同意、地址必填⋯);
  // 403(來源不允許)/ 500 ⇒「送出時發生問題」,畫面保留、可用同一個 submission_id 重按。
  if (res.status === 400) {
    const hint =
      typeof data === "object" && data !== null && "hint" in data
        ? (data as { hint: unknown }).hint
        : null;
    throw new BookingSubmitError(toSubmitInvalidHint(hint));
  }
  if (!res.ok) throw new BookingSubmitError("server_error");
  const outcome = parseSubmitResponse(data);
  if (!outcome) throw new BookingSubmitError("server_error");
  return outcome;
}
