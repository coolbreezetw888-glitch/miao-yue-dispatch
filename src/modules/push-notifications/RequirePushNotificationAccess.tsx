// 模組 15(服務人員推播通知)§7.9:推播事件設定頁的路由守衛。完全比照
// RequireLineNotificationAccess.tsx 的既有寫法:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('push_notification') 回傳 true 才放行。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入/讀取的是
// private.can_manage_push_notification 這支函式落實的 RLS 政策(規格書 7.3),即使有人繞過前端
// 路由直接呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { GuardLoading } from "@/components/patterns";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";
import {
  agentPermissionLabel,
  notifyPermissionDenied,
  shouldNotifyPermissionDenied,
} from "@/modules/staff-agent/permissionDeniedNotice";

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
      // #1007(第 14 批):客服沒有這個權限被導回時,跳「你沒有「X」的權限」提示,不再安靜導回。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(agentPermissionLabel("push_notification"));
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, allowed, loading, navigate, role]);

  if (loading || !merchant || !allowed) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
