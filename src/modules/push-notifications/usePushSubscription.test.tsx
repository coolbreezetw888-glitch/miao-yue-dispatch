// 模組 15(服務人員推播通知)§7.2:usePushSubscription 訂閱/取消訂閱流程測試。
// mock Notification/navigator.serviceWorker/PushManager,驗證呼叫參數正確(對應規格書 §7.2
// 測試要求)。完全比照 src/modules/staff-agent/context.test.tsx 用 Probe 元件觀察 hook 回傳值
// 的既有做法。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useStaffPushSubscriptionsMock = vi.fn();
const insertStaffPushSubscriptionMock = vi.fn();
const deleteStaffPushSubscriptionByEndpointMock = vi.fn();
const deleteStaffPushSubscriptionByIdMock = vi.fn();
const detectIosSafariMock = vi.fn();
const isRunningStandaloneMock = vi.fn();

vi.mock("./api", () => ({
  useStaffPushSubscriptions: (...args: unknown[]) => useStaffPushSubscriptionsMock(...args),
  insertStaffPushSubscription: (...args: unknown[]) => insertStaffPushSubscriptionMock(...args),
  deleteStaffPushSubscriptionByEndpoint: (...args: unknown[]) =>
    deleteStaffPushSubscriptionByEndpointMock(...args),
  deleteStaffPushSubscriptionById: (...args: unknown[]) => deleteStaffPushSubscriptionByIdMock(...args),
}));

vi.mock("@/components/InstallPwaHint", () => ({
  detectIosSafari: (...args: unknown[]) => detectIosSafariMock(...args),
  isRunningStandalone: (...args: unknown[]) => isRunningStandaloneMock(...args),
}));

import { usePushSubscription, type UsePushSubscriptionResult } from "./usePushSubscription";

function Probe({
  merchantId,
  staffId,
  onResult,
}: {
  merchantId: string;
  staffId: string;
  onResult: (result: UsePushSubscriptionResult) => void;
}) {
  const result = usePushSubscription(merchantId, staffId);
  onResult(result);
  return null;
}

function renderProbe(merchantId = "merchant-1", staffId = "staff-1") {
  const queryClient = new QueryClient();
  let captured: UsePushSubscriptionResult | undefined;
  render(
    <QueryClientProvider client={queryClient}>
      <Probe merchantId={merchantId} staffId={staffId} onResult={(r) => (captured = r)} />
    </QueryClientProvider>,
  );
  return () => captured as UsePushSubscriptionResult;
}

describe("usePushSubscription", () => {
  let requestPermissionMock: ReturnType<typeof vi.fn>;
  let subscribeMock: ReturnType<typeof vi.fn>;
  let getSubscriptionMock: ReturnType<typeof vi.fn>;
  let unsubscribeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useStaffPushSubscriptionsMock.mockReset().mockReturnValue({ data: [], isLoading: false });
    insertStaffPushSubscriptionMock.mockReset();
    deleteStaffPushSubscriptionByEndpointMock.mockReset();
    deleteStaffPushSubscriptionByIdMock.mockReset();
    detectIosSafariMock.mockReset().mockReturnValue(false);
    isRunningStandaloneMock.mockReset().mockReturnValue(false);

    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "BFg_if7Gen_q313Y3lRXBIdntbLU80t1njSXCDe6DQK85bk3fmjEyq9qN2sTvl3mdtAJTiv6NKTvGzuVRAMrEVY");

    requestPermissionMock = vi.fn().mockResolvedValue("granted");
    getSubscriptionMock = vi.fn().mockResolvedValue(null);
    unsubscribeMock = vi.fn().mockResolvedValue(true);
    subscribeMock = vi.fn().mockResolvedValue({
      endpoint: "https://fcm.example/new-endpoint",
      toJSON: () => ({ keys: { p256dh: "p256dh-value", auth: "auth-value" } }),
    });

    // @ts-expect-error 測試環境手動塞入瀏覽器全域物件
    global.Notification = { permission: "default", requestPermission: requestPermissionMock };
    // @ts-expect-error 同上
    global.PushManager = function PushManager() {};

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            subscribe: subscribeMock,
            getSubscription: getSubscriptionMock,
          },
        }),
      },
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "test-agent",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error 清除測試塞入的全域物件
    delete global.Notification;
    // @ts-expect-error 同上
    delete global.PushManager;
  });

  it("isSupported 在 Notification/serviceWorker/PushManager 都存在時為 true", async () => {
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));
    expect(getResult().isSupported).toBe(true);
  });

  it("subscribe():使用者同意後,呼叫 pushManager.subscribe 並把結果 insert 進資料庫,參數正確", async () => {
    insertStaffPushSubscriptionMock.mockResolvedValue({ id: "sub-1" });
    const getResult = renderProbe("merchant-1", "staff-1");
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));

    await act(async () => {
      await getResult().subscribe();
    });

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(insertStaffPushSubscriptionMock).toHaveBeenCalledWith({
      merchantId: "merchant-1",
      staffId: "staff-1",
      endpoint: "https://fcm.example/new-endpoint",
      p256dhKey: "p256dh-value",
      authKey: "auth-value",
      userAgent: "test-agent",
    });
  });

  it("subscribe():使用者拒絕權限時,不呼叫 pushManager.subscribe、不寫入資料庫", async () => {
    requestPermissionMock.mockResolvedValue("denied");
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));

    await act(async () => {
      await getResult().subscribe();
    });

    expect(subscribeMock).not.toHaveBeenCalled();
    expect(insertStaffPushSubscriptionMock).not.toHaveBeenCalled();
  });

  it("unsubscribeThisDevice():有現有訂閱時,呼叫瀏覽器端 unsubscribe() + 依 endpoint 刪除資料庫那一筆", async () => {
    getSubscriptionMock.mockResolvedValue({
      endpoint: "https://fcm.example/existing-endpoint",
      unsubscribe: unsubscribeMock,
    });
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));

    await act(async () => {
      await getResult().unsubscribeThisDevice();
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(deleteStaffPushSubscriptionByEndpointMock).toHaveBeenCalledWith(
      "https://fcm.example/existing-endpoint",
    );
  });

  it("unsubscribeThisDevice():目前這台裝置沒有訂閱時,不呼叫刪除", async () => {
    getSubscriptionMock.mockResolvedValue(null);
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));

    await act(async () => {
      await getResult().unsubscribeThisDevice();
    });

    expect(deleteStaffPushSubscriptionByEndpointMock).not.toHaveBeenCalled();
  });

  it("removeDevice():依 id 刪除清單裡任一筆", async () => {
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));

    await act(async () => {
      // removeDevice 內部只用得到 id/endpoint 兩個欄位,測試只填這兩個就夠,其餘欄位補假值
      // 滿足型別(StaffPushSubscription 是完整資料表列型別)。
      await getResult().removeDevice({
        id: "sub-2",
        endpoint: "https://fcm.example/other",
        merchant_id: "merchant-1",
        staff_id: "staff-1",
        p256dh_key: "p",
        auth_key: "a",
        user_agent: null,
        created_at: "2026-01-01T00:00:00Z",
        last_seen_at: null,
      });
    });

    expect(deleteStaffPushSubscriptionByIdMock).toHaveBeenCalledWith("sub-2");
  });

  it("isIosBlocked:iOS Safari 且非獨立視窗模式時為 true(第六節規則 3)", async () => {
    detectIosSafariMock.mockReturnValue(true);
    isRunningStandaloneMock.mockReturnValue(false);
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));
    expect(getResult().isIosBlocked).toBe(true);
  });

  it("isIosBlocked:iOS Safari 但已經是獨立視窗模式時為 false", async () => {
    detectIosSafariMock.mockReturnValue(true);
    isRunningStandaloneMock.mockReturnValue(true);
    const getResult = renderProbe();
    await waitFor(() => expect(getResult().isLoadingSubscriptions).toBe(false));
    expect(getResult().isIosBlocked).toBe(false);
  });
});
