// 模組 15 擴充 §7.4:四個事件開關的 UI(使用者裁決的方案 C 真正落地的畫面)。
//
// 重點三件事:
//   1. §4.2 兩層開關:商家總開關關閉的那一項要**灰掉 + 寫明原因**,不然使用者會一直卡在
//      「我明明開了為什麼收不到」。管理員本人額外看到一個連到 /app/push-events 的連結
//      (客服/服務人員不顯示,因為他們可能沒有權限進那一頁)。
//   2. §4.5 / 裁決 Q2:target_type 是 admin/agent 時,不顯示「前一天提醒隔天預約」這一項。
//   3. §4.4 第 3 點:管理員/客服的小字要誠實寫出量有多大(「這間店**每一筆**新訂單都會通知你」)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 每一列改用 SwitchRow(二之七「開關做成一整列」),外觀與全站其他開關一致。
//   - 🔴「商家尚未開啟這個事件的推播通知」從一行灰字改成 🟡 常駐 `!`(AlertNote):
//     skill 二之三明寫「『不能按』的按鈕旁邊一定要有 `!` 說明原因 —— 灰掉但不說為什麼,
//     使用者只會以為壞了」,而這正是上面第 1 點一直想解決的「我明明開了為什麼收不到」。
//     原本靠 opacity-60 把整列調淡的做法拿掉(SwitchRow 的 disabled 已經把標題變淡,
//     再整列調淡會讓那句最重要的原因說明也跟著看不清楚)。
//   - 載入中改灰色骨架方塊(二之八)。
//
// **只動外觀,不動行為**:兩層開關的判斷(merchantEnabled 查不到一律當成沒開)、
// 哪些事件對哪種角色顯示、切換後失敗回滾、data-testid 全部照舊。

import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { AlertNote, SwitchRow } from "@/components/patterns";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  pushEventSubscriptionsQueryKey,
  setMyPushEventSubscription,
  useMerchantPushEventEnabledMap,
  useMyPushEventSubscriptions,
} from "./api";
import {
  PUSH_NOTIFICATION_EVENT_LABELS,
  eventDescriptionForTarget,
  visibleEventTypesForTarget,
  type PushNotificationEventType,
  type PushTargetType,
} from "./types";

export function PushEventToggleList({
  merchantId,
  targetType,
  targetId,
  isMerchantAdmin,
}: {
  merchantId: string;
  targetType: PushTargetType;
  targetId: string;
  /** 只有商家管理員才看得到「去設定頁打開」的連結(§7.4 第 4 點)。 */
  isMerchantAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: subscriptions, isLoading } = useMyPushEventSubscriptions(
    merchantId,
    targetType,
    targetId,
  );
  const { data: merchantEnabledMap } = useMerchantPushEventEnabledMap(merchantId);

  const eventTypes = visibleEventTypesForTarget(targetType);

  async function handleToggle(eventType: PushNotificationEventType, next: boolean) {
    try {
      await setMyPushEventSubscription({
        merchantId,
        targetType,
        targetId,
        eventType,
        enabled: next,
      });
      await queryClient.invalidateQueries({
        queryKey: pushEventSubscriptionsQueryKey(merchantId, targetType, targetId),
      });
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
      // 失敗回滾:重新拉一次伺服器的真實狀態,不要讓畫面停在使用者以為成功的位置。
      await queryClient.invalidateQueries({
        queryKey: pushEventSubscriptionsQueryKey(merchantId, targetType, targetId),
      });
    }
  }

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架方塊,不要用「載入中⋯」四個字。
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
        <Skeleton className="h-16 w-full rounded-lg bg-muted" />
        <Skeleton className="h-16 w-full rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="push-event-toggle-list">
      {eventTypes.map((eventType) => {
        const row = (subscriptions ?? []).find((s) => s.event_type === eventType);
        const personalEnabled = row?.enabled ?? false;
        // §2.6:總開關狀態查不到時(例如函式暫時失敗)一律當成「還沒開」,寧可多解釋也不要
        // 讓使用者以為打開了卻收不到。
        const merchantEnabled = merchantEnabledMap?.[eventType] ?? false;

        return (
          <div key={eventType} data-testid={`push-event-toggle-${eventType}`}>
            {/* skill 二之七:開關做成一整列(左邊標題 + 一行說明,右邊開關)。
                🔴 skill 二之三:「不能按」的開關一定要在旁邊寫明原因,灰掉但不說為什麼,
                   使用者只會以為系統壞了 —— 所以 merchantEnabled = false 時掛一條常駐 `!`。 */}
            <SwitchRow
              id={`push-event-switch-${eventType}`}
              title={PUSH_NOTIFICATION_EVENT_LABELS[eventType]}
              description={eventDescriptionForTarget(eventType, targetType)}
              checked={personalEnabled}
              disabled={!merchantEnabled}
              onCheckedChange={(next) => void handleToggle(eventType, next)}
            >
              {merchantEnabled ? null : (
                <AlertNote>
                  商家尚未開啟這個事件的推播通知
                  {isMerchantAdmin ? (
                    <>
                      {" "}
                      <Link to="/app/push-events" className="font-semibold underline">
                        前往推播通知設定
                      </Link>
                    </>
                  ) : null}
                </AlertNote>
              )}
            </SwitchRow>
          </div>
        );
      })}
    </div>
  );
}
