// SPECS-INDEX #797(規格書 .project/specs/客服編輯功能.md #797;2026-09-25 使用者裁決「選 A+C」):
// 客服管理頁(AgentListPage.tsx)名單狀態篩選用到的純函式邏輯。
//
// 抽成獨立檔案的理由跟 staffListLogic.ts 一模一樣:讓分頁籤的篩選/計數邏輯可以直接寫 Vitest,
// 不用整個渲染頁面元件。這支檔案刻意不 import 任何會建立 supabase client 的模組(api.ts / context.tsx),
// 只依賴 types.ts 這個純型別檔案。
//
// 【跟服務人員的分頁籤差在哪(規格書 §1.4 / #792 / #797)】
// 服務人員有四顆:全部 / 未上架 / 已上架 / 已移除。客服**沒有 is_listed(上架)這個概念**——
// 客服是內勤角色,不會被客戶挑選,merchant_agents 上也根本沒有這個欄位。所以客服只有三顆:
//   全部 / 在職 / 已移除
// 「在職」= status 不是 'removed'(包含 'active' 已啟用 與 'invited' 邀請信已寄出兩種)。
// 邀請中的人也算在職,因為這組分頁籤的目的只是把「已移除」的人從主名單隔開,不是再細分登入開通進度
// ——開通進度已經由每一列的狀態徽章(AGENT_STATUS_LABELS)在表達,不需要重複做成分頁籤。

import type { MerchantAgent } from "./types";

export type AgentListFilter = "all" | "active" | "removed";

export const AGENT_LIST_FILTER_TABS: { value: AgentListFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "active", label: "在職" },
  { value: "removed", label: "已移除" },
];

/** 三個分類的判斷邏輯——「全部」不篩選;「在職」= status <> removed(active + invited);
 * 「已移除」= status = removed。 */
export function matchesAgentListFilter(
  agent: Pick<MerchantAgent, "status">,
  filter: AgentListFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return agent.status !== "removed";
    case "removed":
      return agent.status === "removed";
    default:
      return true;
  }
}

/** 每個分類旁的人數(比照服務人員分頁籤的既有做法;all = 總筆數)。 */
export function countAgentsByFilter(
  agents: Pick<MerchantAgent, "status">[],
): Record<AgentListFilter, number> {
  const counts: Record<AgentListFilter, number> = {
    all: agents.length,
    active: 0,
    removed: 0,
  };
  for (const agent of agents) {
    if (matchesAgentListFilter(agent, "active")) counts.active += 1;
    if (matchesAgentListFilter(agent, "removed")) counts.removed += 1;
  }
  return counts;
}
