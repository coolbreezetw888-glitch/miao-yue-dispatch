// 4.2:服務項目管理頁的路由守衛。比照模組 3 RequireMerchantAdmin.tsx 的既有寫法。
// 判斷邏輯:merchantRole === 'admin' 一律放行;merchantRole === 'agent' 則要求
// useAgentPermission('service_items') 回傳 true 才放行。不符合則導回 /app,不顯示這個頁面存在
// (比照 RequireMerchantAdmin 的既有做法)。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入的是
// private.can_manage_service_items 這支函式落實的 RLS(規格書 3.1/3.2),即使有人繞過前端路由
// 直接呼叫 API,也會被資料庫擋下(規則 2.5)。
//
// import 模組 3 對外介面的 useCurrentMerchantRole()/useAgentPermission(),不重新發明判斷邏輯,
// 也不直接 import 模組 3 內部的 merchant_agents/merchant_agent_permissions 表查詢邏輯,保持模組
// 獨立性(規格書 4.2)。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireServiceItemsAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageServiceItems, isLoading: permissionLoading } =
    useAgentPermission("service_items");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageServiceItems === true;
  // agent 角色時要等 useAgentPermission 也載入完成才能下判斷,避免權限查詢還沒回來就誤判成沒有權限。
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
