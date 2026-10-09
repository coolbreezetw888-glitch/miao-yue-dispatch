// SPECS-INDEX #1025 FG3-U01(使用者 F8 裁決):這間店的平台功能「服務人員登入端」關掉時,
// 服務人員登入後整個服務人員端只剩這一張置中小卡:一句話 + 「登出」。
//   ・不提秒約、不提開通(X5:不洩漏「店家沒開」這類資訊),叫他找店家。
//   ・只有服務人員本人看得到(AppLayout 只在服務人員端顯示)。
// 真正擋住資料的是資料庫(has_own_staff_permission 等,FG3-F01);這張卡只是讓他不以為系統壞掉。

import { Button } from "@/components/ui/button";
import { STAFF_PORTAL_CLOSED_MESSAGE } from "@/routes/appLayoutLogic";

export function StaffPortalClosedNotice({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center"
        data-testid="staff-portal-closed"
      >
        <p className="text-[15px] leading-relaxed text-foreground">{STAFF_PORTAL_CLOSED_MESSAGE}</p>
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="mt-5 w-full"
          data-testid="staff-portal-closed-signout"
          onClick={onSignOut}
        >
          登出
        </Button>
      </div>
    </div>
  );
}
