// 模組 8(薪資與帳務)§4.5:店家端帳務報表頁(4.3)的路由守衛。完全比照模組 7
// RequireTeamLeaveAccess.tsx 的既有寫法。判斷邏輯:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('billing') 回傳 true 才放行。
// 不符合則導回 /app,不顯示這個頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權讀取的是
// private.can_view_billing 這支函式落實的 get_merchant_billing_summary 權限檢查(規格書 §3.1/§3.11),
// 即使有人繞過前端路由直接呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireBillingAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canViewBilling, isLoading: permissionLoading } = useAgentPermission("billing");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canViewBilling === true;
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
