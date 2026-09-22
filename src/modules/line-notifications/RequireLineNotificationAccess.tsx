// 模組 11(LINE 通知)§4.9:通知事件設定頁(4.2)/發送記錄頁(4.3)的路由守衛。完全比照
// RequireTeamLeaveAccess.tsx/RequireMembersAccess.tsx 的既有寫法。判斷邏輯:
// merchantRole === 'admin' 一律放行;merchantRole === 'agent' 則要求
// useAgentPermission('line_notification') 回傳 true 才放行。不符合則導回 /app,不顯示這個
// 頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入/讀取的是
// private.can_manage_line_notification 這支函式落實的 RLS/SECURITY DEFINER 函式檢查(規格書
// 規則 2.10),即使有人繞過前端路由直接呼叫 API,也會被資料庫擋下。
//
// 4.1(LINE 串接設定頁)/4.4(行銷通知頁)不使用這個守衛——那兩個頁面永遠只給商家管理員
// (規則 2.1/2.6),直接沿用既有的 RequireMerchantAdmin.tsx,不需要另外的守衛元件。
//
// 規則 2.11:判斷登入狀態一律呼叫 getVerifiedUser()——這裡透過 useCurrentMerchantRole/
// useAgentPermission 間接呼叫(這兩支 hook 內部都呼叫 getVerifiedUser()),不自己重新呼叫
// Supabase Auth API。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireLineNotificationAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageLineNotification, isLoading: permissionLoading } =
    useAgentPermission("line_notification");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageLineNotification === true;
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
