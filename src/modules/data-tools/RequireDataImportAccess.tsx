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

import { GuardLoading } from "@/components/patterns";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";
import {
  notifyPermissionDenied,
  shouldNotifyPermissionDenied,
} from "@/modules/staff-agent/permissionDeniedNotice";

export function RequireDataImportAccess({
  children,
  featureName = "資料匯入",
}: {
  children: ReactNode;
  /** #1007:被擋時提示裡的功能名稱(預設「資料匯入」;匯入紀錄、產業轉移頁各自傳自己的頁名)。 */
  featureName?: string;
}) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();

  const isAdmin = role === "admin";
  const loading = merchantLoading || roleLoading;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !isAdmin) {
      // #1007(第 14 批):資料匯入 / 匯入紀錄 / 產業轉移只給商家管理員,客服被導回時也跳提示。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(featureName);
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, isAdmin, loading, navigate, role, featureName]);

  if (loading || !merchant || !isAdmin) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
