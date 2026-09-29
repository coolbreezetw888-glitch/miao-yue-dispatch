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
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill 二之四,Badge → StatusTag。
// 🔴 Q6 的「三種狀態要有三種樣式」完全保留,只是換成 skill 定義的狀態配色:
//     0 台            → neutral(灰系,結束/尚未啟用)
//     有裝置且有開事件 → success(綠系,正常)
//     有裝置但全關    → warning(黃系,要注意)——跟前兩種都不同,老闆一眼看得出「他收不到」
// 🔴「0 台」刻意用 neutral 而**不是**待辦標籤:推播是選配功能,不打算用的服務人員永遠是
//    「尚未開通」,那是永久狀態 = 屬性,屬性不給警示色(skill 二之五末段,跟 #846 黃卡同一條通則)。
// 「全關」那段補充說明改成 🟡 常駐 `!`(AlertNote):它是「為什麼他收不到」,絕對不能收起來。
// 載入中改灰色骨架(二之八)。

import { AlertNote, StatusTag } from "@/components/patterns";
import { Skeleton } from "@/components/ui/skeleton";

import { useStaffPushStatus } from "./api";

export function StaffPushSubscriptionSummary({ staffId }: { staffId: string }) {
  const { data: status, isLoading } = useStaffPushStatus(staffId);

  const deviceCount = status?.deviceCount ?? 0;
  const anyEventEnabled = status?.anyEventEnabled ?? false;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">推播通知</p>
        {isLoading ? (
          <Skeleton className="h-5 w-24 rounded-full bg-muted" />
        ) : deviceCount === 0 ? (
          // 🔴 中性,不是待辦:推播是選配功能,不打算用的人永遠是「尚未開通」——
          // 永久狀態就是屬性,屬性不給警示色(skill 二之五末段,#846 同一條通則)。
          <StatusTag tone="neutral">尚未開通</StatusTag>
        ) : anyEventEnabled ? (
          <StatusTag tone="success">已開通 {deviceCount} 台,會收到通知</StatusTag>
        ) : (
          // 🔴 第三種狀態刻意跟上面兩種都不一樣(warning):老闆需要一眼看出「他收不到」,
          // 如果沿用跟「會收到通知」一樣的樣式,掃過去只會看到「已開通」三個字 —— 那正是 Q6 要修掉的誤導。
          <StatusTag tone="warning">已開通 {deviceCount} 台,但他關閉了全部通知</StatusTag>
        )}
      </div>
      {!isLoading && deviceCount === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          他還沒在任何手機上開啟推播通知。
        </p>
      ) : null}
      {!isLoading && deviceCount > 0 && !anyEventEnabled ? (
        // 🟡 常駐 `!`:「為什麼他收不到」屬於絕對不能收起來的那一類(skill 二)。
        <AlertNote>
          他的手機可以收通知,但他自己把四種事件全部關掉了——所以這間店的訂單不會通知他。
        </AlertNote>
      ) : null}
    </div>
  );
}
