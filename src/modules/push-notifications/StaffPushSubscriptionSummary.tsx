// 模組 15(服務人員推播通知)§7.5(選配):服務人員詳情頁疊加顯示「已開通推播裝置數」。
// 對外掛載元件,模組 3 的服務人員編輯表單(StaffFormDialog,src/modules/staff-agent/
// StaffListPage.tsx)只負責在編輯既有服務人員時掛載這個元件,不重寫任何邏輯。純唯讀顯示,
// 不含任何操作按鈕(2.1 邊界情況:管理員只能看數量,不能看/動裝置明細)。

import { Badge } from "@/components/ui/badge";

import { useStaffPushSubscriptionCount } from "./api";

export function StaffPushSubscriptionSummary({ staffId }: { staffId: string }) {
  const { data: count, isLoading } = useStaffPushSubscriptionCount(staffId);

  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-3">
      <p className="text-sm font-medium text-foreground">推播通知</p>
      {isLoading ? (
        <span className="text-xs text-muted-foreground">載入中⋯</span>
      ) : count && count > 0 ? (
        <Badge variant="default">已開通 {count} 台裝置</Badge>
      ) : (
        <Badge variant="secondary">尚未開通</Badge>
      )}
    </div>
  );
}
