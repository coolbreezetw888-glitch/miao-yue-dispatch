// 2026-09-24 深夜巡檢新增:PushSubscriptionCard 的「開啟訂單通知」按鈕成功/失敗提示測試。
//
// 這支測試守的是一個實際踩過的坑:原本的 handleSubscribe 是用
// `if (Notification.permission === "granted") toast.success("已開啟訂單通知")` 判斷要不要報喜,
// 但那個值只代表「這個瀏覽器曾經被允許過通知」,跟「這次有沒有真的訂閱成功」無關。所以只要
// 服務人員以前允許過通知,即使這次 subscribe() 根本沒成功(例如部署環境漏設 VAPID 公鑰),
// 照樣會跳出綠色的「已開啟訂單通知」,而卡片仍顯示「開啟訂單通知」按鈕跟「目前沒有任何裝置
// 開通推播通知」——使用者以為開好了,之後一則通知都收不到。
//
// 這裡把 usePushSubscription 整個 mock 掉(它自己的行為由 usePushSubscription.test.tsx 負責),
// 只驗證「卡片依 subscribe() 的實際回傳值/例外決定顯示什麼提示」。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const subscribeMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("./usePushSubscription", () => ({
  usePushSubscription: () => ({
    isSupported: true,
    permission: "default",
    isIosBlocked: false,
    isThisDeviceSubscribed: false,
    subscriptions: [],
    isLoadingSubscriptions: false,
    isSubscribing: false,
    isUnsubscribing: false,
    subscribe: subscribeMock,
    unsubscribeThisDevice: vi.fn(),
    removeDevice: vi.fn(),
  }),
}));

import { PushSubscriptionCard } from "./PushSubscriptionCard";

function renderCard() {
  render(<PushSubscriptionCard merchantId="merchant-1" staffId="staff-1" />);
}

async function clickSubscribeButton() {
  await userEvent.click(screen.getByRole("button", { name: "開啟訂單通知" }));
}

describe("PushSubscriptionCard 的「開啟訂單通知」", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    subscribeMock.mockReset();
    // 關鍵前提:這台裝置「以前」已經允許過通知權限——舊寫法正是看這個值決定要不要報喜。
    // @ts-expect-error 測試環境手動塞入瀏覽器全域物件
    global.Notification = { permission: "granted", requestPermission: vi.fn() };
  });

  afterEach(() => {
    // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效,
    // 必須自己卸載上一個測試渲染的元件,否則下一個測試會找到兩顆「開啟訂單通知」按鈕。
    cleanup();
    // @ts-expect-error 清除測試塞入的全域物件
    delete global.Notification;
  });

  it("subscribe() 回傳 true(真的訂閱成功)時,顯示「已開啟訂單通知」", async () => {
    subscribeMock.mockResolvedValue(true);
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("已開啟訂單通知"));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("subscribe() 回傳 false 時,即使瀏覽器 Notification.permission 是 granted 也不能誤報成功", async () => {
    subscribeMock.mockResolvedValue(false);
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    // 這一行就是這次修正的核心:舊寫法在這個情境會跳出假的成功訊息。
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe("尚未開啟訂單通知");
  });

  it("subscribe() 丟出錯誤(例如缺 VAPID 金鑰)時,把那句中文原因顯示出來,不是靜默沒反應", async () => {
    subscribeMock.mockRejectedValue(new Error("推播功能尚未完成設定,請聯絡系統管理員"));
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("開啟通知失敗", {
      description: "推播功能尚未完成設定,請聯絡系統管理員",
    });
  });
});
