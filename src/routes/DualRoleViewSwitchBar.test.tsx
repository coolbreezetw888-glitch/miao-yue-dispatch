// 雙重身分檢視切換橫幅的渲染測試。
//
// 為什麼這個 DOM 測試值得寫(而不是只測 appLayoutLogic 的純函式):
// 2026-09-24 那次故障的教訓不只是「判斷邏輯沒測」,更是「切換入口到底有沒有真的長在畫面上、
// 使用者按不按得到」從來沒有被驗證過 —— 當時唯一的入口藏在下拉選單裡,連「它有渲染出來嗎」
// 這個問題都沒有任何自動化答案。所以這裡直接對著 DOM 斷言:文字、按鈕、按下去會不會回呼。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DualRoleViewSwitchBar } from "./DualRoleViewSwitchBar";

describe("DualRoleViewSwitchBar", () => {
  // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效,
  // 要自己清掉上一個測試留下來的 DOM(比照 PushSubscriptionCard.test.tsx 既有做法)。
  afterEach(() => {
    cleanup();
  });

  it("在商家端時:告訴使用者他也是服務人員,並給一個「切換到服務人員端」的按鈕", () => {
    render(<DualRoleViewSwitchBar isStaffView={false} onToggle={() => {}} />);

    expect(screen.getByTestId("dual-role-view-switch")).toBeTruthy();
    const button = screen.getByRole("button", { name: /切換到服務人員端/ });
    expect(button).toBeTruthy();
    // 橫幅上必須明說「你也是這間商家的服務人員」——這正是使用者當時完全不知道的事。
    expect(screen.getByTestId("dual-role-view-switch").textContent).toContain("服務人員");
  });

  it("在服務人員端時:按鈕反向變成「切換到商家端」", () => {
    render(<DualRoleViewSwitchBar isStaffView onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: /切換到商家端/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /切換到服務人員端/ })).toBeNull();
  });

  it("按下按鈕會呼叫 onToggle(按得到,不是一個裝飾)", () => {
    const onToggle = vi.fn();
    render(<DualRoleViewSwitchBar isStaffView={false} onToggle={onToggle} />);

    screen.getByRole("button", { name: /切換到服務人員端/ }).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
