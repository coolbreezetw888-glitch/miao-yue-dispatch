// 商家管理員(merchant_admins)在畫面上的顯示 fallback 規則,兩個頁面共用的單一真相。
//
// 為什麼要有這個檔案(2026-09-24):get_merchant_admin_users 這支 RPC 新增回傳
// display_name/job_title/phone 三個欄位之後,「管理員名單」在兩個完全不同的頁面
// 各自渲染,而且兩邊都需要同一套 null fallback:
//   ・商家端 MerchantSettingsPage → MerchantAdminList.tsx
//   ・超級管理員端 platform-admin/MerchantDetailPage.tsx
// 這兩頁共用 useMerchantAdmins() 這個 hook(資料),但 markup 是各自寫的兩份。fallback 規則如果
// 也各自複製一份,規則遲早會漂移(一邊改了、另一邊忘了),所以抽到這裡集中維護。
//
// ⚠️ 這裡刻意「不」import src/routes/ProfileCardShared.tsx 的 emailNamePrefix()——雖然邏輯一樣,
//    但那是 routes(頁面層)的檔案,modules 不該反向依賴 routes,否則模組會被頁面層綁住。
//    這個檔案放在 modules/merchant 底下,是因為 merchant_admins 這張表屬於模組 1(商家與集團
//    管理);platform-admin 本來就已經在 import @/modules/merchant/context,方向一致。
//
// 這個檔案刻意只放純函式與常數、不 import 任何 React 或 supabase client,方便直接寫單元測試。

import type { MerchantAdminUser } from "./types";

/** job_title 為 null/空白時的畫面 fallback。
 * 跟 ManagePage.tsx 個人資料卡片的 jobTitleFallback 用同一個字串,不要各自寫死。 */
export const DEFAULT_ADMIN_JOB_TITLE = "商家管理員";

/** phone 為 null/空白時的畫面 fallback。 */
export const ADMIN_PHONE_PLACEHOLDER = "未填";

/**
 * 管理員在名單上顯示的主要稱呼:有暱稱就用暱稱,否則 fallback 成登入 email 的 @ 前半段。
 *
 * 為什麼是這個 fallback:資料庫端刻意不對這三個新欄位做 coalesce(否則前端無法分辨「真的沒填」
 * 跟「填了那串預設字」),所以 fallback 一律由畫面負責。「@ 前半段」是這個專案既有的慣例
 * (見 ManagePage.tsx 個人資料卡片),不另外發明一套。
 */
export function adminDisplayName(admin: Pick<MerchantAdminUser, "display_name" | "email">): string {
  const nickname = admin.display_name?.trim();
  if (nickname) return nickname;
  const at = admin.email.indexOf("@");
  return at > 0 ? admin.email.slice(0, at) : admin.email;
}

/** 職位,null/空白時 fallback 成「商家管理員」。 */
export function adminJobTitle(admin: Pick<MerchantAdminUser, "job_title">): string {
  return admin.job_title?.trim() || DEFAULT_ADMIN_JOB_TITLE;
}

/** 手機,null/空白時 fallback 成「未填」。 */
export function adminPhone(admin: Pick<MerchantAdminUser, "phone">): string {
  return admin.phone?.trim() || ADMIN_PHONE_PLACEHOLDER;
}

// ⚠️ 這裡原本還有一支 adminContactEmailToShow(),負責判斷「聯絡信箱跟登入 Email 不一樣時才
//    多顯示一行」。2026-09-24 使用者裁決之後整支變成死碼,已刪除:
//      「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
//      「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
//    三種「人」的角色(管理員/客服/服務人員)都只有一個 Email,就是登入 Email
//    (MerchantAdminUser.email,來自 auth.users),所以「兩個 Email 要不要都顯示」這個問題
//    本身已經不存在,名單上的「Email」那一欄直接顯示 admin.email 就好。
//    不要把它加回來。
