// §13.10(SPECS-INDEX #760):超級管理員後台**刻意不做**鈴鐺,這支測試把那個決定釘住。
//
// 為什麼需要一條測試守一個「不做」的決定:規格書列了四個查證過的理由,其中第三個是關鍵 ——
// **就算做了也永遠是空的**。本批四種事件全部是「某間商家的訂單事件」,resolve_push_recipients
// 只解析 admin / agent / staff 三種商家身份,超級管理員不是其中任何一種,一則通知都不會產生。
// 而且 /platform-admin/* 走的是 PlatformAdminShell(完全不經過 AppLayout),那個外殼連「登出」
// 按鈕都沒有 —— 使用者說的「登出的左側」這個位置在那裡根本不存在。
//
// ⇒ 如果之後有人「順手」把 <NotificationBell /> 加到這個外殼上,就會做出一個永遠空白的功能,
//    而且不會有任何其他測試出聲。這條測試就是那個出聲的東西。
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { PlatformAdminShell } from "./PlatformAdminShell";

describe("PlatformAdminShell(§13.10)", () => {
  afterEach(() => {
    cleanup();
  });

  it("渲染結果裡**沒有**鈴鐺", () => {
    render(
      <MemoryRouter initialEntries={["/platform-admin"]}>
        <PlatformAdminShell>
          <p>內容</p>
        </PlatformAdminShell>
      </MemoryRouter>,
    );
    // 這個外殼本體確實渲染出來了(前提斷言:避免「整個元件沒渲染」造成的空清單假通過)。
    expect(screen.getByText("秒約・超級管理員後台")).toBeInTheDocument();
    expect(screen.getByText("內容")).toBeInTheDocument();

    // 真正要驗的:沒有鈴鐺、也沒有未讀 badge。
    expect(screen.queryByTestId("notification-bell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-unread-badge")).not.toBeInTheDocument();
  });

  it("這個外殼本來就沒有「登出」按鈕(使用者說的『登出的左側』在這裡不存在)", () => {
    render(
      <MemoryRouter initialEntries={["/platform-admin"]}>
        <PlatformAdminShell>
          <p>內容</p>
        </PlatformAdminShell>
      </MemoryRouter>,
    );
    expect(screen.queryByText("登出")).not.toBeInTheDocument();
    // 右上角只有「返回一般後台」。
    expect(screen.getByText("返回一般後台")).toBeInTheDocument();
  });
});
