// 模組 15 擴充 §3.3 / 裁決 Q6(使用者的硬性要求):服務人員詳情頁那一欄的三態顯示。
//
// 🔴 這支測試守的是 Q6 真正的重點:新設計下裝置屬於登入帳號,所以「已開通 2 台」**不再等於**
//    「他會收到這間店的通知」。三種互斥狀態必須用三種不同的 Badge 樣式 ——
//    如果「已開通但全關」沿用主色 Badge,視覺上跟「會收到通知」一模一樣,老闆掃過去只會看到
//    「已開通」三個字,那正是 Q6 要修掉的誤導。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useStaffPushStatusMock = vi.fn();

vi.mock("./api", () => ({
  useStaffPushStatus: (...args: unknown[]) => useStaffPushStatusMock(...args),
}));

import { StaffPushSubscriptionSummary } from "./StaffPushSubscriptionSummary";

function renderSummary() {
  render(<StaffPushSubscriptionSummary staffId="staff-1" />);
}

/** 從 Badge 元素的 class 判斷它用的是哪一種 variant(shadcn Badge 沒有 data-variant 屬性)。 */
function badgeVariantOf(element: HTMLElement): "default" | "secondary" | "outline" | "unknown" {
  const cls = element.className;
  if (cls.includes("border-transparent") && cls.includes("bg-primary")) return "default";
  if (cls.includes("border-transparent") && cls.includes("bg-secondary")) return "secondary";
  if (!cls.includes("border-transparent")) return "outline";
  return "unknown";
}

describe("StaffPushSubscriptionSummary 的三種互斥狀態(§3.3)", () => {
  beforeEach(() => {
    useStaffPushStatusMock.mockReset();
  });
  afterEach(() => cleanup());

  it("載入中維持原本的「載入中⋯」灰字(這一段刻意不改)", () => {
    useStaffPushStatusMock.mockReturnValue({ data: undefined, isLoading: true });
    renderSummary();
    expect(screen.getByText("載入中⋯")).toBeInTheDocument();
  });

  it("0 台:顯示「尚未開通」+ 補充小字", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 0, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    const badge = screen.getByText("尚未開通");
    expect(badgeVariantOf(badge)).toBe("secondary");
    expect(screen.getByText("他還沒在任何手機上開啟推播通知。")).toBeInTheDocument();
  });

  it("有裝置且有開啟事件:顯示「已開通 N 台,會收到通知」,不顯示補充小字(正常狀態不需要解釋)", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: true },
      isLoading: false,
    });
    renderSummary();
    const badge = screen.getByText("已開通 2 台,會收到通知");
    expect(badgeVariantOf(badge)).toBe("default");
    expect(screen.queryByText(/他還沒在任何手機/)).not.toBeInTheDocument();
    expect(screen.queryByText(/全部關掉/)).not.toBeInTheDocument();
  });

  it("🔴 有裝置但四個事件全關:文字明寫「但他關閉了全部通知」+ 補充小字", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    expect(screen.getByText("已開通 2 台,但他關閉了全部通知")).toBeInTheDocument();
    expect(
      screen.getByText(
        "他的手機可以收通知,但他自己把四種事件全部關掉了——所以這間店的訂單不會通知他。",
      ),
    ).toBeInTheDocument();
    // 舊文案「已開通 2 台裝置」絕對不能再出現 —— 那正是 Q6 要修掉的誤導。
    expect(screen.queryByText("已開通 2 台裝置")).not.toBeInTheDocument();
  });

  it("🔴 核心必測:「已開通但全關」的 Badge 樣式不可以跟「會收到通知」一樣", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: true },
      isLoading: false,
    });
    renderSummary();
    const willReceiveVariant = badgeVariantOf(screen.getByText("已開通 2 台,會收到通知"));
    cleanup();

    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    const allDisabledVariant = badgeVariantOf(screen.getByText("已開通 2 台,但他關閉了全部通知"));

    expect(allDisabledVariant).toBe("outline");
    expect(allDisabledVariant).not.toBe(willReceiveVariant);
  });

  it("三種狀態互斥:同一時間只會渲染出其中一個 Badge", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 1, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    expect(screen.queryByText("尚未開通")).not.toBeInTheDocument();
    expect(screen.queryByText(/會收到通知$/)).not.toBeInTheDocument();
    expect(screen.getByText("已開通 1 台,但他關閉了全部通知")).toBeInTheDocument();
  });
});
