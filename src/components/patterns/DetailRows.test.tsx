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

import { DetailLinkRow, DetailLinkRows, InternalNote } from "./DetailRows";

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

// SPECS-INDEX #854:InternalNote 的 🔒 標記要說實話。
//
// 🔴 為什麼這一組非測不可:那句「客戶看不到,服務人員看得到」原本是**寫死在元件裡**的。
// #850~#853 之後,客服可以逐單勾「不讓服務人員看到這則內部備註」,那句話在勾起來的訂單上
// 就是**謊話** —— 客服會看著詳情頁以為自己明明藏起來的備註服務人員還是看得到,然後跑來問。
// 同時這顆元件還被 members/MemberDetailPage.tsx 的「會員備註」共用(那是 members.notes,
// 沒有這個旗標),所以新的 audience prop **必須可選、而且預設維持原樣**,否則會連帶改壞會員備註。
//
// 【故障注入驗證(2026-09-30 實際跑過並還原)】
//   DetailRows.tsx 把 audience 的預設值從 "staff-visible" 改成 "staff-hidden"
//   → 這一組 3 條裡**只有「不給 audience 時維持原本那句」轉紅**(會員備註那個共用場景就是
//     靠這條保護的);另外兩條明確傳值的仍綠 —— 證明三條測的是不同方向,不是同一條寫三次。
describe("InternalNote 的 🔒 標記(#854)", () => {
  afterEach(() => {
    cleanup();
  });

  it("不給 audience 時維持原本那句「客戶看不到,服務人員看得到」(會員備註等既有使用點不受影響)", () => {
    render(<InternalNote>上次尾款沒收</InternalNote>);
    expect(screen.getByText("客戶看不到，服務人員看得到")).toBeInTheDocument();
    expect(screen.queryByText("客戶與服務人員都看不到")).not.toBeInTheDocument();
    expect(screen.getByText("上次尾款沒收")).toBeInTheDocument();
  });

  it('audience="staff-visible" 跟不給是同一句', () => {
    render(<InternalNote audience="staff-visible">上次尾款沒收</InternalNote>);
    expect(screen.getByText("客戶看不到，服務人員看得到")).toBeInTheDocument();
  });

  it('🔴 audience="staff-hidden" 時改成「客戶與服務人員都看不到」,不再說謊', () => {
    render(<InternalNote audience="staff-hidden">上次尾款沒收</InternalNote>);
    expect(screen.getByText("客戶與服務人員都看不到")).toBeInTheDocument();
    expect(screen.queryByText("客戶看不到，服務人員看得到")).not.toBeInTheDocument();
    // 備註內容本身照樣顯示 —— 商家自己永遠看得到,否則他沒辦法取消勾選。
    expect(screen.getByText("上次尾款沒收")).toBeInTheDocument();
  });
});
