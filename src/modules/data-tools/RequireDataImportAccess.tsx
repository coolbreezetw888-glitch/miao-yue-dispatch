// 模組 12 §4.5:資料匯入/匯入紀錄/產業轉移這三個頁面的路由守衛。
// 對應規則 2.1/2.10:這些操作永遠只給商家管理員，不透過 merchant_agent_permissions 開放給
// 客服，所以刻意不使用 useAgentPermission，直接檢查 merchantRole === 'admin'
// (比照模組 10 §4.2「手動調整」按鈕的既有做法)。
//
// 這個元件只是體驗層的路由守衛，不是安全邊界——真正擋住未授權操作的是後端四支函式內部的
// private.is_merchant_admin 檢查(規則 2.1/2.10)，即使有人繞過前端路由直接呼叫 API，也會被
// 資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireDataImportAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();

  const isAdmin = role === "admin";
  const loading = merchantLoading || roleLoading;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !isAdmin) {
      navigate("/app", { replace: true });
    }
  }, [merchant, isAdmin, loading, navigate]);

  if (loading || !merchant || !isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return <>{children}</>;
}
