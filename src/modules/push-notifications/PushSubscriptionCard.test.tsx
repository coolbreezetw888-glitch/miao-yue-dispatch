// 2026-09-24 深夜巡檢新增:PushSubscriptionCard 的「開啟通知」按鈕成功/失敗提示測試。
//
// 這支測試守的是一個實際踩過的坑:原本的 handleSubscribe 是用
// `if (Notification.permission === "granted") toast.success(...)` 判斷要不要報喜,
// 但那個值只代表「這個瀏覽器曾經被允許過通知」,跟「這次有沒有真的訂閱成功」無關。所以只要
// 服務人員以前允許過通知,即使這次 subscribe() 根本沒成功(例如部署環境漏設 VAPID 公鑰),
// 照樣會跳出綠色的「已開啟」,而卡片仍顯示「開啟通知」按鈕跟「目前沒有任何裝置
// 開通推播通知」——使用者以為開好了,之後一則通知都收不到。
//
// 這裡把 usePushSubscription 整個 mock 掉(它自己的行為由 usePushSubscription.test.tsx 負責),
// 只驗證「卡片依 subscribe() 的實際回傳值/例外決定顯示什麼提示」。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次:props 改成 targetType/targetId/targetLabel,
//    subscribe() 回傳值從 boolean 改成 { subscribed, endpoint }。驗證意圖一條都沒有變少,
//    另外補上 §7.1(三種角色的標題)與 §7.5 第 4 點(訂閱結果與測試結果分兩行)。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const subscribeMock = vi.fn();
const sendTestPushMock = vi.fn();

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
    currentEndpoint: null,
    subscriptions: [],
    isLoadingSubscriptions: false,
    isSubscribing: false,
    isUnsubscribing: false,
    subscribe: subscribeMock,
    unsubscribeThisDevice: vi.fn(),
    removeDevice: vi.fn(),
  }),
}));

vi.mock("./api", () => ({
  sendTestPush: (...args: unknown[]) => sendTestPushMock(...args),
  hasAnyAckedTestPush: vi.fn().mockResolvedValue(false),
  PushTestRateLimitedError: class PushTestRateLimitedError extends Error {},
}));

// 事件開關清單有自己的測試,這裡不重複渲染它的資料查詢。
vi.mock("./PushEventToggleList", () => ({
  PushEventToggleList: () => null,
}));

import { PushSubscriptionCard } from "./PushSubscriptionCard";

function renderCard(targetType: "staff" | "admin" | "agent" = "staff", targetLabel = "服務人員") {
  render(
    <PushSubscriptionCard
      merchantId="merchant-1"
      targetType={targetType}
      targetId="target-1"
      targetLabel={targetLabel}
      merchantName="涼風工匠"
    />,
  );
}

async function clickSubscribeButton() {
  await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));
}

describe("PushSubscriptionCard 的「開啟通知」", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    subscribeMock.mockReset();
    sendTestPushMock.mockReset().mockResolvedValue({ sent: 1, failed: 0, ackTokens: ["t1"] });
    // 關鍵前提:這台裝置「以前」已經允許過通知權限——舊寫法正是看這個值決定要不要報喜。
    // @ts-expect-error 測試環境手動塞入瀏覽器全域物件
    global.Notification = { permission: "granted", requestPermission: vi.fn() };
  });

  afterEach(() => {
    // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效,
    // 必須自己卸載上一個測試渲染的元件,否則下一個測試會找到兩顆「開啟通知」按鈕。
    cleanup();
    // @ts-expect-error 清除測試塞入的全域物件
    delete global.Notification;
  });

  it("subscribe() 回傳 subscribed=true(真的訂閱成功)時,顯示「已開啟這台裝置的通知」", async () => {
    subscribeMock.mockResolvedValue({ subscribed: true, endpoint: "https://fcm.example/1" });
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("已開啟這台裝置的通知"));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("subscribe() 回傳 subscribed=false 時,即使瀏覽器 Notification.permission 是 granted 也不能誤報成功", async () => {
    subscribeMock.mockResolvedValue({ subscribed: false, endpoint: null });
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    // 這一行就是這次修正的核心:舊寫法在這個情境會跳出假的成功訊息。
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe("尚未開啟通知");
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

  it("§7.5 第 1 點:訂閱成功後立刻對「剛剛這一台」發測試通知(只帶這台的 endpoint)", async () => {
    subscribeMock.mockResolvedValue({ subscribed: true, endpoint: "https://fcm.example/this" });
    renderCard();
    await clickSubscribeButton();

    await waitFor(() =>
      expect(sendTestPushMock).toHaveBeenCalledWith("merchant-1", "https://fcm.example/this"),
    );
  });

  it("§7.5 第 4 點:測試推播失敗時,「已開啟這台裝置的通知」照樣顯示(兩件事分開)", async () => {
    subscribeMock.mockResolvedValue({ subscribed: true, endpoint: "https://fcm.example/this" });
    sendTestPushMock.mockRejectedValue(new Error("boom"));
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("已開啟這台裝置的通知"));
  });
});

describe("PushSubscriptionCard 的角色差異(§7.1/§4.8)", () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    sendTestPushMock.mockReset().mockResolvedValue({ sent: 1, failed: 0, ackTokens: [] });
    // @ts-expect-error 測試環境手動塞入瀏覽器全域物件
    global.Notification = { permission: "default", requestPermission: vi.fn() };
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error 清除測試塞入的全域物件
    delete global.Notification;
  });

  it("標題寫出目前是以哪個身份在設定(雙重身份的人在兩個頁面會看到兩張卡片)", () => {
    renderCard("agent", "客服");
    expect(screen.getByText("手機推播通知(以客服身份)")).toBeInTheDocument();
    cleanup();

    renderCard("staff", "服務人員");
    expect(screen.getByText("手機推播通知(以服務人員身份)")).toBeInTheDocument();
  });

  it("§4.8 第 3 點:寫明這頁的設定只影響目前這間店", () => {
    renderCard("admin", "商家管理員");
    expect(screen.getByText(/這裡的設定只影響「涼風工匠」這間店/)).toBeInTheDocument();
  });
});
