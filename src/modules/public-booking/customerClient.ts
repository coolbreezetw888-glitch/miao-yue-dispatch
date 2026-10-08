// 客戶端第 2 批(C2-E01):客戶專用的 Supabase client。
//
// 🔴 為什麼不能用 src/integrations/supabase/client.ts 那一個(後台用的)client:
//   1. 同一個瀏覽器已經登入後台的人(商家自己測試預約頁時)用 LINE 登入,如果共用同一個 client,
//      後台的登入狀態會被客人的登入狀態蓋掉 ⇒ 商家被踢出後台。分開存之後兩邊互不干擾,
//      後台 client 也永遠拿不到客人的登入狀態(反過來也一樣)。
//   2. 登入狀態依「預約頁代碼」分開存(storageKey = miaoyue-customer-<代碼>):
//      同一支手機可以同時是兩間店的客人,各自登入、各自登出。
//
// 只在 /booking/* 與 /auth/line/callback 使用。第 1 批的公開函式(get_public_booking_page 等)
// 仍然用匿名呼叫(api.ts),只有「要帶客人身分」的函式(customer_complete_profile、
// get_customer_session_state)走這裡。
//
// 📌 跟後台 client 一樣要處理新版金鑰(sb_publishable_…)不能當 Bearer 的問題:client.ts 是自動產生的檔案、
//    沒有匯出那段 fetch 包裝,所以這裡照抄同一套規則(很短,而且這裡改不到那份檔案)。

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** 登入狀態存在瀏覽器時用的 key 前綴。後面接預約頁代碼。 */
export const CUSTOMER_STORAGE_KEY_PREFIX = "miaoyue-customer-";

/** 預約頁代碼的格式(同資料庫 merchants_booking_slug_format:小寫英數與 -)。 */
const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

export function isValidBookingSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function customerStorageKey(slug: string): string {
  return `${CUSTOMER_STORAGE_KEY_PREFIX}${slug}`;
}

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

export function readSupabaseEnv(): { url: string; key: string } {
  const url = import.meta.env["VITE_SUPABASE_URL"] as string | undefined;
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;
  if (!url || !key) throw new Error("Missing Supabase environment variables");
  return { url, key };
}

function createCustomerFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

const clients = new Map<string, SupabaseClient>();

/**
 * 取得某一間店的客戶 client(同一個代碼只建一次)。
 * 代碼格式不對直接丟錯 —— 不讓奇怪的字串變成瀏覽器儲存的 key。
 */
export function getCustomerClient(slug: string): SupabaseClient {
  const normalized = slug.trim().toLowerCase();
  if (!isValidBookingSlug(normalized)) throw new Error("invalid booking slug");
  const existing = clients.get(normalized);
  if (existing) return existing;
  const { url, key } = readSupabaseEnv();
  const client = createClient(url, key, {
    global: { fetch: createCustomerFetch(key) },
    auth: {
      storageKey: customerStorageKey(normalized),
      persistSession: true,
      autoRefreshToken: true,
      // 我們自己用 token_hash 換登入狀態(verifyOtp),不讓 client 自己去讀網址上的參數。
      detectSessionInUrl: false,
    },
  });
  clients.set(normalized, client);
  return client;
}

/** 測試用:清掉快取的 client。 */
export function resetCustomerClientsForTest(): void {
  clients.clear();
}
