// SPECS-INDEX #990(第 11 批 C 項):SwitchRow 的說明收進「?」(descriptionMode="popover")。
//
// 驗證(規格書 .project/specs/改掛會員與預設文案全形-第11批.md §3.2、§5.2):
//   1. popover 模式:說明不常駐在畫面上;名稱後面有一顆 aria-label「說明：{名稱}」的 `?`。
//   2. 點 `?` 跳出小說明框,看得到說明;點框外 / Esc / 再點一次 `?` 都會關。
//   3. 🔴 點 `?` 不會切換開關(`?` 放在 <Label> 外面;放進 Label 的話 htmlFor 會把點擊轉給開關)。
//   4. 點名稱本身仍然會切換開關(Label 跟開關的關聯沒有被拆掉)、開關的無障礙名稱 = 名稱。
//   5. inline 模式(預設)行為不變:說明直接顯示在名稱下方、沒有 `?`。
// 🔴 故障注入(2026-10-07 實測):把 HelpPopover 搬進 <Label> 裡 ⇒ 第 1 條(結構斷言「`?` 不在 Label 裡」)轉紅。
//    第 3 條在 jsdom 與真實瀏覽器都不會因此轉紅:HTML 規範規定點到 label 裡的「互動元素」(button)時
//    不觸發 label 轉送,所以真正的保險是第 1 條的結構斷言;第 3 條守的是「點 `?` / 點說明框都不會送出切換」。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SwitchRow } from "./FormField";

const DESC = "開放後客服可以新增、編輯會員資料。";

beforeAll(() => {
  // Radix Popover(floating-ui)在 jsdom 下需要 ResizeObserver;比照 PageHeaderHelp.test.tsx 只在本檔補。
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => cleanup());

function Harness({
  mode,
  onChange,
}: {
  mode?: "inline" | "popover";
  onChange?: (v: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div>
      <div data-testid="outside">頁面其他地方</div>
      <SwitchRow
        title="會員管理"
        description={DESC}
        descriptionMode={mode}
        helpLabel="說明：會員管理"
        helpTriggerTestId="permission-help-trigger-members"
        helpPopoverTestId="permission-help-popover"
        titleTestId="permission-switch-title"
        checked={checked}
        onCheckedChange={(v) => {
          onChange?.(v);
          setChecked(v);
        }}
      />
    </div>
  );
}

describe("SwitchRow descriptionMode=popover(#990)", () => {
  it("說明不常駐;名稱後面有一顆 aria-label「說明：會員管理」的 `?`;名稱文字不含 `?`", () => {
    render(<Harness mode="popover" />);
    expect(screen.queryByText(DESC)).toBeNull();
    const trigger = screen.getByRole("button", { name: "說明：會員管理" });
    expect(trigger).toHaveTextContent("?");
    expect(trigger).toHaveAttribute("data-testid", "permission-help-trigger-members");
    expect(screen.getByTestId("permission-switch-title")).toHaveTextContent(/^會員管理$/);
    // `?` 不在 Label 裡面
    expect(screen.getByTestId("permission-switch-title").contains(trigger)).toBe(false);
  });

  it("點 `?` 跳出說明框;點框外、Esc、再點一次 `?` 都會關", async () => {
    const user = userEvent.setup();
    render(<Harness mode="popover" />);
    const trigger = screen.getByRole("button", { name: "說明：會員管理" });

    await user.click(trigger);
    expect(await screen.findByTestId("permission-help-popover")).toHaveTextContent(DESC);
    await user.click(screen.getByTestId("outside"));
    await waitFor(() => expect(screen.queryByTestId("permission-help-popover")).toBeNull());

    await user.click(trigger);
    expect(await screen.findByTestId("permission-help-popover")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("permission-help-popover")).toBeNull());

    await user.click(trigger);
    expect(await screen.findByTestId("permission-help-popover")).toBeInTheDocument();
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByTestId("permission-help-popover")).toBeNull());
  });

  it("🔴 點 `?` 不會切換開關", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness mode="popover" onChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "會員管理" });
    expect(sw).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("button", { name: "說明：會員管理" }));
    await screen.findByTestId("permission-help-popover");
    // 說明框裡面點一下也不會切換
    await user.click(screen.getByTestId("permission-help-popover"));

    expect(onChange).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("點名稱仍會切換開關(Label 關聯還在)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness mode="popover" onChange={onChange} />);
    await user.click(screen.getByTestId("permission-switch-title"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: "會員管理" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("SwitchRow inline 模式(預設)行為不變", () => {
  it("說明直接顯示在名稱下方,沒有 `?`", () => {
    render(<Harness />);
    expect(screen.getByText(DESC)).toBeVisible();
    expect(screen.queryByRole("button", { name: /說明/ })).toBeNull();
    expect(screen.getByRole("switch", { name: "會員管理" })).toBeInTheDocument();
  });
});
