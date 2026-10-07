// 模組 12 §4.5:報表匯出中心的路由守衛。對應規則 2.9:報表匯出是唯讀操作，維持一般客服權限
// 開關模式，完全比照模組 7/8/10 既有寫法(RequireBillingAccess.tsx 等)，對應
// report_export 這個 section_key。
//
// 這個元件只控制「能不能打開報表匯出中心這個畫面」，實際能匯出到什麼資料範圍，完全由各自來源
// 模組(訂單/會員/抽成/請假)的既有 RLS/函式權限決定(規則 2.9)，不是這個守衛的責任。

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

export function RequireReportExportAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canExportReports, isLoading: permissionLoading } =
    useAgentPermission("report_export");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canExportReports === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      // #1007(第 14 批):客服沒有這個權限被導回時,跳「你沒有「X」的權限」提示,不再安靜導回。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(agentPermissionLabel("report_export"));
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, allowed, loading, navigate, role]);

  if (loading || !merchant || !allowed) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
