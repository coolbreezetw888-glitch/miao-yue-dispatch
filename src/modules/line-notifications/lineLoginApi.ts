// 客戶端第 2 批(C2-A02~A04):商家「LINE 登入」設定的資料存取。
// 商家端 /app/line-settings 與超管商家詳細頁共用(LineLoginSettingsCard)。
//
// 🔴 C2-F01 Channel Secret「只進不出」:
//   ・secret 只在 setMerchantLineLoginConfig 送出一次;資料庫只回遮罩(••••末 4 碼)。
//   ・這裡不把 secret 放進 react-query 的快取 / mutation 變數,也不寫任何 console。
//   ・錯誤訊息只用資料庫的固定中文句子(資料庫保證不含 secret)。

import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export type LinkedOaStatus = "ok" | "not_linked" | "unknown";

export interface MerchantLineLoginStatus {
  configured: boolean;
  channelId: string | null;
  /** 例:「••••ab12」;沒設定 = null。永遠不會是 secret 原文。 */
  channelSecretMasked: string | null;
  enabled: boolean;
  lastLoginSucceededAt: string | null;
  linkedOaStatus: LinkedOaStatus | null;
  /** 要貼到 LINE Developers 的 Callback URL(目前網站網域 + 資料庫回的固定路徑)。 */
  callbackUrl: string | null;
}

// 型別檔(src/integrations/supabase/types.ts)由 engineer 甲維護;這裡回傳本來就要自己檢查,所以用不帶型別的呼叫。
type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase.rpc.bind(supabase) as unknown as UntypedRpc)(fn, args);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 資料庫回 callback_path(固定 /auth/line/callback);完整網址 = 目前網站網域 + 這個路徑
 * (跟 Edge Function 用 PUBLIC_SITE_URL 組的是同一個網域)。如果哪天改成直接回 callback_url,也收。
 */
function resolveCallbackUrl(r: Record<string, unknown>): string | null {
  const url = optStr(r["callback_url"]);
  if (url && /^https?:\/\//.test(url)) return url;
  const path = optStr(r["callback_path"]);
  if (path && path.startsWith("/") && typeof window !== "undefined") {
    return `${window.location.origin}${path}`;
  }
  return null;
}

export function parseMerchantLineLoginStatus(raw: unknown): MerchantLineLoginStatus {
  const r = isRecord(raw) ? raw : {};
  const oa = r["linked_oa_status"];
  const masked = r["channel_secret_masked"];
  return {
    configured: r["configured"] === true,
    channelId: optStr(r["channel_id"]),
    // C2-A01 ⚠️:可能只回 true(只顯示「已設定」)。
    channelSecretMasked:
      typeof masked === "string" && masked !== "" ? masked : masked === true ? "已設定" : null,
    enabled: r["enabled"] === true,
    lastLoginSucceededAt: optStr(r["last_login_succeeded_at"]),
    linkedOaStatus: oa === "ok" || oa === "not_linked" || oa === "unknown" ? oa : null,
    callbackUrl: resolveCallbackUrl(r),
  };
}

export const lineLoginStatusQueryKey = (merchantId: string) =>
  ["line-login-config", "status", merchantId] as const;

export async function fetchMerchantLineLoginStatus(
  merchantId: string,
): Promise<MerchantLineLoginStatus> {
  const { data, error } = await rpc("get_merchant_line_login_status", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return parseMerchantLineLoginStatus(data);
}

export function useMerchantLineLoginStatus(merchantId: string | null | undefined) {
  return useQuery({
    queryKey: lineLoginStatusQueryKey(merchantId ?? ""),
    queryFn: () => fetchMerchantLineLoginStatus(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** C2-A02。channelSecret 空字串 = 只改 Channel ID,沿用舊 secret。 */
export async function setMerchantLineLoginConfig(
  merchantId: string,
  channelId: string,
  channelSecret: string,
): Promise<void> {
  const { error } = await rpc("set_merchant_line_login_config", {
    p_merchant_id: merchantId,
    p_channel_id: channelId,
    p_channel_secret: channelSecret === "" ? null : channelSecret,
  });
  if (error) throw error;
}

/** C2-A04 */
export async function setMerchantLineLoginEnabled(
  merchantId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await rpc("set_merchant_line_login_enabled", {
    p_merchant_id: merchantId,
    p_enabled: enabled,
  });
  if (error) throw error;
}

/** C2-A04 */
export async function deleteMerchantLineLoginConfig(merchantId: string): Promise<void> {
  const { error } = await rpc("delete_merchant_line_login_config", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
}

// ─── 前端欄位檢查(資料庫一樣會檢查;這裡只是早點告訴使用者)───

/** LINE Channel ID:數字。 */
export function channelIdError(value: string): string | null {
  const v = value.trim();
  if (v === "") return "請填 Channel ID。";
  return /^\d{6,20}$/.test(v)
    ? null
    : "Channel ID 應該是一串數字，請到 LINE Developers 的 Basic settings 複製。";
}

/** LINE Channel Secret:32 碼英數。required = 第一次設定(還沒有 secret)。 */
export function channelSecretError(value: string, required: boolean): string | null {
  const v = value.trim();
  if (v === "") return required ? "請填 Channel Secret。" : null;
  return /^[A-Za-z0-9]{32}$/.test(v)
    ? null
    : "Channel Secret 應該是 32 碼英文與數字，請到 LINE Developers 的 Basic settings 複製。";
}
