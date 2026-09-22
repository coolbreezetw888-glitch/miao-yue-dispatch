// 模組 15(服務人員推播通知)§7.2:usePushSubscription(staffId) hook。
// 負責:檢查目前瀏覽器的 Notification.permission 現況、判斷這台裝置是不是已經訂閱、開啟/
// 取消訂閱的實際瀏覽器 API 呼叫 + 寫入/刪除資料庫。
//
// 第六節規則 3:iOS Safari 非獨立視窗模式時,呼叫端(PushSubscriptionCard.tsx)依
// `isIosBlocked` 決定要不要整個換成引導文字,不在這個 hook 裡面擋掉 subscribe()——這裡只負責
// 回報狀態,UI 層決定要不要顯示按鈕。

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

const VAPID_PUBLIC_KEY = import.meta.env["VITE_VAPID_PUBLIC_KEY"] as string | undefined;

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
  subscribe: () => Promise<void>;
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

  const { data: subscriptions, isLoading: isLoadingSubscriptions } = useStaffPushSubscriptions(staffId);

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

  const subscribe = useCallback(async () => {
    if (!isSupported || !merchantId || !staffId || !VAPID_PUBLIC_KEY) return;
    setIsSubscribing(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
