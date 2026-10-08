// SPECS-INDEX #982:下拉刷新元件接線 —— 真的派 touch 事件,確認「該觸發的觸發、不該的不觸發」。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// #1014:下拉刷新時會呼叫 pwaUpdate.ts 的 checkForServiceWorkerUpdate() 主動檢查新版本。
// 這裡 mock 掉,只驗「有沒有呼叫、失敗/卡住會不會影響刷新」;檢查本身的節流與錯誤處理在 src/pwaUpdate.test.ts。
const { checkForServiceWorkerUpdate } = vi.hoisted(() => ({
  checkForServiceWorkerUpdate: vi.fn((): Promise<boolean> => Promise.resolve(true)),
}));
vi.mock("@/pwaUpdate", () => ({ checkForServiceWorkerUpdate }));

import { PullToRefresh } from "./PullToRefresh";

let queryClient: QueryClient;
let refetchSpy: MockInstance;
const originalWidth = window.innerWidth;

function setup(extraHtml: React.ReactNode = null) {
  queryClient = new QueryClient();
  refetchSpy = vi
    .spyOn(queryClient, "refetchQueries")
    .mockResolvedValue(undefined) as unknown as MockInstance;
  return render(
    <QueryClientProvider client={queryClient}>
      <main>
        <p data-testid="content">內容</p>
        {extraHtml}
      </main>
      <PullToRefresh />
    </QueryClientProvider>,
  );
}

async function pull(target: Element, dy: number, opts: { dx?: number; holdMs?: number } = {}) {
  await act(async () => {
    fireEvent.touchStart(target, { touches: [{ clientX: 100, clientY: 100 }] });
  });
  if (opts.holdMs) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, opts.holdMs));
    });
  }
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await act(async () => {
      fireEvent.touchMove(target, {
        touches: [{ clientX: 100 + ((opts.dx ?? 0) * i) / steps, clientY: 100 + (dy * i) / steps }],
      });
    });
  }
  await act(async () => {
    fireEvent.touchEnd(target, { touches: [] });
  });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
});
afterEach(() => {
  cleanup();
  checkForServiceWorkerUpdate.mockReset();
  checkForServiceWorkerUpdate.mockImplementation(() => Promise.resolve(true));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  document.body.removeAttribute("data-scroll-locked");
});

describe("PullToRefresh", () => {
  it("在頂端往下拉超過門檻放開 ⇒ 重新抓作用中的查詢(不是整頁重載)", async () => {
    setup();
    await pull(screen.getByTestId("content"), 120);
    expect(refetchSpy).toHaveBeenCalledWith({ type: "active" });
    expect(screen.getByTestId("pull-to-refresh-indicator")).toHaveAttribute(
      "data-state",
      "refreshing",
    );
  });

  it("拉的過程顯示指示器,超過門檻文字變「放開以重新整理」", async () => {
    setup();
    const target = screen.getByTestId("content");
    await act(async () => {
      fireEvent.touchStart(target, { touches: [{ clientX: 100, clientY: 100 }] });
    });
    await act(async () => {
      fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 130 }] });
    });
    expect(screen.getByText("下拉以重新整理")).toBeInTheDocument();
    await act(async () => {
      fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 190 }] });
    });
    expect(screen.getByText("放開以重新整理")).toBeInTheDocument();
    await act(async () => {
      fireEvent.touchEnd(target, { touches: [] });
    });
  });

  it("沒超過門檻就放開 ⇒ 不刷新,指示器收起", async () => {
    setup();
    await pull(screen.getByTestId("content"), 50);
    expect(refetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pull-to-refresh-indicator")).not.toBeInTheDocument();
  });

  it("🔴 彈窗開著 ⇒ 停用", async () => {
    setup(
      <div role="dialog" data-state="open">
        建單表單
      </div>,
    );
    await pull(screen.getByTestId("content"), 150);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("🔴 水平為主的滑動(左右換日)⇒ 不觸發", async () => {
    setup();
    await pull(screen.getByTestId("content"), 90, { dx: 200 });
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("🔴 別的元件已經接手這個手勢(touchmove 被 preventDefault,例如行事曆拖拉中)⇒ 放棄", async () => {
    setup();
    const target = screen.getByTestId("content");
    const block = (e: Event) => e.preventDefault();
    target.addEventListener("touchmove", block, { passive: false });
    await pull(target, 150);
    target.removeEventListener("touchmove", block);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("🔴 長按之後才往下拖 ⇒ 不觸發", async () => {
    setup();
    await pull(screen.getByTestId("content"), 150, { holdMs: 450 });
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("電腦版寬度 ⇒ 不做", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    setup();
    await pull(screen.getByTestId("content"), 150);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("#1014 下拉刷新 ⇒ 同時主動檢查一次新版本", async () => {
    setup();
    await pull(screen.getByTestId("content"), 120);
    expect(refetchSpy).toHaveBeenCalledWith({ type: "active" });
    expect(checkForServiceWorkerUpdate).toHaveBeenCalledTimes(1);
  });

  it("#1014 沒觸發刷新(沒超過門檻 / 電腦版)⇒ 也不檢查新版本", async () => {
    setup();
    await pull(screen.getByTestId("content"), 50);
    expect(checkForServiceWorkerUpdate).not.toHaveBeenCalled();
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    setup();
    await pull(screen.getByTestId("content"), 150);
    expect(checkForServiceWorkerUpdate).not.toHaveBeenCalled();
  });

  it("#1014 🔴 版本檢查一直沒回應 ⇒ 下拉刷新照樣結束、指示器照樣收起(不等它、不卡住)", async () => {
    checkForServiceWorkerUpdate.mockImplementation(() => new Promise<boolean>(() => {}));
    setup();
    await pull(screen.getByTestId("content"), 120);
    expect(refetchSpy).toHaveBeenCalledWith({ type: "active" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    expect(screen.queryByTestId("pull-to-refresh-indicator")).not.toBeInTheDocument();
  });

  it("#1014 🔴 版本檢查失敗(reject)⇒ 不報錯、刷新照常完成", async () => {
    checkForServiceWorkerUpdate.mockImplementation(() => Promise.reject(new Error("offline")));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      setup();
      await pull(screen.getByTestId("content"), 120);
      expect(refetchSpy).toHaveBeenCalledWith({ type: "active" });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 650));
      });
      expect(screen.queryByTestId("pull-to-refresh-indicator")).not.toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("掛著時 html / body 設 overscroll-behavior-y: contain(避免跟瀏覽器原生下拉刷新同時觸發),卸載後還原", () => {
    const { unmount } = setup();
    expect(document.documentElement.style.overscrollBehaviorY).toBe("contain");
    expect(document.body.style.overscrollBehaviorY).toBe("contain");
    unmount();
    expect(document.documentElement.style.overscrollBehaviorY).toBe("");
  });
});
