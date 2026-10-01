// 模組 7(排班與休假管理)§6.4 修正:UpdateAvailableHint 元件測試。
// 2026-09-20 主腦複查後新增,對應修正 1(PWA 更新機制改成「提示使用者」,不要靜默自動重新整理)。
// 2026-10-01(SPECS-INDEX #966)改版成底部深色浮動卡片,測試一起改寫並補三件事:
//   ・「稍後」之後本次瀏覽不再顯示(含重新掛載、早就在等待中的版本再補發一次);但「又偵測到新版本」要再跳。
//   ・「立即更新」呼叫 applyPendingServiceWorkerUpdate(),元件自己不 reload。
//   ・卡片浮在底部分頁籤列上方、不蓋住分頁籤列(以 class 斷言:bottom 距離、z-index)。
//
// mock src/pwaUpdate.ts,不依賴真正的 Service Worker API(那需要真實瀏覽器,jsdom 測不到,也不是
// 這個元件自己的邏輯——service worker 生命週期本身的行為由 src/pwaUpdate.ts 負責)。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireBottomActionBarSlot,
  BOTTOM_LAYER_ACTION_BAR,
  BOTTOM_LAYER_TAB_BAR,
  BOTTOM_LAYER_UPDATE_CARD,
  BOTTOM_LAYER_UPDATE_CARD_ABOVE_ACTION_BAR,
  resetBottomActionBarsForTest,
  useHasBottomUpdateCard,
} from "@/lib/fixedLayers";

const {
  applyPendingServiceWorkerUpdate,
  onServiceWorkerUpdateAvailable,
  triggerUpdateAvailable,
  setPending,
} = vi.hoisted(() => {
  let listener: ((info: { isNewDetection: boolean }) => void) | null = null;
  // 模擬 pwaUpdate.ts「訂閱當下如果已經有在等待中的新版本,立刻補發一次(isNewDetection: false)」。
  let pending = false;
  return {
    applyPendingServiceWorkerUpdate: vi.fn(),
    onServiceWorkerUpdateAvailable: vi.fn((cb: (info: { isNewDetection: boolean }) => void) => {
      listener = cb;
      if (pending) cb({ isNewDetection: false });
      return () => {
        listener = null;
      };
    }),
    triggerUpdateAvailable: (isNewDetection = true) => {
      pending = true;
      listener?.({ isNewDetection });
    },
    setPending: (value: boolean) => {
      pending = value;
    },
  };
});

vi.mock("@/pwaUpdate", () => ({
  applyPendingServiceWorkerUpdate,
  onServiceWorkerUpdateAvailable,
}));

import UpdateAvailableHint, { UPDATE_CARD_DISMISSED_SESSION_KEY } from "./UpdateAvailableHint";

function bottomOf(className: string): number {
  const match = className.match(/\bbottom-(\d+)\b/);
  if (!match) throw new Error(`class 字串裡找不到 bottom-*:${className}`);
  return Number(match[1]);
}

function zIndexOf(className: string): number {
  const match = className.match(/\bz-(\d+)\b/);
  if (!match) throw new Error(`class 字串裡找不到 z-*:${className}`);
  return Number(match[1]);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPending(false);
  resetBottomActionBarsForTest();
  window.sessionStorage.clear();
});

describe("UpdateAvailableHint", () => {
  it("預設(沒有新版本通知)不渲染任何內容", () => {
    const { container } = render(<UpdateAvailableHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("收到有新版本的通知後,顯示兩行字與「稍後」「立即更新」兩顆按鈕", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    expect(screen.getByText("有新版本可更新")).toBeInTheDocument();
    expect(screen.getByText("點擊立即套用最新版功能")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "稍後" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即更新" })).toBeInTheDocument();
    // 不是彈窗:沒有 dialog、沒有遮罩,使用者可以繼續操作頁面。
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("元件掛載前就已經有待套用的新版本時,一掛載就顯示", () => {
    setPending(true);
    render(<UpdateAvailableHint />);
    expect(screen.getByText("有新版本可更新")).toBeInTheDocument();
  });

  it("點擊「立即更新」呼叫 applyPendingServiceWorkerUpdate,按鈕改成「更新中⋯」並停用,元件自己不 reload", () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
    try {
      render(<UpdateAvailableHint />);
      act(() => triggerUpdateAvailable());
      fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
      expect(applyPendingServiceWorkerUpdate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "更新中⋯" })).toBeDisabled();
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("按「稍後」收起卡片,而且不會呼叫套用更新", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    fireEvent.click(screen.getByRole("button", { name: "稍後" }));
    expect(screen.queryByText("有新版本可更新")).toBeNull();
    expect(applyPendingServiceWorkerUpdate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(UPDATE_CARD_DISMISSED_SESSION_KEY)).toBe("1");
  });

  it("按「稍後」後,本次瀏覽期間不再跳出(重新掛載 / 同一個版本再補發一次都不顯示)", () => {
    const first = render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    fireEvent.click(screen.getByRole("button", { name: "稍後" }));
    first.unmount();

    // 換頁 / 重新掛載:訂閱當下會補發一次(isNewDetection: false)⇒ 不顯示。
    const { container } = render(<UpdateAvailableHint />);
    expect(container).toBeEmptyDOMElement();

    // 頁面重新整理後發現「早就在等待中」的同一個版本(isNewDetection: false)⇒ 仍然不顯示。
    act(() => triggerUpdateAvailable(false));
    expect(container).toBeEmptyDOMElement();
  });

  it("按「稍後」後,如果又偵測到一個新的版本,卡片要再跳出來", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    fireEvent.click(screen.getByRole("button", { name: "稍後" }));
    expect(screen.queryByText("有新版本可更新")).toBeNull();

    act(() => triggerUpdateAvailable(true));
    expect(screen.getByText("有新版本可更新")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(UPDATE_CARD_DISMISSED_SESSION_KEY)).toBeNull();
  });

  it("sessionStorage 不能用(丟例外)時,「稍後」照樣收起卡片,不會整個壞掉", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<UpdateAvailableHint />);
      act(() => triggerUpdateAvailable());
      fireEvent.click(screen.getByRole("button", { name: "稍後" }));
      expect(screen.queryByText("有新版本可更新")).toBeNull();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe("UpdateAvailableHint 的位置:浮在底部分頁籤列上方,不蓋住分頁籤列", () => {
  it("預設貼在分頁籤列上方(bottom 距離 > 分頁籤列),z-index 低於分頁籤列", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    const card = screen.getByTestId("update-available-card");
    expect(card.className).toContain("fixed");
    expect(card.className).toContain(`bottom-${bottomOf(BOTTOM_LAYER_UPDATE_CARD)}`);
    expect(bottomOf(card.className)).toBeGreaterThan(bottomOf(BOTTOM_LAYER_TAB_BAR));
    // 分頁籤列高 64px = Tailwind 16 個單位;卡片底邊至少要在這個高度以上。
    expect(bottomOf(card.className)).toBeGreaterThanOrEqual(16);
    expect(zIndexOf(card.className)).toBeLessThan(zIndexOf(BOTTOM_LAYER_TAB_BAR));
    // 不可以是參考系統那種 bottom-0 直接壓在分頁籤上。
    expect(card.className).not.toMatch(/\bbottom-0\b/);
  });

  it("畫面上有動作列(尚未儲存變更)時,卡片排到動作列上方,z-index 也低於動作列", () => {
    function FakeUnsavedChangesBar() {
      useEffect(() => acquireBottomActionBarSlot(), []);
      return <div className={BOTTOM_LAYER_ACTION_BAR}>尚未儲存變更</div>;
    }
    render(
      <>
        <FakeUnsavedChangesBar />
        <UpdateAvailableHint />
      </>,
    );
    act(() => triggerUpdateAvailable());
    const card = screen.getByTestId("update-available-card");
    expect(bottomOf(card.className)).toBe(bottomOf(BOTTOM_LAYER_UPDATE_CARD_ABOVE_ACTION_BAR));
    expect(bottomOf(card.className)).toBeGreaterThanOrEqual(bottomOf(BOTTOM_LAYER_ACTION_BAR) + 16);
    expect(zIndexOf(card.className)).toBeLessThan(zIndexOf(BOTTOM_LAYER_ACTION_BAR));
  });

  it("沒有底部選單的頁面(placement=no-tab-bar)貼齊畫面底部,留安全區", () => {
    render(<UpdateAvailableHint placement="no-tab-bar" />);
    act(() => triggerUpdateAvailable());
    const card = screen.getByTestId("update-available-card");
    expect(card.className).toMatch(/\bbottom-0\b/);
    expect(card.className).toContain("safe-area-inset-bottom");
  });

  it("卡片顯示時登記「新版本卡片」訊號,收起後撤銷(安裝提示靠這個讓位)", () => {
    let latest = false;
    function Probe() {
      latest = useHasBottomUpdateCard();
      return null;
    }
    render(
      <>
        <Probe />
        <UpdateAvailableHint />
      </>,
    );
    expect(latest).toBe(false);
    act(() => triggerUpdateAvailable());
    expect(latest).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "稍後" }));
    expect(latest).toBe(false);
  });
});
