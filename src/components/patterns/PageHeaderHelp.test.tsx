// SPECS-INDEX #973(2026-10-06):功能頁標題後面的「?」說明框。
//
// 驗證四件事(規格書 .project/specs/商家端文案與說明調整-第1批.md 第一節 + 第六節第 1 點):
//   1. helpMode 開啟時,說明**不再常駐**在 H1 下方,而是收進 H1 後面一顆 aria-label「說明」的 `?`。
//   2. 點 `?` 打開小說明框,看得到原本的說明文字。
//   3. 三種關法:點框外任一處 / 按 Esc / 再點一次 `?`。
//   4. 沒開 helpMode 的頁面(底部選單直達頁、子頁面)維持原本常駐說明,不出現 `?`。
// 🔴 故障注入:把 PageHeader 的 helpMode 分支拿掉(說明改回直接顯示),第 1 條會轉紅。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PageHeader } from "./PageScaffold";

const DESC = "「涼風工匠」的服務人員名錄。";

beforeAll(() => {
  // Radix Popover(floating-ui)在 jsdom 下需要 ResizeObserver;比照 NotificationBell.test.tsx 只在本檔補。
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => cleanup());

function renderHeader(helpMode: boolean) {
  return render(
    <MemoryRouter>
      <div data-testid="outside">頁面其他地方</div>
      <PageHeader
        backTo="/app/manage"
        helpMode={helpMode}
        title="服務人員管理"
        description={DESC}
      />
    </MemoryRouter>,
  );
}

describe("PageHeader helpMode(#973 說明收成「?」)", () => {
  it("helpMode:說明不常駐顯示,H1 後面有一顆 aria-label「說明」的 `?`", () => {
    renderHeader(true);
    expect(screen.getByRole("heading", { level: 1, name: "服務人員管理" })).toBeInTheDocument();
    expect(screen.queryByText(DESC)).toBeNull();
    const trigger = screen.getByRole("button", { name: "說明" });
    expect(trigger).toHaveTextContent("?");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("點 `?` 打開說明框,看得到原本的說明文字", async () => {
    const user = userEvent.setup();
    renderHeader(true);
    await user.click(screen.getByRole("button", { name: "說明" }));
    expect(await screen.findByText(DESC)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "說明" })).toHaveAttribute("aria-expanded", "true");
  });

  it("點框外任一處會關閉", async () => {
    const user = userEvent.setup();
    renderHeader(true);
    await user.click(screen.getByRole("button", { name: "說明" }));
    expect(await screen.findByText(DESC)).toBeInTheDocument();
    await user.click(screen.getByTestId("outside"));
    await waitFor(() => expect(screen.queryByText(DESC)).toBeNull());
  });

  it("按 Esc 會關閉", async () => {
    const user = userEvent.setup();
    renderHeader(true);
    await user.click(screen.getByRole("button", { name: "說明" }));
    expect(await screen.findByText(DESC)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(DESC)).toBeNull());
  });

  it("再點一次 `?` 會關閉", async () => {
    const user = userEvent.setup();
    renderHeader(true);
    await user.click(screen.getByRole("button", { name: "說明" }));
    expect(await screen.findByText(DESC)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "說明" }));
    await waitFor(() => expect(screen.queryByText(DESC)).toBeNull());
  });

  it("沒開 helpMode(底部選單直達頁、子頁面):說明照舊常駐在 H1 下方,沒有 `?`", () => {
    renderHeader(false);
    expect(screen.getByText(DESC)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "說明" })).toBeNull();
  });
});
