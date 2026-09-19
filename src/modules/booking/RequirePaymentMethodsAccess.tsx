// 模組 9(支付方式)v2 §5.1:付款方式管理頁的路由守衛。完全比照 RequireMaterialCostsAccess.tsx
// 的既有寫法。判斷邏輯:merchantRole === 'admin' 一律放行;merchantRole === 'agent' 則要求
// useAgentPermission('payment_methods') 回傳 true 才放行。不符合則導回 /app,不顯示這個頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入的是
// private.can_manage_payment_methods 這支函式落實的 RLS(規格書 §4),即使有人繞過前端路由
// 直接呼叫 API,也會被資料庫擋下。「建單時選擇既有付款方式」不受這個守衛限制,那是
// RequireBookingAccess.tsx(orders 權限)的範圍,兩者是獨立的兩把鑰匙(§4 修正)。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequirePaymentMethodsAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManagePaymentMethods, isLoading: permissionLoading } =
    useAgentPermission("payment_methods");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManagePaymentMethods === true;
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
