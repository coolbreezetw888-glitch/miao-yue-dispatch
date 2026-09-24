// 模組 15 §7.5(選配):服務人員詳情頁疊加顯示推播狀態。
// 對外掛載元件,模組 3 的服務人員編輯表單(StaffFormDialog,src/modules/staff-agent/
// StaffListPage.tsx)只負責在編輯既有服務人員時掛載這個元件,不重寫任何邏輯。純唯讀顯示,
// 不含任何操作按鈕(§2.1 邊界情況:管理員只能看數量,不能看/動裝置明細)。
//
// 🔴 2026-09-25 裁決 Q6(使用者的硬性要求):**這一欄的文字一定要改。**
//    新設計下裝置屬於登入帳號(§2.1),所以「已開通 2 台」**不再等於**「他會收到這間店的通知」
//    —— 他可能把四個事件全部關掉。照舊寫會讓老闆看著「已開通 2 台」卻納悶他為什麼沒收到。
//
//    三種互斥狀態、三種 Badge 樣式,**不要省第三種**:如果「已開通但全關」沿用主色 Badge,
//    視覺上跟「會收到通知」一模一樣,老闆掃過去只會看到「已開通」三個字,那正是 Q6 要修掉的誤導。
//
//    補充小字只在「0 台」與「全關」時出現 —— 正常狀態不需要解釋,要解釋的永遠是「為什麼沒收到」。

import { Badge } from "@/components/ui/badge";

import { useStaffPushStatus } from "./api";

export function StaffPushSubscriptionSummary({ staffId }: { staffId: string }) {
  const { data: status, isLoading } = useStaffPushStatus(staffId);

  const deviceCount = status?.deviceCount ?? 0;
  const anyEventEnabled = status?.anyEventEnabled ?? false;

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-3">
      <p className="text-sm font-medium text-foreground">推播通知</p>
      {isLoading ? (
        <span className="text-xs text-muted-foreground">載入中⋯</span>
      ) : deviceCount === 0 ? (
        <div className="space-y-1 text-right">
          <Badge variant="secondary">尚未開通</Badge>
          <p className="text-xs text-muted-foreground">他還沒在任何手機上開啟推播通知。</p>
        </div>
      ) : anyEventEnabled ? (
        <Badge variant="default">已開通 {deviceCount} 台,會收到通知</Badge>
      ) : (
        <div className="space-y-1 text-right">
          {/* 第三種狀態刻意用跟上面兩種都不一樣的樣式(outline)。 */}
          <Badge variant="outline">已開通 {deviceCount} 台,但他關閉了全部通知</Badge>
          <p className="text-xs text-muted-foreground">
            他的手機可以收通知,但他自己把四種事件全部關掉了——所以這間店的訂單不會通知他。
          </p>
        </div>
      )}
    </div>
  );
}
