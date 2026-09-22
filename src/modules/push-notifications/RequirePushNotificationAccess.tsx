// 模組 15(服務人員推播通知)§7.9:推播事件設定頁的路由守衛。完全比照
// RequireLineNotificationAccess.tsx 的既有寫法:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('push_notification') 回傳 true 才放行。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入/讀取的是
// private.can_manage_push_notification 這支函式落實的 RLS 政策(規格書 7.3),即使有人繞過前端
// 路由直接呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequirePushNotificationAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManagePushNotification, isLoading: permissionLoading } =
    useAgentPermission("push_notification");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManagePushNotification === true;
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
