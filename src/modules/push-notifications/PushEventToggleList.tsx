// 模組 15 擴充 §7.4:四個事件開關的 UI(使用者裁決的方案 C 真正落地的畫面)。
//
// 重點三件事:
//   1. §4.2 兩層開關:商家總開關關閉的那一項要**灰掉 + 寫明原因**,不然使用者會一直卡在
//      「我明明開了為什麼收不到」。管理員本人額外看到一個連到 /app/push-events 的連結
//      (客服/服務人員不顯示,因為他們可能沒有權限進那一頁)。
//   2. §4.5 / 裁決 Q2:target_type 是 admin/agent 時,不顯示「前一天提醒隔天預約」這一項。
//   3. §4.4 第 3 點:管理員/客服的小字要誠實寫出量有多大(「這間店**每一筆**新訂單都會通知你」)。

import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Switch } from "@/components/ui/switch";
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
    return <p className="text-xs text-muted-foreground">載入中⋯</p>;
  }

  return (
    <div className="space-y-3" data-testid="push-event-toggle-list">
      {eventTypes.map((eventType) => {
        const row = (subscriptions ?? []).find((s) => s.event_type === eventType);
        const personalEnabled = row?.enabled ?? false;
        // §2.6:總開關狀態查不到時(例如函式暫時失敗)一律當成「還沒開」,寧可多解釋也不要
        // 讓使用者以為打開了卻收不到。
        const merchantEnabled = merchantEnabledMap?.[eventType] ?? false;

        return (
          <div
            key={eventType}
            data-testid={`push-event-toggle-${eventType}`}
            className={`flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2 ${
              merchantEnabled ? "" : "opacity-60"
            }`}
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {PUSH_NOTIFICATION_EVENT_LABELS[eventType]}
              </p>
              <p className="text-xs text-muted-foreground">
                {eventDescriptionForTarget(eventType, targetType)}
              </p>
              {merchantEnabled ? null : (
                <p className="text-xs text-muted-foreground">
                  商家尚未開啟這個事件的推播通知
                  {isMerchantAdmin ? (
                    <>
                      {" "}
                      <Link to="/app/push-events" className="text-brand hover:underline">
                        前往推播通知設定
                      </Link>
                    </>
                  ) : null}
                </p>
              )}
            </div>
            <Switch
              checked={personalEnabled}
              disabled={!merchantEnabled}
              aria-label={PUSH_NOTIFICATION_EVENT_LABELS[eventType]}
              onCheckedChange={(next) => void handleToggle(eventType, next)}
            />
          </div>
        );
      })}
    </div>
  );
}
