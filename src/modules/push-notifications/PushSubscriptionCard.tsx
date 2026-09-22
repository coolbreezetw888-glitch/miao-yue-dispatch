// 模組 15(服務人員推播通知)§7.2:服務人員開啟/關閉推播通知的個人設定卡片。
// 掛載位置:HomePage.tsx role==='staff' 分支的個人資料卡片下方(比照模組 11 MyLineBindingCard
// 的既有做法,掛在服務人員本來就會經過的個人設定區域,不強制新增一個獨立路由)。

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { usePushSubscription } from "./usePushSubscription";
import { simplifyUserAgent, type StaffPushSubscription } from "./types";

export function PushSubscriptionCard({
  merchantId,
  staffId,
}: {
  merchantId: string | null | undefined;
  staffId: string | null | undefined;
}) {
  const {
    isSupported,
    permission,
    isIosBlocked,
    isThisDeviceSubscribed,
    subscriptions,
    isLoadingSubscriptions,
    isSubscribing,
    isUnsubscribing,
    subscribe,
    unsubscribeThisDevice,
    removeDevice,
  } = usePushSubscription(merchantId, staffId);

  if (!merchantId || !staffId) return null;

  async function handleSubscribe() {
    try {
      await subscribe();
      if (Notification.permission === "granted") {
        toast.success("已開啟訂單通知");
      }
    } catch (err) {
      toast.error("開啟通知失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleUnsubscribeThisDevice() {
    try {
      await unsubscribeThisDevice();
      toast.success("已關閉這台裝置的通知");
    } catch (err) {
      toast.error("關閉通知失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleRemoveDevice(subscription: StaffPushSubscription) {
    try {
      await removeDevice(subscription);
      toast.success("已移除這台裝置");
    } catch (err) {
      toast.error("移除裝置失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>訂單通知</CardTitle>
        <CardDescription>
          開啟後,即使沒有打開秒約網頁,新訂單/取消/異動、明天有預約時,這台裝置也會跳出通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!isSupported ? (
          <p className="text-xs text-muted-foreground">
            這個瀏覽器不支援推播通知,請改用 Chrome、Edge 或 Safari(16.4 以上,且已加入主畫面)。
          </p>
        ) : isIosBlocked ? (
          <p className="text-xs text-muted-foreground">
            請先依照畫面下方提示把秒約加入主畫面,才能開啟訂單通知(iPhone 的系統限制:Safari
            分頁狀態下,即使按了「允許通知」也無法真的收到推播)。
          </p>
        ) : permission === "denied" ? (
          <p className="text-xs text-muted-foreground">
            通知權限已被封鎖,請到瀏覽器/系統設定裡手動開啟這個網站的通知權限後再回來。
          </p>
        ) : isThisDeviceSubscribed ? (
          <div className="flex items-center justify-between">
            <Badge variant="default">這台裝置已開啟通知</Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isUnsubscribing}
              onClick={handleUnsubscribeThisDevice}
            >
              {isUnsubscribing ? "處理中⋯" : "關閉此裝置通知"}
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" disabled={isSubscribing} onClick={handleSubscribe}>
            {isSubscribing ? "開啟中⋯" : "開啟訂單通知"}
          </Button>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground">已開通裝置</p>
          {isLoadingSubscriptions ? (
            <p className="text-xs text-muted-foreground">載入中⋯</p>
          ) : subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">目前沒有任何裝置開通推播通知。</p>
          ) : (
            <ul className="space-y-2">
              {subscriptions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {simplifyUserAgent(s.user_agent)} ‧{" "}
                    {new Date(s.created_at).toLocaleDateString("zh-TW")}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-xs text-destructive hover:text-destructive"
                    onClick={() => handleRemoveDevice(s)}
                  >
                    移除這台裝置
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          提醒:iPhone 需要 iOS 16.4 以上版本且已加入主畫面才能使用推播通知,體驗會跟 Android
          有落差,這是蘋果的系統限制,不是這個功能做得不完整。
        </p>
      </CardContent>
    </Card>
  );
}
