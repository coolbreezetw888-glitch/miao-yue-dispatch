// 模組 15(服務人員推播通知)§7.2:usePushSubscription(staffId) hook。
// 負責:檢查目前瀏覽器的 Notification.permission 現況、判斷這台裝置是不是已經訂閱、開啟/
// 取消訂閱的實際瀏覽器 API 呼叫 + 寫入/刪除資料庫。
//
// 第六節規則 3:iOS Safari 非獨立視窗模式時,呼叫端(PushSubscriptionCard.tsx)依
// `isIosBlocked` 決定要不要整個換成引導文字,不在這個 hook 裡面擋掉 subscribe()——這裡只負責
// 回報狀態,UI 層決定要不要顯示按鈕。
//
// 2026-09-24 深夜巡檢修正(死按鈕 + 假成功訊息):
// 1. subscribe() 原本第一行是
//    `if (!isSupported || !merchantId || !staffId || !VAPID_PUBLIC_KEY) return;`——四種完全不同的
//    失敗原因全部靜默返回,按鈕連「開啟中⋯」都不會閃一下,使用者得不到任何線索。最容易踩到的是
//    VAPID 公鑰缺失:VITE_VAPID_PUBLIC_KEY 是 build-time 變數,本機 .env 有、但部署環境(Vercel)
//    漏設就是 undefined,整顆「開啟訂單通知」按鈕變成完全沒反應的死按鈕。現在四個條件各自丟出
//    一句看得懂的中文錯誤,交給呼叫端的 catch 顯示出來。
// 2. subscribe() 改成回傳 boolean(true = 真的訂閱成功並寫進資料庫),讓呼叫端可以依「實際結果」
//    決定要不要報喜,而不是像原本那樣去看 Notification.permission——那個值只代表「這個瀏覽器曾經
//    被允許過通知」,跟「這次有沒有真的訂閱成功」無關,導致曾經允許過通知的服務人員即使完全沒訂閱
//    成功也會看到綠色的「已開啟訂單通知」。
// 3. VAPID 公鑰改成在 subscribe() 裡面才讀(原本是 module 層級的 const)。module 層級的值在
//    模組載入當下就定案,測試無法用 vi.stubEnv 模擬「部署環境沒設這個變數」的情境;改成呼叫時才讀
//    對正式執行環境沒有任何行為差異(build 時就被 Vite 靜態替換成同一個字面值)。

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { detectIosSafari, isRunningStandalone } from "@/components/InstallPwaHint";

import {
  deleteStaffPushSubscriptionByEndpoint,
  deleteStaffPushSubscriptionById,
  insertStaffPushSubscription,
  useStaffPushSubscriptions,
} from "./api";
import { findMatchingSubscription, urlBase64ToUint8Array } from "./pushSubscriptionHelpers";
import type { StaffPushSubscription } from "./types";

/** 讀取 VAPID 公鑰。刻意做成函式(不是 module 層級的 const),理由見檔頭第 3 點。 */
function readVapidPublicKey(): string | undefined {
  return import.meta.env["VITE_VAPID_PUBLIC_KEY"] as string | undefined;
}

/** 訂閱流程四種「還沒開始就不可能成功」的情況,各自對應一句使用者看得懂的中文說明。
 * 集中放在這裡,測試可以直接比對字串,不用把文案抄兩份。 */
export const PUSH_SUBSCRIBE_BLOCKED_MESSAGES = {
  unsupported:
    "這個瀏覽器不支援推播通知,請改用 Chrome、Edge,或 iOS 16.4 以上的 Safari(需先加入主畫面)",
  noMerchant: "目前沒有選定商家,請重新整理頁面後再試一次",
  noStaff: "找不到你的服務人員資料,請聯絡商家管理員確認你的帳號設定",
  missingVapidKey: "推播功能尚未完成設定,請聯絡系統管理員",
} as const;

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export interface UsePushSubscriptionResult {
  /** 瀏覽器是否支援 Web Push(Notification API + Service Worker + PushManager 都要有)。 */
  isSupported: boolean;
  permission: BrowserNotificationPermission;
  /** 第六節規則 3:iOS Safari 但尚未以獨立視窗模式開啟——不顯示「開啟通知」按鈕,改顯示引導文字。 */
  isIosBlocked: boolean;
  /** 這台裝置目前是否已經在資料庫的訂閱清單裡。 */
  isThisDeviceSubscribed: boolean;
  subscriptions: StaffPushSubscription[];
  isLoadingSubscriptions: boolean;
  isSubscribing: boolean;
  isUnsubscribing: boolean;
  /**
   * 開啟這台裝置的推播訂閱。
   * - 回傳 true:真的訂閱成功並寫進資料庫(呼叫端可以安心報喜)。
   * - 回傳 false:使用者在瀏覽器的權限視窗按了「封鎖」或直接關掉(不是錯誤,但也沒開通)。
   * - 丟出 Error:環境根本沒辦法訂閱(不支援/沒商家/沒服務人員身份/沒設 VAPID 公鑰),或是
   *   瀏覽器、資料庫在過程中出錯。訊息都是中文,呼叫端直接顯示給使用者看即可。
   */
  subscribe: () => Promise<boolean>;
  /** 「關閉此裝置通知」:取消目前這台裝置的訂閱(瀏覽器端 unsubscribe + 資料庫刪除)。 */
  unsubscribeThisDevice: () => Promise<void>;
  /** 「移除這台裝置」:管理清單裡任一筆(可能不是目前這台裝置),只刪資料庫那一筆。 */
  removeDevice: (subscription: StaffPushSubscription) => Promise<void>;
}

function detectSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export function usePushSubscription(
  merchantId: string | null | undefined,
  staffId: string | null | undefined,
): UsePushSubscriptionResult {
  const queryClient = useQueryClient();
  const isSupported = detectSupport();

  const [permission, setPermission] = useState<BrowserNotificationPermission>(
    isSupported ? Notification.permission : "unsupported",
  );
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isUnsubscribing, setIsUnsubscribing] = useState(false);

  const isIosBlocked =
    typeof navigator !== "undefined" &&
    detectIosSafari(navigator.userAgent) &&
    !isRunningStandalone();

  const { data: subscriptions, isLoading: isLoadingSubscriptions } =
    useStaffPushSubscriptions(staffId);

  useEffect(() => {
    if (!isSupported) return;
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setCurrentEndpoint(sub?.endpoint ?? null);
      })
      .catch(() => {
        if (!cancelled) setCurrentEndpoint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isSupported]);

  function invalidate() {
    return queryClient.invalidateQueries({
      queryKey: ["push-notifications-module", "staff-subscriptions", staffId],
    });
  }

  const subscribe = useCallback(async (): Promise<boolean> => {
    // 四種「還沒開始就不可能成功」的情況各自丟出具體訊息,不要靜默 return(見檔頭第 1 點)。
    // 刻意在 setIsSubscribing(true) 之前就擋掉,按鈕不會先閃一下「開啟中⋯」再彈錯誤。
    if (!isSupported) throw new Error(PUSH_SUBSCRIBE_BLOCKED_MESSAGES.unsupported);
    if (!merchantId) throw new Error(PUSH_SUBSCRIBE_BLOCKED_MESSAGES.noMerchant);
    if (!staffId) throw new Error(PUSH_SUBSCRIBE_BLOCKED_MESSAGES.noStaff);
    const vapidPublicKey = readVapidPublicKey();
    if (!vapidPublicKey) throw new Error(PUSH_SUBSCRIBE_BLOCKED_MESSAGES.missingVapidKey);

    setIsSubscribing(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      // 使用者按了「封鎖」或直接關掉權限視窗——不是系統出錯,所以不丟例外,但也絕對不能算成功。
      if (result !== "granted") return false;

      const registration = await navigator.serviceWorker.ready;
      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
      });

      const json = pushSubscription.toJSON();
      const p256dh = json.keys?.["p256dh"];
      const auth = json.keys?.["auth"];
      if (!p256dh || !auth) {
        throw new Error("瀏覽器沒有回傳完整的訂閱金鑰,請稍後再試一次");
      }

      await insertStaffPushSubscription({
        merchantId,
        staffId,
        endpoint: pushSubscription.endpoint,
        p256dhKey: p256dh,
        authKey: auth,
        userAgent: navigator.userAgent,
      });

      setCurrentEndpoint(pushSubscription.endpoint);
      await invalidate();
      return true;
    } finally {
      setIsSubscribing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, merchantId, staffId]);

  const unsubscribeThisDevice = useCallback(async () => {
    if (!isSupported) return;
    setIsUnsubscribing(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const pushSubscription = await registration.pushManager.getSubscription();
      if (pushSubscription) {
        await pushSubscription.unsubscribe();
        await deleteStaffPushSubscriptionByEndpoint(pushSubscription.endpoint);
      }
      setCurrentEndpoint(null);
      await invalidate();
    } finally {
      setIsUnsubscribing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  const removeDevice = useCallback(
    async (subscription: StaffPushSubscription) => {
      await deleteStaffPushSubscriptionById(subscription.id);
      if (subscription.endpoint === currentEndpoint) setCurrentEndpoint(null);
      await invalidate();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentEndpoint],
  );

  const isThisDeviceSubscribed = Boolean(
    findMatchingSubscription(subscriptions ?? [], currentEndpoint),
  );

  return {
    isSupported,
    permission,
    isIosBlocked,
    isThisDeviceSubscribed,
    subscriptions: subscriptions ?? [],
    isLoadingSubscriptions,
    isSubscribing,
    isUnsubscribing,
    subscribe,
    unsubscribeThisDevice,
    removeDevice,
  };
}
