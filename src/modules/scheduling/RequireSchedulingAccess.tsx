// 模組 7(排班與休假管理)§4.6:排班一覽頁(4.4)的路由守衛。完全比照
// RequirePaymentMethodsAccess.tsx 的既有寫法,只是這次判斷的 section_key 是 scheduling
// (獨立於 team_leave 的另一把鑰匙,見規格書規則 2.11/第〇節判斷 7)。
//
// SPECS-INDEX #976 第 3 批(2026-10-06,表 C-4):功能隱藏期間(SCHEDULING_FEATURE_HIDDEN,見
// featureVisibility.ts),這個網址對**所有人**(含商家管理員)一律導回功能頁 /app/manage,
// 不看 scheduling 權限 —— 改前卡片與權限開關藏起來了,開過權限的客服打網址仍進得去。
// 還原時把那個常數改成 false,這裡自動恢復成原本「管理員或 scheduling 客服」的判斷。

import { useEffect, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { GuardLoading } from "@/components/patterns";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { SCHEDULING_FEATURE_HIDDEN, SCHEDULING_HIDDEN_REDIRECT_TO } from "./featureVisibility";
import {
  agentPermissionLabel,
  notifyPermissionDenied,
  shouldNotifyPermissionDenied,
} from "@/modules/staff-agent/permissionDeniedNotice";

export function RequireSchedulingAccess({ children }: { children: ReactNode }) {
  if (SCHEDULING_FEATURE_HIDDEN) {
    return <Navigate to={SCHEDULING_HIDDEN_REDIRECT_TO} replace />;
  }
  return <RequireSchedulingPermission>{children}</RequireSchedulingPermission>;
}

function RequireSchedulingPermission({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canViewScheduling, isLoading: permissionLoading } =
    useAgentPermission("scheduling");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canViewScheduling === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  useEffect(() => {
    if (loading) return;
    if (!merchant || !allowed) {
      // #1007(第 14 批):客服沒有這個權限被導回時,跳「你沒有「X」的權限」提示,不再安靜導回。
      if (shouldNotifyPermissionDenied({ hasMerchant: merchant != null, role })) {
        notifyPermissionDenied(agentPermissionLabel("scheduling"));
      }
      navigate("/app", { replace: true });
    }
  }, [merchant, allowed, loading, navigate, role]);

  if (loading || !merchant || !allowed) {
    return <GuardLoading />;
  }

  return <>{children}</>;
}
