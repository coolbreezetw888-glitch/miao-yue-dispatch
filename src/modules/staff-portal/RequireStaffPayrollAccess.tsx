// 對應規格書 4.5 涉及元件:路由守衛。檢查 role==='staff' 且已開通 staff_payroll_view 權限。
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權操作的是
// private.can_view_staff_own_payroll 落實的 RLS/SECURITY DEFINER 函式權限檢查(規則 2.4)。
//
// 商家端調整批次(2026-09-22,.project/SPECS-INDEX.md #609,.project/specs/服務人員端.md
// §15.1):這個頁面從「掛在 /app/manage 底下的一張卡片連結」改成 AppLayout 底部「薪資報表」
// 分頁籤直接可達,/app/manage 這個路由對服務人員角色而言已經不存在對應的入口。原本「不符合就
// 導回 /app/manage」的行為因此不再適用——規格書明講分頁籤永遠顯示,沒有權限的服務人員點進來要
// 看到既有的空狀態文字(比照 4.3 MyCalendarPage.tsx 的既有模式),不是被導離。只有「根本不是
// 服務人員角色」這種理論上不會發生的情況(這個路由只會被服務人員底部分頁籤連到)才維持導離,
// 當成防呆。
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { useMyStaffPermission } from "./context";

export function RequireStaffPayrollAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: hasPermission, isLoading: permissionLoading } =
    useMyStaffPermission("staff_payroll_view");

  const loading = merchantLoading || roleLoading || permissionLoading;
  const isStaff = role === "staff";

  useEffect(() => {
    if (loading) return;
    if (!merchant || !isStaff) {
      navigate("/app/manage", { replace: true });
    }
  }, [merchant, isStaff, loading, navigate]);

  if (loading || !merchant || !isStaff) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (hasPermission !== true) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「抽成/薪資報表檢視」權限。
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
