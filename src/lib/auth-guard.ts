// 2026-09 排查的嚴重穩定性 bug 的修法核心,獨立成一個共用檔案(不放進
// src/integrations/supabase/client.ts,因為那個檔案是 Lovable 自動產生、標記「不要直接編輯」,
// 之後重新同步會被蓋掉)。
//
// 根本原因(用瀏覽器實際重現、加中斷點/攔截 fetch 呼叫堆疊確認過,不是用猜的):
//   1. src/routes/signin.tsx 原本用 supabase.auth.getSession() 判斷「已登入就導去 /app」。
//      getSession() 只讀本機 localStorage 快取的 session,不會打去 Supabase 伺服器驗證這組
//      憑證是否還有效——即使 access token 已經失效/過期/被撤銷,只要本機還留著「格式正確、
//      expires_at 還沒到」的 session 物件,getSession() 就會回傳「已登入」。
//   2. src/routes/app.tsx (AppShell)、src/modules/merchant/context.tsx
//      (CurrentMerchantProvider)、src/modules/platform-admin/PlatformAdminGuard.tsx 這三處都是用
//      supabase.auth.getUser()——這支才會真的打去 Supabase 伺服器驗證,憑證失效時伺服器回
//      401/403。但這三處收到失敗結果後,只是把畫面導去 /signin,沒有把 localStorage 裡那份
//      已經失效的憑證清掉。
//   3. 兩者合起來就是無限迴圈:AppShell 發現憑證無效 → 導去 /signin → /signin 用本機快取判斷
//      「已登入」→ 導回 /app → AppShell 重新掛載,再打一次 getUser() → 又失效 → 又導去
//      /signin → ……如此反覆,每一輪都會打一次 GET /auth/v1/user(實測重現時每秒 20 幾次），
//      畫面卡在「載入中」永遠不會結束,直到使用者手動清空 localStorage。
//
// 修法:
//   - 任何要「用目前登入狀態決定畫面走向」的地方(不管是「沒登入就導去 /signin」還是「已登入
//     就導去 /app」),一律呼叫這裡的 getVerifiedUser(),不要自己呼叫 getSession() 或直接呼叫
//     getUser()——getVerifiedUser() 保證是打去伺服器驗證過的結果,不是只信本機快取。
//   - 驗證後發現憑證確實無效(伺服器明確回應「這組憑證不對」,例如 401/403 的 AuthApiError)時,
//     順手在背景呼叫 supabase.auth.signOut() 清掉本機那份無效憑證,避免之後每次進站都还要再
//     多打一次注定失敗的驗證請求。刻意不 await 這支網路請求——「導去 /signin 的畫面轉場」不該
//     被這個收尾動作卡住,否則會重演 src/routes/app.tsx handleSignOut 那次修過的「等網路請求
//     跑完才轉場，卡住 5-9 秒」問題。
//   - 純網路問題(暫時斷線、伺服器 5xx)時 SDK 丟的是 AuthRetryableFetchError,不是
//     AuthApiError,這裡不會觸發 signOut(),避免使用者只是網路不穩就被誤登出。
//   - 任何非預期例外都在這裡吞掉、統一回傳 null,不讓 Promise reject 到呼叫端——呼叫端如果漏寫
//     .catch(),原本就是這次 bug「畫面永久卡在載入中」的另一個成因。

import { isAuthApiError, type User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/**
 * 回傳「目前這組憑證,經 Supabase 伺服器驗證後」對應的使用者;沒登入或憑證已經失效一律回傳
 * null。所有需要判斷登入狀態的畫面(登入頁的「已登入就跳轉」、/app 與 /platform-admin 系列的
 * 路由守衛、CurrentMerchantProvider 的使用者身份判斷)都應該呼叫這支,不要各自重新呼叫
 * supabase.auth.getSession() / supabase.auth.getUser()。
 */
export async function getVerifiedUser(): Promise<User | null> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      if (isAuthApiError(error)) {
        // 背景清除,不擋畫面轉場(理由見檔案開頭說明)。
        void supabase.auth.signOut().catch(() => undefined);
      }
      return null;
    }
    return data.user ?? null;
  } catch {
    return null;
  }
}
