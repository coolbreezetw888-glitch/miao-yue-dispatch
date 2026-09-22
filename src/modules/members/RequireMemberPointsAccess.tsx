// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」)涉及元件:路由守衛,完全比照
// RequireMembersAccess.tsx 的既有寫法——沿用同一個 members section_key(規格書「涉及元件」一節
// 明講由 engineer 決定點數餘額檢視/兌換/手動調整這些操作歸在 members 還是 member_settings,
// 這裡選 members:操作性質上跟既有會員管理權限邊界一致,不新增權限項目)。
// 判斷邏輯:merchantRole === 'admin' 一律放行;merchantRole === 'agent' 則要求
// useAgentPermission('members') 回傳 true 才放行。不符合則導回 /app,不顯示這個頁面存在。
//
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權寫入/讀取的是
// private.can_manage_members 這支函式落實的 RLS/SECURITY DEFINER 函式檢查,即使有人繞過
// 前端路由直接呼叫 API,也會被資料庫擋下。

import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

export function RequireMemberPointsAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageMembers, isLoading: permissionLoading } = useAgentPermission("members");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageMembers === true;
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
