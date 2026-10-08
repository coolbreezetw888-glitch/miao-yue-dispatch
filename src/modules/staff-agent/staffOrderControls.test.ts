// 客戶端第 3 批(C3-H03):服務人員順位 ↑↓ 的顯示 / 停用規則。
import { describe, expect, it } from "vitest";

import { STAFF_ORDER_HELP_TEXT, staffOrderControls } from "./staffListLogic";

const list = [
  { id: "a", status: "active" },
  { id: "x", status: "removed" },
  { id: "b", status: "active" },
  { id: "c", status: "active" },
  { id: "y", status: "removed" },
];

describe("staffOrderControls", () => {
  it("全部:在職的人有箭頭;最上那位不能上、最下那位不能下(已移除的不算)", () => {
    const m = staffOrderControls(list, "all");
    expect(m.get("a")).toEqual({ show: true, canMoveUp: false, canMoveDown: true });
    expect(m.get("b")).toEqual({ show: true, canMoveUp: true, canMoveDown: true });
    expect(m.get("c")).toEqual({ show: true, canMoveUp: true, canMoveDown: false });
    expect(m.get("x")).toEqual({ show: false, canMoveUp: false, canMoveDown: false });
  });

  it("有篩選時一律不顯示箭頭(避免跟看不到的人交換)", () => {
    for (const filter of ["listed", "unlisted", "removed"] as const) {
      for (const v of staffOrderControls(list, filter).values()) expect(v.show).toBe(false);
    }
  });

  it("只有一位在職 ⇒ 兩顆都停用", () => {
    expect(staffOrderControls([{ id: "a", status: "active" }], "all").get("a")).toEqual({
      show: true,
      canMoveUp: false,
      canMoveDown: false,
    });
  });

  it("說明文字逐字", () => {
    expect(STAFF_ORDER_HELP_TEXT).toBe(
      "順位會影響：客人選「不指定」時優先排給誰、預約頁與行事曆的排列順序。",
    );
  });
});
