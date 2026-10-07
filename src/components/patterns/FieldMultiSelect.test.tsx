// 第 11 批 G(#994):多選下拉 FieldMultiSelect。規格書 §14.5 G-4~G-15、§14.7 vitest ①~⑧。

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FieldMultiSelect } from "./FieldMultiSelect";
import type { FieldMultiSelectOption } from "./fieldMultiSelectLogic";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => cleanup());

const BASE: FieldMultiSelectOption[] = [
  { value: "a", label: "冷氣清洗", detail: "清洗類 ・ $1500", keywords: "清洗類" },
  { value: "b", label: "冷氣安裝", detail: "安裝類 ・ $3000", keywords: "安裝類" },
  { value: "c", label: "洗衣機清洗", detail: "清洗類 ・ $1200", keywords: "清洗類" },
];

function many(n: number): FieldMultiSelectOption[] {
  return Array.from({ length: n }, (_, i) => ({
    value: `m${i + 1}`,
    label: `項目${i + 1}`,
    detail: `分類 ・ $${(i + 1) * 100}`,
    keywords: i === 0 ? "特殊分類" : "一般",
  }));
}

function Harness({
  options = BASE,
  initial = [],
  busy,
  onToggle,
}: {
  options?: FieldMultiSelectOption[];
  initial?: string[];
  busy?: ReadonlySet<string>;
  onToggle?: (value: string, next: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  return (
    <>
      <p id="label-x">服務項目</p>
      <FieldMultiSelect
        id="x"
        aria-labelledby="label-x"
        options={options}
        selected={selected}
        busyValues={busy}
        placeholder="請選擇服務項目"
        testIdPrefix="ms"
        onToggle={(value, next) => {
          onToggle?.(value, next);
          setSelected((prev) => {
            const s = new Set(prev);
            if (next) s.add(value);
            else s.delete(value);
            return s;
          });
        }}
      />
    </>
  );
}

const rowsIn = (el: HTMLElement) => within(el).getAllByRole("checkbox");

describe("FieldMultiSelect", () => {
  it("① 點外框打開;列是 role=checkbox、aria-checked 正確;外框是 aria-haspopup=dialog", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["b"]} />);
    const trigger = screen.getByTestId("ms-trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAccessibleName("服務項目");
    await user.click(trigger);
    const content = await screen.findByTestId("ms-content");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(content).toHaveAttribute("data-pull-to-refresh", "off");
    expect(within(content).getByRole("group")).toHaveAccessibleName("服務項目");
    expect(rowsIn(content).map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // G-9:焦點放在第一個已勾選的列(不是搜尋框)
    await waitFor(() => expect(screen.getByTestId("ms-option-b")).toHaveFocus());
  });

  it("② 點未勾的列 ⇒ onToggle(value, true),清單仍開著", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    await user.click(screen.getByTestId("ms-trigger"));
    await user.click(await screen.findByTestId("ms-option-a"));
    expect(onToggle).toHaveBeenCalledWith("a", true);
    expect(screen.getByTestId("ms-content")).toBeInTheDocument();
    expect(screen.getByTestId("ms-option-a")).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByTestId("ms-option-a"));
    expect(onToggle).toHaveBeenLastCalledWith("a", false);
    expect(screen.getByTestId("ms-content")).toBeInTheDocument();
  });

  it("③ busyValues 裡的列 aria-disabled,點了不呼叫 onToggle;其他列照常", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Harness busy={new Set(["b"])} onToggle={onToggle} />);
    await user.click(screen.getByTestId("ms-trigger"));
    const busyRow = await screen.findByTestId("ms-option-b");
    expect(busyRow).toHaveAttribute("aria-disabled", "true");
    await user.click(busyRow);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByTestId("ms-option-a")).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByTestId("ms-option-a"));
    expect(onToggle).toHaveBeenCalledWith("a", true);
  });

  it("④ 列數 ≤ 8 沒有搜尋框;> 8 有,輸入後只剩符合的列;沒結果出現提示", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness options={many(8)} />);
    await user.click(screen.getByTestId("ms-trigger"));
    await screen.findByTestId("ms-content");
    expect(screen.queryByTestId("ms-search")).toBeNull();
    unmount();

    render(<Harness options={many(9)} />);
    await user.click(screen.getByTestId("ms-trigger"));
    const search = await screen.findByTestId("ms-search");
    expect(search).toHaveAttribute("placeholder", "搜尋服務項目");
    // 不自動聚焦搜尋框(手機會彈鍵盤)
    expect(search).not.toHaveFocus();
    await user.type(search, "項目9");
    expect(rowsIn(screen.getByTestId("ms-content")).map((r) => r.textContent)).toEqual([
      expect.stringContaining("項目9"),
    ]);
    await user.clear(search);
    await user.type(search, "特殊分類");
    expect(rowsIn(screen.getByTestId("ms-content"))).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "不存在");
    expect(screen.getByTestId("ms-empty")).toHaveTextContent("找不到符合的服務項目");
    expect(within(screen.getByTestId("ms-content")).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("⑤「完成」關清單;底部顯示已選 N 項", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["a", "c"]} />);
    await user.click(screen.getByTestId("ms-trigger"));
    expect(await screen.findByTestId("ms-count")).toHaveTextContent("已選 2 項");
    await user.click(screen.getByTestId("ms-done"));
    await waitFor(() => expect(screen.queryByTestId("ms-content")).toBeNull());
    expect(screen.getByTestId("ms-trigger")).toHaveAttribute("aria-expanded", "false");
  });

  it("⑥ G-12:包在 Radix Dialog 裡,按 Esc ⇒ 清單關、Dialog 還開著", async () => {
    const user = userEvent.setup();
    function InDialog() {
      const [open, setOpen] = useState(true);
      return (
        <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Content data-testid="outer-dialog" aria-describedby={undefined}>
              <DialogPrimitive.Title>編輯服務人員</DialogPrimitive.Title>
              <Harness />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      );
    }
    render(<InDialog />);
    await user.click(screen.getByTestId("ms-trigger"));
    await screen.findByTestId("ms-content");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("ms-content")).toBeNull());
    expect(screen.getByTestId("outer-dialog")).toBeInTheDocument();
    // 再按一次 Esc 才關掉外層(原行為)
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("outer-dialog")).toBeNull());
  });

  it("⑦ 已下架列在「已下架」分隔標題下、半透明、勾選中、文案逐字;點了 = 移除", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const options: FieldMultiSelectOption[] = [
      ...BASE,
      { value: "r", label: "舊款濾網", keywords: "耗材", removed: true },
    ];
    render(<Harness options={options} initial={["r"]} onToggle={onToggle} />);
    await user.click(screen.getByTestId("ms-trigger"));
    const content = await screen.findByTestId("ms-content");
    const heading = within(content).getByTestId("ms-removed-heading");
    expect(heading).toHaveTextContent("已下架");
    const row = within(content).getByTestId("ms-option-r");
    // 分隔標題在已下架列之前、在所有上架列之後
    expect(heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(content).getByTestId("ms-option-c").compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(row.className).toContain("opacity-60");
    expect(row).toHaveTextContent("已下架，取消勾選後就不能再選回來");
    await user.click(row);
    expect(onToggle).toHaveBeenCalledWith("r", false);
  });

  it("⑧ 外框摘要文字逐字(0 項灰字 / 有選 ⇒ 已選 N 項：…)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId("ms-summary")).toHaveTextContent("請選擇服務項目");
    expect(screen.getByTestId("ms-summary").className).toContain("text-muted-foreground");
    await user.click(screen.getByTestId("ms-trigger"));
    await user.click(await screen.findByTestId("ms-option-c"));
    await user.click(screen.getByTestId("ms-option-a"));
    expect(screen.getByTestId("ms-summary")).toHaveTextContent("已選 2 項：冷氣清洗、洗衣機清洗");
    expect(screen.getByTestId("ms-summary").className).not.toContain("text-muted-foreground");
  });
});
