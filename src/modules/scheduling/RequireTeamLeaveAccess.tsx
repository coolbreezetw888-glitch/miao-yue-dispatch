// 模組 7(排班與休假管理)§4.6:假別設定頁(4.2)/請假紀錄管理頁(4.3)的路由守衛。完全比照
// RequirePaymentMethodsAccess.tsx 的既有寫法。判斷邏輯:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('team_leave') 回傳 true 才放行。
// 不符合則導回 /app,不顯示這個頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入的是
// private.can_manage_team_leave 這支函式落實的 RLS/SECURITY DEFINER 函式檢查(規格書 §3.1/§3.10),
// 即使有人繞過前端路由直接呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireTeamLeaveAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageTeamLeave, isLoading: permissionLoading } =
    useAgentPermission("team_leave");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageTeamLeave === true;
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
