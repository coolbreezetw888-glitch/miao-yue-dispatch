// DetailLinkRow 的渲染測試(SPECS-INDEX #832 收尾批)。
//
// 🔴 為什麼需要這一支:`to` 這個 prop 目前**全站還沒有使用點**(BookingDetailDialog 的
// 「相關訂單」「操作記錄」是在同一個全頁層裡換內容,不是跳網址,所以那兩處正確地用 onClick)。
// 沒有使用點又沒有測試的 prop 等於死程式碼 —— 之後第一個要用它的人才發現它壞了。
// 這裡把它該有的行為釘住:
//   ① 有 `to` ⇒ 渲染成真正的 <a href>(使用者要能中鍵 / 右鍵「在新分頁開啟」,這是第 1 批
//      就定案的裁決;做成 <button> + navigate() 外觀一樣但中鍵沒反應,沒有人會來回報)。
//   ② 只有 `onClick` ⇒ 維持 <button>(原地做事,不該有 href 讓人以為可以開新分頁)。
//   ③ `to` + `disabled` ⇒ 不可以渲染 <a>(<a> 沒有 disabled 屬性,鍵盤還 Tab 得進去按下去)。

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailLinkRow, DetailLinkRows } from "./DetailRows";

function renderInRouter(ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={["/app/members/abc"]}>{ui}</MemoryRouter>);
}

describe("DetailLinkRow", () => {
  // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效,
  // 要自己收 —— 不收的話上一條測試留在 document 裡的 <a> 會讓下一條的 queryByRole("link") 誤判。
  afterEach(() => {
    cleanup();
  });

  it("有 to 時渲染成真正的 <a href>(可以中鍵 / 右鍵開新分頁)", () => {
    renderInRouter(
      <DetailLinkRows>
        <DetailLinkRow label="王小明" to="/app/members/xyz" />
      </DetailLinkRows>,
    );
    const link = screen.getByRole("link", { name: /王小明/ });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/app/members/xyz");
  });

  it("只有 onClick 時是 <button>、沒有 href,按下去會呼叫 onClick", () => {
    const onClick = vi.fn();
    renderInRouter(<DetailLinkRow label="相關訂單" onClick={onClick} />);
    const button = screen.getByRole("button", { name: /相關訂單/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button).not.toHaveAttribute("href");
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("onClick + disabled 時按鈕真的不能按", () => {
    const onClick = vi.fn();
    renderInRouter(<DetailLinkRow label="操作記錄" onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: /操作記錄/ });
    expect(button).toBeDisabled();
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("to + disabled 時不渲染 <a>(否則鍵盤還 Tab 得進去按下去)", () => {
    renderInRouter(<DetailLinkRow label="王小明" to="/app/members/xyz" disabled />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("王小明")).toBeInTheDocument();
  });

  it("extra 文字會顯示出來(例:「2 筆」)", () => {
    renderInRouter(<DetailLinkRow label="相關訂單" extra="2 筆" onClick={() => {}} />);
    expect(screen.getByText("2 筆")).toBeInTheDocument();
  });
});
