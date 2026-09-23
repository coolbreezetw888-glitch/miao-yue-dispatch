// 模組 8(薪資與帳務)§4.5:店家端帳務報表頁(4.3)的路由守衛。
//
// 使用者決策(2026-09-23):「店家報表」(原名「店家帳務報表」)從「功能」頁的卡片升級成 AppLayout
// 底部常駐分頁籤(比照訂單管理當初升級成分頁籤的既有模式)。分頁籤規格要求「永遠顯示,沒有權限
// 就在原地看到提示文字」,不是把分頁籤藏起來或導離——這裡因此從原本的「不符合就 navigate('/app')」
// 改成完全比照 OrdersPage.tsx::OrdersTabAccessGate 的既有寫法:沒有權限時原地顯示提示文字,不
// navigate() 離開。
//
// 這個元件只是體驗層的顯示邏輯,不是安全邊界——真正擋住未授權讀取的是
// private.can_view_billing 這支函式落實的 get_merchant_billing_summary 權限檢查(規格書 §3.1/§3.11),
// 即使有人繞過前端路由直接呼叫 API,也會被資料庫擋下。

import type { ReactNode } from "react";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireBillingAccess({ children }: { children: ReactNode }) {
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canViewBilling, isLoading: permissionLoading } = useAgentPermission("billing");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canViewBilling === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  if (loading || !merchant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「帳務管理」權限。
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
