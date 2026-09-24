// 模組 15(手機推播通知)§7.1:三種角色通用的「手機推播通知」個人設定卡片。
// 掛載位置:服務人員端 HomePage.tsx「個人資料」分頁籤(§7.3)、管理員/客服 ManagePage.tsx
// 頁面最下方(§7.2,緊接在「我的 LINE 綁定」後面,兩個頁面的順序刻意一致)。
//
// 2026-09-25「手機推播擴及三種角色」批次:props 從 {merchantId, staffId} 改成
// {merchantId, targetType, targetId, targetLabel}。targetLabel 會顯示在卡片標題上
// (「手機推播通知(以客服身份)」),因為一個人可能同時是客服又是服務人員,兩個頁面會各看到
// 一張卡片,必須一眼看出差別。
//
// ⚠️ 2026-09-24 深夜巡檢修正(死按鈕 + 假成功訊息)的成果**一個字都沒有退回**:
//    一律依 subscribe() 的實際回傳值判斷要不要報喜,不看 Notification.permission。

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { PushEventToggleList } from "./PushEventToggleList";
import { hasAnyAckedTestPush, PushTestRateLimitedError, sendTestPush } from "./api";
import {
  PUSH_TEST_ACK_TIMEOUT_MS,
  PUSH_TEST_TROUBLESHOOTING,
  describePushTestState,
  readPushTestAckTokenFromSearch,
  type PushTestState,
} from "./pushTestStatus";
import { usePushSubscription } from "./usePushSubscription";
import { simplifyUserAgent, type PushSubscription, type PushTargetType } from "./types";

export function PushSubscriptionCard({
  merchantId,
  targetType,
  targetId,
  targetLabel,
  merchantName,
}: {
  merchantId: string | null | undefined;
  targetType: PushTargetType | null | undefined;
  targetId: string | null | undefined;
  /** 顯示用的角色名稱(「服務人員」/「客服」/「商家管理員」)。 */
  targetLabel: string;
  /** §4.8 第 3 點:「這裡的設定只影響『<商家名稱>』這間店」。 */
  merchantName?: string | null;
}) {
  const {
    isSupported,
    permission,
    isIosBlocked,
    isThisDeviceSubscribed,
    currentEndpoint,
    subscriptions,
    isLoadingSubscriptions,
    isSubscribing,
    isUnsubscribing,
    subscribe,
    unsubscribeThisDevice,
    removeDevice,
  } = usePushSubscription(merchantId, targetType, targetId);

  const [testState, setTestState] = useState<PushTestState>("idle");
  const [isTesting, setIsTesting] = useState(false);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  function clearTimers() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    timerRef.current = null;
    pollRef.current = null;
  }

  useEffect(() => clearTimers, []);

  // §6.3 第 3 點:service worker 收到測試推播會對所有分頁 postMessage,畫面立刻反應,不用等輪詢。
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    function onMessage(event: MessageEvent) {
      if (event.data?.type === "push-test-received") {
        clearTimers();
        setTestState("device_acked");
      }
    }
    navigator.serviceWorker.addEventListener?.("message", onMessage as EventListener);
    return () =>
      navigator.serviceWorker.removeEventListener?.("message", onMessage as EventListener);
  }, []);

  // §6.3 備援路徑:使用者真的點了那則測試通知 → push-sw.js 把 token 接在網址上帶回來。
  // 這是最強的證據(證明通知不只抵達裝置,而且真的顯示出來、使用者真的看到並點了它)。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = readPushTestAckTokenFromSearch(window.location.search);
    if (!token) return;
    setTestState("clicked");
    // 把參數清掉,避免重新整理時一直顯示同一句話。
    const url = new URL(window.location.href);
    url.searchParams.delete("push_test_ack");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const runTestPush = useCallback(
    async (endpoint: string | null) => {
      if (!merchantId) return;
      clearTimers();
      setIsTesting(true);
      try {
        const result = await sendTestPush(merchantId, endpoint);
        if (result.reason === "no_subscription" || result.sent + result.failed === 0) {
          setTestState("no_device");
          return;
        }
        if (result.sent === 0) {
          setTestState("error");
          return;
        }
        setTestState("waiting");

        const tokens = result.ackTokens;
        // 輪詢是 postMessage 的備援(例如使用者在另一台裝置上收到、這個分頁沒被通知到)。
        pollRef.current = window.setInterval(() => {
          void hasAnyAckedTestPush(tokens)
            .then((acked) => {
              if (acked) {
                clearTimers();
                setTestState("device_acked");
              }
            })
            .catch(() => {
              /* 輪詢失敗不影響狀態機,等逾時走 no_ack */
            });
        }, 3000);

        timerRef.current = window.setTimeout(() => {
          clearTimers();
          setTestState((prev) => (prev === "waiting" ? "no_ack" : prev));
        }, PUSH_TEST_ACK_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof PushTestRateLimitedError) setTestState("rate_limited");
        else setTestState("error");
      } finally {
        setIsTesting(false);
      }
    },
    [merchantId],
  );

  if (!merchantId || !targetType || !targetId) return null;

  // 2026-09-24 深夜巡檢修正(假成功訊息):一律依 subscribe() 的實際回傳值判斷,
  // 不看 Notification.permission(那個值只代表「這個瀏覽器曾經被允許過通知」)。
  async function handleSubscribe() {
    try {
      const { subscribed, endpoint } = await subscribe();
      if (subscribed) {
        // §7.5 第 4 點:訂閱結果與測試結果是兩件事,兩行字,不要合成一句。
        toast.success("已開啟這台裝置的通知");
        // §7.5 第 1 點:只測「剛剛這一台」,不要把使用者其他裝置也吵醒。
        void runTestPush(endpoint);
        return;
      }
      toast.error("尚未開啟通知", {
        description: "瀏覽器沒有取得通知權限,請在跳出的視窗選擇「允許」後再試一次。",
      });
    } catch (err) {
      toast.error("開啟通知失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleUnsubscribeThisDevice() {
    try {
      await unsubscribeThisDevice();
      setTestState("idle");
      clearTimers();
      toast.success("已關閉這台裝置的通知");
    } catch (err) {
      toast.error("關閉通知失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleRemoveDevice(subscription: PushSubscription) {
    try {
      await removeDevice(subscription);
      toast.success("已移除這台裝置");
    } catch (err) {
      toast.error("移除裝置失敗", { description: getErrorMessage(err) });
    }
  }

  const testMessage = describePushTestState(testState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>手機推播通知(以{targetLabel}身份)</CardTitle>
        <CardDescription>
          開啟後,即使沒有打開秒約網頁,這間店有新訂單/訂單異動時,你的手機也會跳出通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* §4.8 第 3 點:同時服務多間店的人要知道這頁設定的範圍。 */}
        <p className="text-xs text-muted-foreground">
          這裡的設定只影響「{merchantName?.trim() || "目前這間店"}
          」這間店,其他商家要分別設定。
        </p>

        {!isSupported ? (
          <p className="text-xs text-muted-foreground">
            這個瀏覽器不支援推播通知,請改用 Chrome、Edge 或 Safari(16.4 以上,且已加入主畫面)。
          </p>
        ) : isIosBlocked ? (
          // §7.6:iOS 的限制對管理員/客服影響更大(他們常在電腦/iPad 的瀏覽器分頁裡用後台)。
          <p className="text-xs text-muted-foreground">
            {targetType === "staff"
              ? "請先依照畫面下方提示把秒約加入主畫面,才能開啟推播通知(iPhone 的系統限制:Safari 分頁狀態下,即使按了「允許通知」也無法真的收到推播)。"
              : "你用的是 iPhone/iPad 的 Safari。Apple 的限制是:一定要先把秒約加到手機主畫面,才能開啟推播通知。加好之後,請從主畫面的圖示打開秒約,再回到這一頁開啟。"}
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
            {isSubscribing ? "開啟中⋯" : "開啟通知"}
          </Button>
        )}

        {/* §7.5:測試通知區塊。§6.5 的誠實界線由 pushTestStatus.ts 統一管。 */}
        {isThisDeviceSubscribed ? (
          <div className="space-y-2 border-t border-border pt-3" data-testid="push-test-section">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">測試通知</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isTesting}
                onClick={() => void runTestPush(currentEndpoint)}
              >
                {isTesting ? "發送中⋯" : "再發一次測試通知"}
              </Button>
            </div>
            {testMessage ? (
              <p
                data-testid="push-test-status"
                className={`text-xs ${
                  testMessage.tone === "success"
                    ? "text-brand"
                    : testMessage.tone === "warning"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {testMessage.text}
                {testMessage.hint ? <span className="block">{testMessage.hint}</span> : null}
              </p>
            ) : null}
            {testState === "no_ack" ? (
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {PUSH_TEST_TROUBLESHOOTING.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* §7.4:事件開關清單。還沒開通任何裝置時不顯示清單,只給一句說明。 */}
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground">要收哪幾種通知</p>
          {subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">先開啟通知,才能選擇要收哪幾種。</p>
          ) : (
            <PushEventToggleList
              merchantId={merchantId}
              targetType={targetType}
              targetId={targetId}
              isMerchantAdmin={targetType === "admin"}
            />
          )}
        </div>

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
                    {s.last_seen_at ? (
                      <> ‧ 最後收到通知 {new Date(s.last_seen_at).toLocaleDateString("zh-TW")}</>
                    ) : null}
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
