// 共用外殼(AppLayout)透過 <Outlet context> 傳給子路由的值與讀取 hook。
// #1052 H2-09:原本寫在 AppLayout.tsx,但那支檔案同時 export 元件和 hook,開發時 Fast Refresh 會失效
// (eslint react-refresh/only-export-components),所以搬到這裡。內容沒有改。

import { useOutletContext } from "react-router-dom";

export interface AppLayoutContext {
  email: string | null;
  userId: string | null;
  /** 對應規格書(帳號登入安全性優化)2.5.1:目前登入者自己有沒有一筆 Supabase 原生的待驗證新
   * 信箱(auth.users.new_email)。三種角色共用,不用各自重新呼叫一次 getVerifiedUser()。 */
  newEmail: string | null;
  onSignOut: () => void;
  /** 使用者決策(2026-09-23):目前實際要不要顯示服務人員端內容——純服務人員角色永遠 true;
   * 管理員/客服同時也是服務人員時,依雙重身分切換選擇決定。HomePage.tsx 用這個值決定要渲染
   * 服務人員自己的個人資料頁,還是導去 /app/manage。 */
  isStaffView: boolean;
  /** 2026-09-24 修正:「該看商家端還是服務人員端」這件事現在已經有確定答案了嗎?
   * 角色/服務人員紀錄還在查的時候是 false —— 子路由必須先等這個值變 true 才能做任何導向判斷,
   * 否則會拿「還沒解出來的角色」當成「不是服務人員」用(見 appLayoutLogic.ts isStaffViewResolved)。 */
  isViewResolved: boolean;
  /** 這位使用者是不是雙重身分(管理員/客服 + 同一間商家的服務人員)。ManagePage 用來在
   * 「一張卡片都沒有」的空狀態裡直接給出切換到服務人員端的按鈕。 */
  isDualRoleEligible: boolean;
  /** 切換商家端/服務人員端。isDualRoleEligible 為 false 時呼叫不會有任何效果。 */
  onToggleStaffView: () => void;
}

/** 給子路由(HomePage/ManagePage 等)用,取得共用外殼已經驗證好的 email 跟登出函式,
 * 不用自己重新監聽一次 auth 狀態。 */
export function useAppLayoutContext(): AppLayoutContext {
  return useOutletContext<AppLayoutContext>();
}
