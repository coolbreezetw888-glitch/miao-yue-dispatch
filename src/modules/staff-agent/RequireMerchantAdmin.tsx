// 共用守衛:4.2/4.3/4.4 這幾個管理頁面只給商家管理員使用(客服不能管理其他人員/自己的權限,
// 見規格書 3.11:merchant_staff/merchant_agents/merchant_agent_permissions 的寫入一律限定
// is_merchant_admin)。不是管理員(或還沒選定商家)一律導回 /app,不顯示這個頁面存在,
// 比照 PlatformAdminGuard 的既有設計精神。
// 判斷登入狀態一律透過 useCurrentMerchantRole(內部呼叫 getVerifiedUser,規則 2.10),
// 不自己重新呼叫 Supabase Auth API。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { GuardLoading } from "@/components/patterns";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "./context";
import { notifyPermissionDenied, shouldNotifyPermissionDenied } from "./permissionDeniedNotice";

export function RequireMerchantAdmin({
  children,
  featureName,
}: {
  children: ReactNode;
  /** #1007:被擋時提示裡的功能名稱(各頁傳自己的頁名;沒傳就照舊安靜導回)。 */
  featureName?: string;
}) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();

  useEffect(() => {
    if (merchantLoading || roleLoading) return;
    if (!merchant || role !== "admin") {
      // #1007(第 14 批):這幾頁只給商家管理員,客服被導回時跳「你沒有「X」的權限」提示。
      if (featureName && shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(featureName);
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, merchantLoading, role, roleLoading, navigate, featureName]);

  if (merchantLoading || roleLoading || !merchant || role !== "admin") {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
