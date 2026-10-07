// 第 11 批 J(#995 J-9 ~ J-11):全頁層 / 小卡窗「Esc 或點上方空白條」遇到填過資料先問「確定放棄這次輸入？」。
//
// 用真的 useFormDirty 接一個輸入框,模擬頁面的接法(灌初始值的地方 markClean)。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDialog, CardDialogContent, CardDialogHeader, CardDialogTitle } from "./CardDialog";
import { useFormDirty } from "./formDirty";
import { FieldInput } from "./FormField";
import { FullPageLayer, FullPageLayerContent } from "./FullPageLayer";
import { DISCARD_CHANGES_COPY } from "./overlayDismissLogic";

beforeEach(() => {
  // 假裝視窗上方還有 200px(電腦版),空白條才會畫出來(jsdom 沒有版面)。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        top: 200,
        left: 100,
        width: 400,
        height: 300,
        right: 500,
        bottom: 500,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

type Shell = "full" | "card";

function Harness({
  shell,
  onOpenChange,
  onEscapeKeyDown,
}: {
  shell: Shell;
  onOpenChange: (open: boolean) => void;
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
}) {
  const [name, setName] = React.useState("");
  const dirty = useFormDirty(name);
  const markClean = dirty.markClean;
  React.useEffect(() => {
    setName("");
    markClean("");
  }, [markClean]);
  const field = (
    <FieldInput aria-label="客戶姓名" value={name} onChange={(e) => setName(e.target.value)} />
  );
  const extra = onEscapeKeyDown ? { onEscapeKeyDown } : {};
  if (shell === "full") {
    return (
      <FullPageLayer open onOpenChange={onOpenChange}>
        <FullPageLayerContent title="新增預約" dirty={dirty.dirty} {...extra}>
          {field}
        </FullPageLayerContent>
      </FullPageLayer>
    );
  }
  return (
    <CardDialog open onOpenChange={onOpenChange}>
      <CardDialogContent dirty={dirty.dirty} {...extra}>
        <CardDialogHeader>
          <CardDialogTitle>付款方式</CardDialogTitle>
        </CardDialogHeader>
        {field}
      </CardDialogContent>
    </CardDialog>
  );
}

function strip(): HTMLElement {
  // 最上層那一條(放棄確認窗打開時,它自己也有一條)。
  const all = [...document.querySelectorAll<HTMLElement>("[data-overlay-dismiss-strip]")];
  return all[0]!;
}

describe.each<[Shell, string]>([
  ["full", "全頁層"],
  ["card", "小卡窗"],
])("%s(%s)", (shell) => {
  it("dirty ⇒ Esc 出現「確定放棄這次輸入？」;「繼續編輯」視窗仍開、欄位值還在;「放棄」⇒ onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness shell={shell} onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText("客戶姓名"), "王小明");
    await user.keyboard("{Escape}");
    expect(await screen.findByText(DISCARD_CHANGES_COPY.title)).toBeInTheDocument();
    expect(screen.getByText(DISCARD_CHANGES_COPY.body)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: DISCARD_CHANGES_COPY.keepEditing }));
    await waitFor(() =>
      expect(screen.queryByText(DISCARD_CHANGES_COPY.title)).not.toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("客戶姓名")).toHaveValue("王小明");

    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: DISCARD_CHANGES_COPY.discard }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dirty=false ⇒ Esc 直接關(不問)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness shell={shell} onOpenChange={onOpenChange} />);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(DISCARD_CHANGES_COPY.title)).not.toBeInTheDocument();
  });

  it("改了又改回原樣 = 沒填 ⇒ Esc 直接關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness shell={shell} onOpenChange={onOpenChange} />);
    const input = screen.getByLabelText("客戶姓名");
    await user.type(input, "王");
    await user.clear(input);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("點空白條:dirty ⇒ 先問;dirty=false ⇒ 直接關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness shell={shell} onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText("客戶姓名"), "王");
    await user.click(strip());
    expect(await screen.findByText(DISCARD_CHANGES_COPY.title)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    // 放棄確認窗自己的上方空白條 = 繼續編輯。
    const allStrips = [...document.querySelectorAll<HTMLElement>("[data-overlay-dismiss-strip]")];
    // 下層視窗一條 + 放棄確認窗一條;最後一條是放棄確認窗的(第 12 批 #1000 起條上沒有字,改用數量確認)。
    expect(allStrips).toHaveLength(2);
    const confirmStrip = allStrips.at(-1)!;
    expect(confirmStrip.textContent).toBe("");
    await user.click(confirmStrip);
    await waitFor(() =>
      expect(screen.queryByText(DISCARD_CHANGES_COPY.title)).not.toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("客戶姓名")).toHaveValue("王");

    await user.clear(screen.getByLabelText("客戶姓名"));
    await user.click(strip());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("按 ✕ ⇒ dirty 也直接關(J-11)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness shell={shell} onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText("客戶姓名"), "王");
    const closes = screen.getAllByRole("button", { name: "關閉" });
    await user.click(closes[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(DISCARD_CHANGES_COPY.title)).not.toBeInTheDocument();
  });

  it("頁面 onEscapeKeyDown 先 preventDefault(建單「選擇項目」整頁情境)⇒ 不問也不關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onEscapeKeyDown = vi.fn((e: KeyboardEvent) => e.preventDefault());
    render(<Harness shell={shell} onOpenChange={onOpenChange} onEscapeKeyDown={onEscapeKeyDown} />);
    await user.type(screen.getByLabelText("客戶姓名"), "王");
    await user.keyboard("{Escape}");
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    // 空白條走同一條路。
    await user.click(strip());
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(2);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText(DISCARD_CHANGES_COPY.title)).not.toBeInTheDocument();
  });
});
