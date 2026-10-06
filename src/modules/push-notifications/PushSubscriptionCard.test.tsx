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
//
// ⚠️ 2026-09-30 SPECS-INDEX #868:新增第三個 describe「要收哪幾種通知」收合行為。
//    那一組守的是「預設收合」——原本這件事只有 e2e 擋,而 e2e 在開發機上不執行,
//    所以把 useState(false) 改成 true 不會有任何測試變紅。詳見那個 describe 上方的說明。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PushSubscription } from "./types";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const subscribeMock = vi.fn();
const sendTestPushMock = vi.fn();

/**
 * 「已開通裝置」那組資料。預設是一台都沒有(跟原本寫死 `subscriptions: []` 的行為一樣),
 * 只有 #868 那組收合測試會暫時換成有一台,好驗「事件開關清單只在展開時才 render」。
 * 🔴 每個 describe 的 beforeEach 都要把它設回 [],不要讓測試之間互相污染。
 */
let mockSubscriptions: PushSubscription[] = [];

/** push_subscriptions 的一列(8 個欄位全給,不用 as 硬轉,schema 改了 tsc 會直接抓到)。 */
const FAKE_SUBSCRIPTION: PushSubscription = {
  id: "sub-1",
  user_id: "user-1",
  endpoint: "https://fcm.example/1",
  auth_key: "auth",
  p256dh_key: "p256dh",
  user_agent: "Mozilla/5.0 (iPhone)",
  created_at: "2026-09-30T00:00:00.000Z",
  last_seen_at: null,
};

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
    subscriptions: mockSubscriptions,
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

// 事件開關清單有自己的測試(PushEventToggleList.test.tsx),這裡不重複渲染它的資料查詢。
// 只放一個看得見的替身,好讓 #868 的收合測試能驗「這份清單到底有沒有被 render 出來」——
// 原本是 `() => null`,那樣查不到它在不在,收合行為就測不出來。
vi.mock("./PushEventToggleList", () => ({
  PushEventToggleList: () => <div data-testid="push-event-toggle-list-stub" />,
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
    mockSubscriptions = [];
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
    subscribeMock.mockRejectedValue(new Error("推播功能尚未完成設定，請聯絡系統管理員"));
    renderCard();
    await clickSubscribeButton();

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("開啟通知失敗", {
      description: "推播功能尚未完成設定，請聯絡系統管理員",
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
    mockSubscriptions = [];
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

// ===========================================================================
// SPECS-INDEX #868:「要收哪幾種通知」可收合、**預設收合**。
//
// 🔴 為什麼這一組非寫不可:這個行為原本唯一的守門員是 e2e(`e2e/push-notifications.spec.ts`
//    的 expandPushEventSection),而 e2e 在開發機上依規則**不執行**(fixture 會寫進正式資料庫)。
//    ⇒ 只要有人把 `useState(false)` 改成 `useState(true)`,tsc / lint / 其他所有單元測試
//    全部照樣綠燈,這個回歸完全抓不到。這一組就是補上那個缺口。
// ===========================================================================
describe("PushSubscriptionCard 的「要收哪幾種通知」收合行為(#868)", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    subscribeMock.mockReset();
    sendTestPushMock.mockReset().mockResolvedValue({ sent: 1, failed: 0, ackTokens: [] });
    mockSubscriptions = [];
    // @ts-expect-error 測試環境手動塞入瀏覽器全域物件
    global.Notification = { permission: "default", requestPermission: vi.fn() };
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error 清除測試塞入的全域物件
    delete global.Notification;
  });

  /** 標題那一行的觸發按鈕(e2e 也是抓同一個 data-testid)。 */
  function getSectionToggle() {
    return screen.getByTestId("push-event-section-toggle");
  }

  it("🔴 預設收合:掛載後標題按鈕看得到、aria-expanded=false,但區塊內容一律查不到", () => {
    mockSubscriptions = [FAKE_SUBSCRIPTION];
    renderCard();

    // 標題那一行看得到,而且是真正的按鈕(不是掛 onClick 的 <p>,那種鍵盤按不到)。
    const toggle = getSectionToggle();
    expect(toggle).toBeInTheDocument();
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("要收哪幾種通知")).toBeInTheDocument();
    // 收合狀態要看得出來,而且不只靠箭頭方向 —— 按鈕上直接寫著「展開」。
    expect(screen.getByText("展開")).toBeInTheDocument();

    // 🔴 這一行就是這支測試的核心:內容不能在畫面上。
    expect(screen.queryByTestId("push-event-toggle-list-stub")).not.toBeInTheDocument();
  });

  it("🔴 預設收合:一台裝置都還沒開通時,連那句「先開啟通知,才能選擇要收哪幾種。」也查不到", () => {
    renderCard();

    expect(getSectionToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先開啟通知，才能選擇要收哪幾種。")).not.toBeInTheDocument();
  });

  it("點一下標題就展開:aria-expanded 變 true,事件開關清單出現", async () => {
    mockSubscriptions = [FAKE_SUBSCRIPTION];
    renderCard();

    await userEvent.click(getSectionToggle());

    expect(getSectionToggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("push-event-toggle-list-stub")).toBeInTheDocument();
    // 文字跟著換成「收合」(狀態看得出來)。
    expect(screen.getByText("收合")).toBeInTheDocument();
    expect(screen.queryByText("展開")).not.toBeInTheDocument();
  });

  it("展開後一台裝置都沒有時,顯示那句說明(不是空白一片)", async () => {
    renderCard();

    await userEvent.click(getSectionToggle());

    expect(screen.getByText("先開啟通知，才能選擇要收哪幾種。")).toBeInTheDocument();
    expect(screen.queryByTestId("push-event-toggle-list-stub")).not.toBeInTheDocument();
  });

  it("再點一下會收回去(確認是真的 toggle,不是只能單向展開)", async () => {
    mockSubscriptions = [FAKE_SUBSCRIPTION];
    renderCard();

    await userEvent.click(getSectionToggle());
    expect(screen.getByTestId("push-event-toggle-list-stub")).toBeInTheDocument();

    await userEvent.click(getSectionToggle());
    expect(getSectionToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("push-event-toggle-list-stub")).not.toBeInTheDocument();
    expect(screen.getByText("展開")).toBeInTheDocument();
  });

  it("aria-controls 指到真的存在的元素,而且 id 不是寫死的(同一頁兩張卡不會撞 id)", () => {
    // 一個人同時是客服又是服務人員時,同一頁會出現兩張卡片。
    render(
      <>
        <PushSubscriptionCard
          merchantId="merchant-1"
          targetType="agent"
          targetId="target-1"
          targetLabel="客服"
          merchantName="涼風工匠"
        />
        <PushSubscriptionCard
          merchantId="merchant-1"
          targetType="staff"
          targetId="target-1"
          targetLabel="服務人員"
          merchantName="涼風工匠"
        />
      </>,
    );

    const toggles = screen.getAllByTestId("push-event-section-toggle");
    expect(toggles).toHaveLength(2);

    const ids = toggles.map((t) => t.getAttribute("aria-controls"));
    // 兩張卡各自拿到不同的 id(寫死字串的話這一行會失敗)。
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    // 而且各自都真的指得到一個存在的元素(收合時那層殼仍然在 DOM 裡)。
    for (const id of ids) {
      expect(document.getElementById(id as string)).not.toBeNull();
    }
  });

  it("裁決 C:訂閱成功的那一刻自動展開一次(剛按完「開啟通知」的人下一步就是想選要收哪幾種)", async () => {
    subscribeMock.mockResolvedValue({ subscribed: true, endpoint: "https://fcm.example/1" });
    renderCard();

    expect(getSectionToggle()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));

    await waitFor(() => expect(getSectionToggle()).toHaveAttribute("aria-expanded", "true"));
  });

  it("裁決 C:訂閱**失敗**時不可以自動展開(只有成功那一條路徑才展開)", async () => {
    subscribeMock.mockResolvedValue({ subscribed: false, endpoint: null });
    renderCard();

    await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(getSectionToggle()).toHaveAttribute("aria-expanded", "false");
  });
});
