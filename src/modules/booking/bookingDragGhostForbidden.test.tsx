// SPECS-INDEX #1052 H2-10:拖到不能放的格子時,殘影變半透明,底下欄位的紅框(ring-destructive)才看得到。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookingDragGhost, type DragGhostModel } from "./calendarBookingDrag";

const BASE: DragGhostModel = {
  left: 0,
  top: 0,
  width: 120,
  height: 40,
  blockStyle: {},
  label: "王小明",
  hint: null,
  forbidden: false,
  lifted: false,
  committing: false,
};

afterEach(() => cleanup());

describe("BookingDragGhost × 不能放(#1052 H2-10)", () => {
  it("不能放 ⇒ 殘影半透明 + 紅邊", () => {
    render(<BookingDragGhost ghost={{ ...BASE, forbidden: true }} />);
    const body = screen.getByTestId("booking-drag-ghost").firstElementChild!;
    expect(body.className).toContain("opacity-60");
    expect(body.className).toContain("border-destructive");
  });

  it("可以放 ⇒ 照舊不透明", () => {
    render(<BookingDragGhost ghost={BASE} />);
    const body = screen.getByTestId("booking-drag-ghost").firstElementChild!;
    expect(body.className).not.toContain("opacity-60");
    expect(body.className).toContain("border-brand");
  });
});
