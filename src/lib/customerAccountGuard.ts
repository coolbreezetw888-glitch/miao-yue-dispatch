// 客戶端第 2 批(C2-H01):後台路由守衛的「這是不是客人帳號」判斷。
//
// 客人用 LINE 登入時,登入狀態存在「客戶專用 client」(storageKey = miaoyue-customer-<代碼>),
// 正常情況下後台的 client 永遠拿不到。萬一拿到了(例如有人把客人的登入狀態塞進後台的儲存位置),
// 後台外殼(AppLayout)與超級管理員守衛(PlatformAdminGuard)用這支判斷,顯示「這是客人帳號，不能進入後台」,
// 並且**只登出後台 client**(scope: local)—— 客戶端 client 用的是另一個 storageKey,不受影響。
//
// 判斷依據:app_metadata.account_type = 'customer'(只有 service role 寫得進去,客人自己改不了;
// user_metadata 客人改得到,所以不看)。資料庫那一層另有 private.is_customer_account() 擋建店等函式。

import type { User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export const CUSTOMER_ACCOUNT_BLOCKED_MESSAGE = "這是客人帳號，不能進入後台";

export function isCustomerAccountUser(
  user: Pick<User, "app_metadata"> | null | undefined,
): boolean {
  const meta = user?.app_metadata as Record<string, unknown> | undefined;
  return meta?.["account_type"] === "customer";
}

/** 只登出後台 client(本機),不動伺服器上的登入狀態、也不動客戶端 client 的儲存。 */
export async function signOutBackendClientOnly(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // 登出失敗也不擋畫面:本機那份登入狀態 signOut 一定會清掉。
  }
}
