// 模組 7(排班與休假管理)§4.6:排班一覽頁(4.4)的路由守衛。完全比照
// RequirePaymentMethodsAccess.tsx 的既有寫法,只是這次判斷的 section_key 是 scheduling
// (獨立於 team_leave 的另一把鑰匙,見規格書規則 2.11/第〇節判斷 7)。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireSchedulingAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canViewScheduling, isLoading: permissionLoading } =
    useAgentPermission("scheduling");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canViewScheduling === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      navigate("/app", { replace: true });
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
