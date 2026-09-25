// agentListLogic.ts 的單元測試(SPECS-INDEX #797:客服名單「全部 / 在職 / 已移除」分頁籤的篩選邏輯)。
// 規格書第五節說得很明白:客服這邊原本沒有純函式可測,「如果之後做了 #797,那時才會產生
// agentListLogic.ts 這類純函式,那時候再補 vitest 才有意義」——現在就是那時候。

import { describe, expect, it } from "vitest";

import {
  AGENT_LIST_FILTER_TABS,
  countAgentsByFilter,
  matchesAgentListFilter,
} from "./agentListLogic";

const active = { status: "active" };
const invited = { status: "invited" };
const removed = { status: "removed" };

describe("matchesAgentListFilter", () => {
  it("「全部」對任何狀態的客服都回傳 true", () => {
    expect(matchesAgentListFilter(active, "all")).toBe(true);
    expect(matchesAgentListFilter(invited, "all")).toBe(true);
    expect(matchesAgentListFilter(removed, "all")).toBe(true);
  });

  it("「在職」= status 不是 removed:已啟用與邀請中都算在職,已移除不算", () => {
    expect(matchesAgentListFilter(active, "active")).toBe(true);
    // 邀請信已寄出、本人還沒登入的人也算「在職」——分頁籤的目的只是把已移除的人隔開,
    // 開通進度由每一列的狀態徽章表達,不重複做成分頁籤(見 agentListLogic.ts 檔頭)。
    expect(matchesAgentListFilter(invited, "active")).toBe(true);
    expect(matchesAgentListFilter(removed, "active")).toBe(false);
  });

  it("「已移除」只比對 status=removed", () => {
    expect(matchesAgentListFilter(removed, "removed")).toBe(true);
    expect(matchesAgentListFilter(active, "removed")).toBe(false);
    expect(matchesAgentListFilter(invited, "removed")).toBe(false);
  });
});

describe("countAgentsByFilter", () => {
  it("空名單三個分類都是 0", () => {
    expect(countAgentsByFilter([])).toEqual({ all: 0, active: 0, removed: 0 });
  });

  it("混合名單:all = 總數,active + removed = 總數(每個人恰好落在其中一邊)", () => {
    const list = [active, invited, removed, active, removed, removed];
    const counts = countAgentsByFilter(list);
    expect(counts).toEqual({ all: 6, active: 3, removed: 3 });
    expect(counts.active + counts.removed).toBe(counts.all);
  });
});

describe("AGENT_LIST_FILTER_TABS", () => {
  it("恰好三顆:全部 / 在職 / 已移除,順序固定(對應 #792:客服沒有「上架」這個概念,不會有未上架/已上架)", () => {
    expect(AGENT_LIST_FILTER_TABS.map((t) => t.value)).toEqual(["all", "active", "removed"]);
    expect(AGENT_LIST_FILTER_TABS.map((t) => t.label)).toEqual(["全部", "在職", "已移除"]);
    // 守住 #792 的決定:分頁籤上不可以出現「上架」字樣。
    for (const tab of AGENT_LIST_FILTER_TABS) {
      expect(tab.label).not.toContain("上架");
    }
  });
});
