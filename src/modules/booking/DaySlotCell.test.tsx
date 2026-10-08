// SPECS-INDEX #1023(第 22 批):格子選單一個選項都沒有 ⇒ 不可點的 div(沒有選單、一般箭頭),外觀與 data-slot-state 照舊。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DaySlotCell } from "./DaySlotCell";

afterEach(() => cleanup());

function renderCell(showCreateOption: boolean, showOverrideOption: boolean) {
  return render(
    <div style={{ position: "relative" }}>
      <DaySlotCell
        top={0}
        height={30}
        cellClassName="bg-muted/40"
        cellStyle={{ backgroundColor: "rgb(1, 2, 3)" }}
        ariaLabel="不可預約"
        slotState="unavailable"
        badgeText=""
        showCreateOption={showCreateOption}
        onCreateBooking={() => {}}
        showOverrideOption={showOverrideOption}
        overrideOptionLabel="開啟時段"
        onToggleOverride={() => {}}
      />
    </div>,
  );
}

describe("DaySlotCell(#1023)", () => {
  it("沒有任何選項 ⇒ 不是按鈕、cursor-default、狀態與底色照舊", () => {
    const { container } = renderCell(false, false);
    expect(screen.queryByRole("button")).toBeNull();
    const cell = container.querySelector<HTMLElement>('[data-slot-state="unavailable"]')!;
    expect(cell.tagName).toBe("DIV");
    expect(cell.className).toContain("cursor-default");
    expect(cell.className).not.toContain("cursor-pointer");
    expect(cell.style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(cell.getAttribute("aria-label")).toBe("不可預約");
  });

  it("有選項 ⇒ 按鈕、cursor-pointer(#1022 照舊)", () => {
    renderCell(false, true);
    const button = screen.getByRole("button", { name: "不可預約" });
    expect(button.className).toContain("cursor-pointer");
  });
});
