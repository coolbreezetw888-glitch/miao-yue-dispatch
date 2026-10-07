// 模組 8(薪資與帳務)§4.5:服務人員報表頁(4.4)的路由守衛。完全比照模組 7
// RequireTeamLeaveAccess.tsx 的既有寫法。判斷邏輯:merchantRole === 'admin' 一律放行;
// merchantRole === 'agent' 則要求 useAgentPermission('staff_report') 回傳 true 才放行。
// 不符合則導回 /app,不顯示這個頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權讀取的是
// private.can_view_payroll_reports 這支函式落實的 get_staff_commission_summary/
// get_staff_monthly_payroll_summary 權限檢查(規格書 §3.1/§3.9/§3.10,billing 權限也連帶放行,
// 是規格書明講的設計,不是漏洞),即使有人繞過前端路由直接呼叫 API,也會被資料庫擋下。

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

export function RequireStaffReportAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canViewStaffReport, isLoading: permissionLoading } =
    useAgentPermission("staff_report");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canViewStaffReport === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      // #1007(第 14 批):客服沒有這個權限被導回時,跳「你沒有「X」的權限」提示,不再安靜導回。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(agentPermissionLabel("staff_report"));
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, allowed, loading, navigate, role]);

  if (loading || !merchant || !allowed) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
