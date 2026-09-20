// 對應規格書 4.5 涉及元件:路由守衛。檢查 role==='staff' 且已開通 staff_payroll_view 權限,
// 不符合導回 /app/manage。這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權操作的是
// private.can_view_staff_own_payroll 落實的 RLS/SECURITY DEFINER 函式權限檢查(規則 2.4)。

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
  const allowed = role === "staff" && hasPermission === true;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      navigate("/app/manage", { replace: true });
    }
  }, [merchant, allowed, loading, navigate]);

  if (loading || !merchant || !allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return <>{children}</>;
}
