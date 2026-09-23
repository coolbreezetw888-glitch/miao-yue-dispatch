// 模組 11(LINE 通知)§10.2(SPECS-INDEX #612)行銷通知會員選擇擴充——純函式測試。
// 涵蓋:依分類批量勾選只選中該分類且已綁定 LINE 的會員;排除清單正確從最終送出名單移除;
// 黑名單會員即使被單獨選擇或分類批量選中,最終送出名單依然自動排除。

import { describe, expect, it } from "vitest";

import {
  computeFinalRecipientIds,
  getTierMemberIds,
  isTierFullySelected,
  toggleTierSelection,
  type SelectableMember,
} from "./memberSelection";

const members: SelectableMember[] = [
  { id: "m1", tierId: "tier-vip", isBlacklisted: false },
  { id: "m2", tierId: "tier-vip", isBlacklisted: false },
  { id: "m3", tierId: "tier-general", isBlacklisted: false },
  { id: "m4", tierId: null, isBlacklisted: false },
  { id: "m5", tierId: "tier-vip", isBlacklisted: true }, // VIP 但同時是黑名單
];

describe("getTierMemberIds", () => {
  it("只回傳屬於這個等級的會員 id(不管是不是黑名單,分類批量選擇本身不排除黑名單——排除交給 computeFinalRecipientIds 處理)", () => {
    expect(getTierMemberIds(members, "tier-vip").sort()).toEqual(["m1", "m2", "m5"].sort());
    expect(getTierMemberIds(members, "tier-general")).toEqual(["m3"]);
    expect(getTierMemberIds(members, "tier-empty")).toEqual([]);
  });
});

describe("isTierFullySelected", () => {
  it("等級底下全部成員都在 selectedIds 裡才算已選取", () => {
    expect(isTierFullySelected(members, "tier-vip", ["m1", "m2", "m5"])).toBe(true);
    expect(isTierFullySelected(members, "tier-vip", ["m1", "m2"])).toBe(false);
  });

  it("空等級(沒有任何成員)一律回傳 false", () => {
    expect(isTierFullySelected(members, "tier-empty", [])).toBe(false);
  });
});

describe("toggleTierSelection", () => {
  it("勾選時把整批等級成員加進既有選取,不影響其他已選取的會員", () => {
    const result = toggleTierSelection(members, "tier-vip", ["m4"], true);
    expect(new Set(result)).toEqual(new Set(["m4", "m1", "m2", "m5"]));
  });

  it("取消勾選時把整批等級成員從選取移除,不影響其他不屬於這個等級的既有選取", () => {
    const result = toggleTierSelection(members, "tier-vip", ["m1", "m2", "m5", "m3"], false);
    expect(result).toEqual(["m3"]);
  });

  it("重複勾選同一等級不會造成重複 id", () => {
    const first = toggleTierSelection(members, "tier-vip", [], true);
    const second = toggleTierSelection(members, "tier-vip", first, true);
    expect(second.length).toBe(new Set(second).size);
  });
});

describe("computeFinalRecipientIds(§10.2 核心規則)", () => {
  it("依分類批量勾選,最終名單正確只包含該分類且已綁定 LINE(members 本身已經是 line_bound 名單)的會員,黑名單成員自動排除", () => {
    const selected = toggleTierSelection(members, "tier-vip", [], true); // m1, m2, m5
    const finalIds = computeFinalRecipientIds(members, selected, []);
    expect(new Set(finalIds)).toEqual(new Set(["m1", "m2"])); // m5 是黑名單,自動排除
  });

  it("排除清單正確從最終送出名單移除", () => {
    const finalIds = computeFinalRecipientIds(members, ["m1", "m2", "m3"], ["m2"]);
    expect(finalIds).toEqual(["m1", "m3"]);
  });

  it("黑名單會員即使被單獨選擇選中,最終送出名單依然自動排除,不需要額外出現在手動排除清單裡", () => {
    const finalIds = computeFinalRecipientIds(members, ["m5"], []);
    expect(finalIds).toEqual([]);
  });

  it("黑名單會員即使被分類批量選中,最終送出名單依然自動排除", () => {
    const selected = toggleTierSelection(members, "tier-vip", [], true);
    const finalIds = computeFinalRecipientIds(members, selected, []);
    expect(finalIds.includes("m5")).toBe(false);
  });

  it("待確認事項的保守做法:即使黑名單會員的 id 出現在『排除清單』裡被手動勾選,結果依然是排除(不會因為多此一舉的手動排除而改變結果,也不代表支援『取消排除』)", () => {
    const finalIds = computeFinalRecipientIds(members, ["m5"], ["m5"]);
    expect(finalIds).toEqual([]);
  });
});
