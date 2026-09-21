// 對應規格書「服務人員管理優化與硬刪除」§2.3:人員名單狀態篩選邏輯的單元測試。

import { describe, expect, it } from "vitest";

import {
  countStaffByFilter,
  matchesStaffListFilter,
  STAFF_LIST_FILTER_TABS,
} from "./staffListLogic";

const activeListed = { status: "active", is_listed: true };
const activeUnlisted = { status: "active", is_listed: false };
const removed = { status: "removed", is_listed: true };
const removedUnlisted = { status: "removed", is_listed: false };

describe("matchesStaffListFilter", () => {
  it("「全部」對任何狀態的人員都回傳 true", () => {
    expect(matchesStaffListFilter(activeListed, "all")).toBe(true);
    expect(matchesStaffListFilter(activeUnlisted, "all")).toBe(true);
    expect(matchesStaffListFilter(removed, "all")).toBe(true);
  });

  it("「未上架」只比對 status=active 且 is_listed=false", () => {
    expect(matchesStaffListFilter(activeUnlisted, "unlisted")).toBe(true);
    expect(matchesStaffListFilter(activeListed, "unlisted")).toBe(false);
    // 已移除的人員即使 is_listed=false,也不屬於「未上架」這個分類(移除跟上架狀態是兩回事)。
    expect(matchesStaffListFilter(removedUnlisted, "unlisted")).toBe(false);
  });

  it("「已上架」只比對 status=active 且 is_listed=true", () => {
    expect(matchesStaffListFilter(activeListed, "listed")).toBe(true);
    expect(matchesStaffListFilter(activeUnlisted, "listed")).toBe(false);
    expect(matchesStaffListFilter(removed, "listed")).toBe(false);
  });

  it("「已移除」只比對 status=removed,不管 is_listed 的值", () => {
    expect(matchesStaffListFilter(removed, "removed")).toBe(true);
    expect(matchesStaffListFilter(removedUnlisted, "removed")).toBe(true);
    expect(matchesStaffListFilter(activeListed, "removed")).toBe(false);
  });
});

describe("countStaffByFilter", () => {
  it("「全部」等於未篩選前的完整清單筆數,其餘分類各自正確加總", () => {
    const list = [activeListed, activeListed, activeUnlisted, removed, removedUnlisted];
    const counts = countStaffByFilter(list);
    expect(counts.all).toBe(5);
    expect(counts.listed).toBe(2);
    expect(counts.unlisted).toBe(1);
    expect(counts.removed).toBe(2);
  });

  it("空清單時四個分類都是 0", () => {
    const counts = countStaffByFilter([]);
    expect(counts).toEqual({ all: 0, unlisted: 0, listed: 0, removed: 0 });
  });
});

describe("STAFF_LIST_FILTER_TABS", () => {
  it("四個分類依序為全部/未上架/已上架/已移除", () => {
    expect(STAFF_LIST_FILTER_TABS.map((t) => t.value)).toEqual([
      "all",
      "unlisted",
      "listed",
      "removed",
    ]);
    expect(STAFF_LIST_FILTER_TABS.map((t) => t.label)).toEqual([
      "全部",
      "未上架",
      "已上架",
      "已移除",
    ]);
  });
});
