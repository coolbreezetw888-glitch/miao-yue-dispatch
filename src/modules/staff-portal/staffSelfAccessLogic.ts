// 模組 14(服務人員端)自助頁面路由守衛的判斷條件(純函式,方便測試)。
//
// ⚠️ 2026-09-24 線上故障調查時發現的第二個(而且更嚴重的)缺口:
//
// RequireStaffAvailabilityAccess.tsx / RequireStaffPayrollAccess.tsx 原本都是用
//     const isStaff = useCurrentMerchantRole().data === "staff";
// 當守衛條件,不符合就 navigate("/app/manage")。
//
// 但 useCurrentMerchantRole 的優先序是 管理員 → 客服 → 服務人員(模組 3 context.tsx 規則 2.10),
// 同一個人身兼多重角色時一律回傳較高權限的角色。所以一位「這間商家的客服 + 同一間商家的服務人員」
// 的使用者,role 永遠解析成 'agent',永遠不會是 'staff' ——
//   ⇒ 他被這兩個守衛直接導去 /app/manage,而 /app/manage 對沒有客服權限的他而言是一片空白。
//   ⇒ 這代表 2026-09-23 加上的「雙重身分切換服務人員端」功能,即使使用者找得到那個切換選項,
//      四個服務人員分頁籤裡也有兩個(休假設定、薪資報表)根本進不去,會被彈回商家端。
//      也就是說那個功能從來沒有真正可用過,不只是「入口難找」而已。
//
// 正確的判斷條件是「我在這間商家有沒有一筆在職且已開通登入的 merchant_staff 紀錄」——也就是
// useActiveMyStaffRecord 的結果,跟角色優先序無關。這同時也讓前端守衛跟真正的安全邊界一致:
// 後端 private.can_self_manage_availability / private.can_view_staff_own_payroll 檢查的本來就是
// merchant_staff 那一列,不是「解析出來的角色」。所以改成這樣不會放寬任何實際權限,只是不再把
// 有權限的人擋在門外。
//
// (同一個缺口也存在於 src/modules/booking/CalendarPage.tsx 的 CalendarPageRoleGate
//  `if (role === "staff")`,那個檔案屬於模組 5,不在這次交辦的檔案範圍內,已回報主腦。)

export interface StaffSelfAccessInput {
  /** 目前操作中的商家已經選定。 */
  hasCurrentMerchant: boolean;
  /** useActiveMyStaffRecord(目前商家).data != null —— 我是這間商家「在職且已開通登入」的服務人員。 */
  hasActiveStaffRecord: boolean;
}

/** 這個人可以進入服務人員自助頁面嗎?(還不管個別權限開關,那是守衛的下一層判斷) */
export function canAccessStaffSelfPages({
  hasCurrentMerchant,
  hasActiveStaffRecord,
}: StaffSelfAccessInput): boolean {
  return hasCurrentMerchant && hasActiveStaffRecord;
}

/** 守衛該不該把人導離到 /app/manage。
 * ⚠️ 只有在「所有相關查詢都載入完成」之後才可以做這個判斷 —— 載入中就導離是另一種常見的競態 bug。 */
export function shouldRedirectAwayFromStaffSelfPage(input: {
  loading: boolean;
  hasCurrentMerchant: boolean;
  hasActiveStaffRecord: boolean;
}): boolean {
  if (input.loading) return false;
  return !canAccessStaffSelfPages(input);
}
