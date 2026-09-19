// 模組 7(排班與休假管理)§6.4 修正:UpdateAvailableHint 元件測試。
// 2026-09-20 主腦複查後新增,對應修正 1(PWA 更新機制改成「提示使用者」,不要靜默自動重新整理)。
//
// mock src/pwaUpdate.ts,不依賴真正的 Service Worker API(那需要真實瀏覽器,jsdom 測不到,也不是
// 這個元件自己的邏輯——service worker 生命週期本身的行為由 src/pwaUpdate.ts 負責,已經用
// Playwright 對真實建置產物驗證過,見交付報告)。這裡只驗證元件本身的顯示邏輯:
// 1. 沒有收到「有新版本」通知時,不渲染任何東西(不擋畫面)。
// 2. 收到通知後,顯示提示文字跟「重新整理」按鈕。
// 3. 點擊「重新整理」會呼叫 applyPendingServiceWorkerUpdate(),而且**不會**自己呼叫
//    window.location.reload()——真正的 reload 由 pwaUpdate.ts 的 controllerchange 監聽器負責,
//    這裡只驗證這個元件沒有繞過使用者確認直接重新整理。
// 4. 訂閱當下如果已經有一個待套用的新版本(onServiceWorkerUpdateAvailable 立刻回呼一次),
//    元件掛載時就要馬上顯示提示條,不用等下一次事件才顯示(對應 pwaUpdate.ts「訂閱當下如果已經
//    有一個在等待中的新版本,立刻回呼一次」的行為)。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { applyPendingServiceWorkerUpdate, onServiceWorkerUpdateAvailable, triggerUpdateAvailable } =
  vi.hoisted(() => {
    let listener: (() => void) | null = null;
    return {
      applyPendingServiceWorkerUpdate: vi.fn(),
      onServiceWorkerUpdateAvailable: vi.fn((cb: () => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
      triggerUpdateAvailable: () => listener?.(),
    };
  });

vi.mock("@/pwaUpdate", () => ({
  applyPendingServiceWorkerUpdate,
  onServiceWorkerUpdateAvailable,
}));

import UpdateAvailableHint from "./UpdateAvailableHint";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UpdateAvailableHint", () => {
  it("預設(沒有新版本通知)不渲染任何內容", () => {
    const { container } = render(<UpdateAvailableHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("收到有新版本的通知後,顯示提示文字跟「重新整理」按鈕", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    expect(screen.getByText("有新版本可用,點擊重新整理套用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新整理" })).toBeInTheDocument();
  });

  it("點擊「重新整理」呼叫 applyPendingServiceWorkerUpdate,按鈕改成「更新中⋯」並停用", () => {
    render(<UpdateAvailableHint />);
    act(() => triggerUpdateAvailable());
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }));
    expect(applyPendingServiceWorkerUpdate).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", { name: "更新中⋯" });
    expect(button).toBeDisabled();
  });
});
