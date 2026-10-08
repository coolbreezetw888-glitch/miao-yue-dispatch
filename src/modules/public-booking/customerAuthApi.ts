// 客戶端第 2 批(C2):LINE 登入與客人身分相關的呼叫。
//
//   ・Edge Function `customer-line-login`(C2-B01 start / C2-B03 complete):還沒登入,所以用 fetch 直接打,
//     只帶公開金鑰(verify_jwt = false)。
//   ・要帶客人身分的資料庫函式(C2-C03 customer_complete_profile、C2-C05 get_customer_session_state):
//     一律用「客戶專用 client」(customerClient.ts),**不用**後台的 client。
//
// 🔴 錯誤一律只留「代碼」給畫面挑中文句子,不把伺服器原文顯示出來,也不印到 console。

import { getCustomerClient, readSupabaseEnv } from "./customerClient";
import {
  parseBookingDraft,
  parseCompleteProfileResult,
  parseCustomerSessionState,
  toServerDraft,
  type BookingDraft,
  type CompleteProfileResult,
  type CustomerSessionState,
} from "./customerLoginLogic";

export const CUSTOMER_LINE_LOGIN_FUNCTION = "customer-line-login";

export class CustomerAuthError extends Error {
  /** 伺服器回的錯誤代碼(例:login_expired、line_login_unavailable);斷線 = "network"。 */
  readonly code: string;
  /** 有些錯誤會帶回預約頁代碼(伺服器查的,不是前端傳的)。 */
  readonly slug: string | null;
  /** line_error 時伺服器會把草稿還回來(客人回到 ⑤ 不用重填)。 */
  readonly draft: BookingDraft | null;
  constructor(code: string, slug: string | null = null, draft: BookingDraft | null = null) {
    super(`customer-auth:${code}`);
    this.name = "CustomerAuthError";
    this.code = code;
    this.slug = slug;
    this.draft = draft;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionUrl(): string {
  const { url } = readSupabaseEnv();
  return `${url.replace(/\/+$/, "")}/functions/v1/${CUSTOMER_LINE_LOGIN_FUNCTION}`;
}

async function callLineLoginFunction(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { key } = readSupabaseEnv();
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: key };
  // 舊版金鑰(JWT 形式)才放 Authorization;新版 sb_publishable_ 不能當 Bearer(見 customerClient.ts)。
  if (!key.startsWith("sb_")) headers["Authorization"] = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(functionUrl(), { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new CustomerAuthError("network");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!isRecord(data)) throw new CustomerAuthError(res.ok ? "invalid_response" : "network");
  const slug = typeof data["slug"] === "string" ? data["slug"] : null;
  // Edge Function 一律用 status 回結果:ok / cancelled 是正常結果,其他(login_expired、line_error、
  // line_login_unavailable、rate_limited、invalid_draft、server_error⋯)都是錯誤代碼。
  const status = typeof data["status"] === "string" ? data["status"] : null;
  if (!res.ok || (status !== "ok" && status !== "cancelled")) {
    throw new CustomerAuthError(
      status ?? "network",
      slug,
      "draft" in data ? parseBookingDraft(data["draft"]) : null,
    );
  }
  return data;
}

/** C2-B01:取得 LINE 授權網址。 */
export async function startLineLogin(slug: string, draft: BookingDraft): Promise<string> {
  const data = await callLineLoginFunction({ action: "start", slug, draft: toServerDraft(draft) });
  const url = data["authorize_url"];
  if (typeof url !== "string" || url === "") throw new CustomerAuthError("invalid_response");
  return url;
}

/**
 * C3-B04:訪客完成頁 ⑦-3「用 LINE 登入加入會員」—— 沒有預約草稿時啟動 LINE 登入(`purpose: 'join'`、
 * `draft: null`)。登入回來時伺服器也會回 `draft: null`,預約頁據此走「加入會員」流程(C3-D07)。
 */
export async function startLineJoin(slug: string): Promise<string> {
  const data = await callLineLoginFunction({ action: "start", slug, purpose: "join", draft: null });
  const url = data["authorize_url"];
  if (typeof url !== "string" || url === "") throw new CustomerAuthError("invalid_response");
  return url;
}

export type LineCompleteResult =
  | {
      status: "ok";
      slug: string;
      draft: BookingDraft | null;
      tokenHash: string;
      verifyType: "email" | "magiclink";
    }
  | { status: "cancelled"; slug: string; draft: BookingDraft | null };

/** C2-B03:用 LINE 帶回來的 code / state 換登入用的 token_hash。 */
export async function completeLineLogin(params: {
  state: string;
  code: string | null;
  error: string | null;
}): Promise<LineCompleteResult> {
  const body: Record<string, unknown> = { action: "complete", state: params.state };
  if (params.code) body["code"] = params.code;
  if (params.error) body["error"] = params.error;
  const data = await callLineLoginFunction(body);
  const slug = typeof data["slug"] === "string" ? data["slug"] : null;
  if (!slug) throw new CustomerAuthError("invalid_response");
  const draft = parseBookingDraft(data["draft"]);
  if (data["status"] === "cancelled") return { status: "cancelled", slug, draft };
  const tokenHash = data["token_hash"];
  if (typeof tokenHash !== "string" || tokenHash === "") {
    throw new CustomerAuthError("invalid_response", slug);
  }
  // verifyOtp 的 type 由伺服器告訴我們(目前 "email";舊稱 "magiclink"),只接受這兩種。
  const verifyType = data["verify_type"] === "magiclink" ? "magiclink" : "email";
  return { status: "ok", slug, draft, tokenHash, verifyType };
}

/** 用 token_hash 在「這間店的客戶 client」建立登入狀態。 */
export async function establishCustomerSession(
  slug: string,
  tokenHash: string,
  verifyType: "email" | "magiclink" = "email",
): Promise<void> {
  const client = getCustomerClient(slug);
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: verifyType });
  if (error) throw new CustomerAuthError("session_failed", slug);
}

/** 這間店的客戶 client 目前有沒有登入狀態(只看瀏覽器裡有沒有,不打網路)。 */
export async function hasCustomerSession(slug: string): Promise<boolean> {
  try {
    const { data } = await getCustomerClient(slug).auth.getSession();
    return data.session !== null;
  } catch {
    return false;
  }
}

/** C2-C05。沒有登入狀態時不打網路,直接回 anonymous。 */
export async function fetchCustomerSessionState(slug: string): Promise<CustomerSessionState> {
  if (!(await hasCustomerSession(slug))) return { state: "anonymous" };
  const client = getCustomerClient(slug);
  const { data, error } = await client.rpc("get_customer_session_state", { p_slug: slug });
  if (error) {
    // 登入狀態過期 / 被撤銷 ⇒ 當作沒登入(畫面會回到 ⑥-1),其他錯誤丟出去讓畫面顯示重試。
    if (error.code === "PGRST301" || error.code === "42501" || error.code === "28000") {
      return { state: "anonymous" };
    }
    throw new CustomerAuthError("network", slug);
  }
  // 商家中途換了 LINE 登入設定 ⇒ 這個登入狀態在這間店已經不能用,順手登出(c2-contract 3-1)。
  if (isRecord(data) && data["state"] === "channel_mismatch") await signOutCustomer(slug);
  return parseCustomerSessionState(data);
}

export class CompleteProfileError extends Error {
  readonly hint: string | null;
  constructor(hint: string | null) {
    super(`complete-profile:${hint ?? "unknown"}`);
    this.name = "CompleteProfileError";
    this.hint = hint;
  }
}

/** C2-C03(依零之二:結果只有 linked / phone_taken)。 */
export async function completeCustomerProfile(params: {
  slug: string;
  phone: string;
  name: string;
  agreePolicy: boolean;
}): Promise<Exclude<CompleteProfileResult, { kind: "rejected" }>> {
  const client = getCustomerClient(params.slug);
  const { data, error } = await client.rpc("customer_complete_profile", {
    p_slug: params.slug,
    p_phone: params.phone,
    p_name: params.name,
    p_agree_policy: params.agreePolicy,
  });
  if (error) {
    const hint = typeof error.hint === "string" && error.hint !== "" ? error.hint : null;
    throw new CompleteProfileError(hint ?? (error.code === "42501" ? "not_customer" : null));
  }
  const result = parseCompleteProfileResult(data);
  if (!result) throw new CompleteProfileError(null);
  if (result.kind === "rejected") throw new CompleteProfileError(result.hint);
  return result;
}

/** C2-E07:只登出這間店的客戶 client(後台 client 不受影響)。 */
export async function signOutCustomer(slug: string): Promise<void> {
  try {
    await getCustomerClient(slug).auth.signOut({ scope: "local" });
  } catch {
    // 登出失敗也不擋畫面:本機的登入狀態 signOut 一定會清掉。
  }
}

/** 跳到 LINE 授權頁(獨立成一支,元件測試才換得掉;呼叫前一定先過 isAllowedAuthorizeUrl)。 */
export function redirectToAuthorizeUrl(url: string): void {
  window.location.assign(url);
}
