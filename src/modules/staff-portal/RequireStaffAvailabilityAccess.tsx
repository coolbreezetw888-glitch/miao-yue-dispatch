// 對應規格書 4.4 涉及元件:路由守衛。檢查 role==='staff' 且 staff_availability_self_manage
// 權限且 compensation_type='piece_rate' 兩個條件,不符合導回 /app/manage——月薪制服務人員即使
// 被開通權限也不顯示這個頁面(規則 2.2),避免點進去才發現不能用。
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權操作的是
// private.can_self_manage_availability 落實的 RLS/SECURITY DEFINER 函式權限檢查(規則 2.2/2.4)。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { useActiveMyStaffRecord, useMyStaffPermission } from "./context";

export function RequireStaffAvailabilityAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: staffRow, isLoading: staffLoading } = useActiveMyStaffRecord(merchant?.id ?? null);
  const { data: hasPermission, isLoading: permissionLoading } = useMyStaffPermission(
    "staff_availability_self_manage",
  );

  const loading = merchantLoading || roleLoading || staffLoading || permissionLoading;
  const allowed =
    role === "staff" &&
    hasPermission === true &&
    staffRow?.compensation_type === "piece_rate";

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
