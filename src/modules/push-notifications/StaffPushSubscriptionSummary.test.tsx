// 模組 15 擴充 §3.3 / 裁決 Q6(使用者的硬性要求):服務人員詳情頁那一欄的三態顯示。
//
// 🔴 這支測試守的是 Q6 真正的重點:新設計下裝置屬於登入帳號,所以「已開通 2 台」**不再等於**
//    「他會收到這間店的通知」。三種互斥狀態必須用三種不同的 Badge 樣式 ——
//    如果「已開通但全關」沿用主色 Badge,視覺上跟「會收到通知」一模一樣,老闆掃過去只會看到
//    「已開通」三個字,那正是 Q6 要修掉的誤導。
//
// ui-v1-full 第 3 批(2026-09-30):畫面改用 ui-overlay-patterns skill 二之四的 StatusTag,
// 所以這支測試的樣式判斷也跟著從 shadcn Badge 的 variant 換成 skill 的四種狀態色調。
// 🔴 **這支測試要守的東西一個字都沒變**:三種互斥狀態仍然必須是三種看得出差別的樣式,
//    而且「已開通但全關」不可以跟「會收到通知」長一樣。只有「怎麼判斷樣式」這件事換了寫法。
// 載入中那一條也跟著改:skill 二之八規定載入中要用灰色骨架方塊,不用「載入中⋯」四個字
//    (原本註解寫的「這一段刻意不改」是指 Q6 那一次不要順手動它,不是永遠不能改)。

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

/** 從 StatusTag 元素的 class 判斷它用的是哪一種狀態色調(skill 二之四:正常 = 綠系 /
 *  要注意 = 黃系 / 結束或尚未啟用 = 灰系 / 出事 = 紅系)。StatusTag 沒有 data-tone 屬性,
 *  所以跟改版前一樣靠 class 判斷。
 *  ⚠️ 判斷順序不可以調換:statusNeutral 的 class 是 `bg-muted text-muted-foreground`,
 *     先比對其他三種才不會誤判。 */
function badgeToneOf(
  element: HTMLElement,
): "success" | "warning" | "danger" | "neutral" | "unknown" {
  const cls = element.className;
  if (cls.includes("bg-success-soft")) return "success";
  if (cls.includes("bg-warn-soft")) return "warning";
  if (cls.includes("bg-destructive-soft")) return "danger";
  if (cls.includes("bg-muted")) return "neutral";
  return "unknown";
}

describe("StaffPushSubscriptionSummary 的三種互斥狀態(§3.3)", () => {
  beforeEach(() => {
    useStaffPushStatusMock.mockReset();
  });
  afterEach(() => cleanup());

  it("載入中顯示灰色骨架方塊,不顯示任何一種狀態標籤(skill 二之八)", () => {
    useStaffPushStatusMock.mockReturnValue({ data: undefined, isLoading: true });
    renderSummary();
    // 骨架是純視覺的方塊,沒有文字 —— 重點是「三種狀態都還沒出現」,不會先閃一個錯的狀態。
    expect(screen.queryByText("載入中⋯")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未開通")).not.toBeInTheDocument();
    expect(screen.queryByText(/會收到通知/)).not.toBeInTheDocument();
    expect(screen.queryByText(/關閉了全部通知/)).not.toBeInTheDocument();
  });

  it("0 台:顯示「尚未開通」+ 補充小字", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 0, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    const badge = screen.getByText("尚未開通");
    // 🔴 中性(灰系),不是待辦的黃色:推播是選配功能,沒打算用的人永遠是「尚未開通」,
    // 那是永久狀態 = 屬性,屬性不給警示色(skill 二之五末段,跟 #846 黃卡同一條通則)。
    expect(badgeToneOf(badge)).toBe("neutral");
    expect(screen.getByText("他還沒在任何手機上開啟推播通知。")).toBeInTheDocument();
  });

  it("有裝置且有開啟事件:顯示「已開通 N 台,會收到通知」,不顯示補充小字(正常狀態不需要解釋)", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: true },
      isLoading: false,
    });
    renderSummary();
    const badge = screen.getByText("已開通 2 台，會收到通知");
    expect(badgeToneOf(badge)).toBe("success");
    expect(screen.queryByText(/他還沒在任何手機/)).not.toBeInTheDocument();
    expect(screen.queryByText(/全部關掉/)).not.toBeInTheDocument();
  });

  it("🔴 有裝置但四個事件全關:文字明寫「但他關閉了全部通知」+ 補充小字", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    expect(screen.getByText("已開通 2 台，但他關閉了全部通知")).toBeInTheDocument();
    expect(
      screen.getByText(
        "他的手機可以收通知，但他自己把四種事件全部關掉了——所以這間店的訂單不會通知他。",
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
    const willReceiveTone = badgeToneOf(screen.getByText("已開通 2 台，會收到通知"));
    cleanup();

    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 2, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    const allDisabledTone = badgeToneOf(screen.getByText("已開通 2 台，但他關閉了全部通知"));

    expect(willReceiveTone).toBe("success");
    expect(allDisabledTone).toBe("warning");
    // 這一行才是 Q6 真正要守的東西:兩者絕對不可以長一樣。
    expect(allDisabledTone).not.toBe(willReceiveTone);
  });

  it("三種狀態互斥:同一時間只會渲染出其中一個 Badge", () => {
    useStaffPushStatusMock.mockReturnValue({
      data: { deviceCount: 1, anyEventEnabled: false },
      isLoading: false,
    });
    renderSummary();
    expect(screen.queryByText("尚未開通")).not.toBeInTheDocument();
    expect(screen.queryByText(/會收到通知$/)).not.toBeInTheDocument();
    expect(screen.getByText("已開通 1 台，但他關閉了全部通知")).toBeInTheDocument();
  });
});
