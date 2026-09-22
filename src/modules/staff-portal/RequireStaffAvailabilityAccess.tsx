// 對應規格書 4.4 涉及元件:路由守衛。檢查 role==='staff' 且 staff_availability_self_manage
// 權限且 compensation_type='piece_rate' 兩個條件。
// 這個元件只是體驗層的路由守衛,不是安全邊界——真正擋住未授權操作的是
// private.can_self_manage_availability 落實的 RLS/SECURITY DEFINER 函式權限檢查(規則 2.2/2.4)。
//
// 商家端調整批次(2026-09-22,.project/SPECS-INDEX.md #609,.project/specs/服務人員端.md
// §15.1):這個頁面從「掛在 /app/manage 底下的一張卡片連結」改成 AppLayout 底部「休假設定」
// 分頁籤直接可達,/app/manage 這個路由對服務人員角色而言已經不存在對應的入口。原本「不符合就
// 導回 /app/manage」的行為因此不再適用——規格書明講分頁籤永遠顯示,沒有權限/非按件計酬的服務
// 人員點進來要看到既有的空狀態文字(比照 4.3 MyCalendarPage.tsx 的既有模式),不是被導離。
// 只有「根本不是服務人員角色」這種理論上不會發生的情況(這個路由只會被服務人員底部分頁籤連到)
// 才維持導離,當成防呆。
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { useActiveMyStaffRecord, useMyStaffPermission } from "./context";

export function RequireStaffAvailabilityAccess({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: staffRow, isLoading: staffLoading } = useActiveMyStaffRecord(merchant?.id ?? null);
  const { data: hasPermission, isLoading: permissionLoading } = useMyStaffPermission(
    "staff_availability_self_manage",
  );

  const loading = merchantLoading || roleLoading || staffLoading || permissionLoading;
  const isStaff = role === "staff";

  useEffect(() => {
    if (loading) return;
    if (!merchant || !isStaff) {
      navigate("/app/manage", { replace: true });
    }
  }, [merchant, isStaff, loading, navigate]);

  if (loading || !merchant || !isStaff) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (hasPermission !== true) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「可預約時段/休假自助調整」權限。
        </p>
      </div>
    );
  }

  if (staffRow?.compensation_type !== "piece_rate") {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          這個功能僅提供給按件計酬的服務人員使用。
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
