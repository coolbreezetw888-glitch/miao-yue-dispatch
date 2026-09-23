// 使用者決策(2026-09-23):「服務人員管理」開放成可以用開關授權給客服的功能,不再永遠限定商家
// 管理員(見 AGENT_PERMISSION_SECTIONS 的 staff_management 項目)。完全比照
// RequireBillingAccess.tsx 的既有寫法:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('staff_management') 回傳 true 才放行。
// 不符合則導回 /app,不顯示這個頁面存在——這是 StaffListPage.tsx/StaffPermissionsPage.tsx 的
// 獨立入口(功能卡片),不是常駐分頁籤,所以維持「導回 /app」而不是「原地顯示空狀態文字」這個既有模式
// (跟 OrdersTabAccessGate 那種常駐分頁籤的設計目的不同)。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入的是
// private.can_manage_staff 這支函式落實的 merchant_staff/merchant_staff_service_items RLS 政策
// (見 migration 20260923050000_staff_management_agent_permission),即使有人繞過前端路由直接
// 呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "./context";

export function RequireStaffManagementAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageStaff, isLoading: permissionLoading } =
    useAgentPermission("staff_management");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageStaff === true;
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
