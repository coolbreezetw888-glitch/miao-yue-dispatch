// SPECS-INDEX #976 第 3 批(2026-10-06):「再行銷通知」頁(/app/line-marketing)的路由守衛。
// 改前只給商家管理員(RequireMerchantAdmin);新增客服權限 line_marketing 之後,改成「管理員或
// line_marketing 權限開啟的客服」—— 完全比照 RequireLineNotificationAccess 的既有寫法(fail-closed:
// 載入中只渲染 GuardLoading、一律用嚴格 === true)。
// 後端同一個判斷:private.can_send_line_marketing(名單 RPC、Edge Function、會員等級讀取)。

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

export function RequireLineMarketingAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canSendLineMarketing, isLoading: permissionLoading } =
    useAgentPermission("line_marketing");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canSendLineMarketing === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      // #1007(第 14 批):客服沒有這個權限被導回時,跳「你沒有「X」的權限」提示,不再安靜導回。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(agentPermissionLabel("line_marketing"));
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, allowed, loading, navigate, role]);

  if (loading || !merchant || !allowed) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
