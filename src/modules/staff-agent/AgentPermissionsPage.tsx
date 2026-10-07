// 對應規格書 4.4:客服權限勾選畫面(新路由 /app/agents/:agentId/permissions)。
// 針對某位客服,列出 1.4 節的 section_key 初稿清單,逐項提供開關。

import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { LoadingSkeleton, SwitchRow } from "@/components/patterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { fetchAgentPermissions, fetchMerchantAgents, setAgentPermission } from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
// ⚠️ 刻意用 visibleAgentPermissionSections() 而不是直接用 AGENT_PERMISSION_SECTIONS:
//    後者是完整定義,包含「刻意隱藏、不顯示在這個畫面上」的項目(2026-09-24:排班一覽),
//    詳見 types.ts 裡 AgentPermissionSectionDef.hidden 的說明。
import { visibleAgentPermissionSections } from "./types";

const permissionsQueryKey = (agentId: string) =>
  ["staff-agent-module", "agent-permissions", agentId] as const;

function AgentPermissionsInner() {
  const { agentId } = useParams<{ agentId: string }>();
  const { merchant } = useCurrentMerchant();
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: ["staff-agent-module", "agent-admin-list", merchant?.id ?? ""],
    queryFn: () => fetchMerchantAgents(merchant!.id),
    enabled: Boolean(merchant?.id),
  });
  const agent = agents?.find((a) => a.id === agentId);

  const { data: permissions, isLoading } = useQuery({
    queryKey: permissionsQueryKey(agentId ?? ""),
    queryFn: () => fetchAgentPermissions(agentId as string),
    enabled: Boolean(agentId),
  });

  const grantedMap = new Map((permissions ?? []).map((p) => [p.section_key, p.granted]));

  async function handleToggle(sectionKey: string, granted: boolean) {
    if (!agentId) return;
    try {
      await setAgentPermission(agentId, sectionKey, granted);
      await queryClient.invalidateQueries({ queryKey: permissionsQueryKey(agentId) });
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/agents" className="text-sm text-muted-foreground hover:underline">
          ← 返回客服名單
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
          {agent ? `${agent.name} 的權限設定` : "權限設定"}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>後台功能區塊</CardTitle>
          <CardDescription>
            逐項開放這位客服能操作的功能區塊，關掉的區塊會直接看不到對應的入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
            <LoadingSkeleton variant="lines" rows={5} />
          ) : (
            /* #990 第 11 批:每項的說明收進名稱旁的 `?`(SwitchRow popover 模式),版面只剩名稱 + `?` + 開關。
               保留 <ul><li> 結構(e2e 用 `main ul > li` 數列數);SwitchRow 也讓每個開關有正確的無障礙名稱。 */
            <ul className="space-y-2">
              {visibleAgentPermissionSections().map((section) => (
                <li key={section.key}>
                  <SwitchRow
                    id={`agent-permission-switch-${section.key}`}
                    className="rounded-md px-3 py-2"
                    title={section.label}
                    description={section.description}
                    descriptionMode="popover"
                    helpLabel={`說明：${section.label}`}
                    helpTriggerTestId={`permission-help-trigger-${section.key}`}
                    helpPopoverTestId="permission-help-popover"
                    titleTestId="permission-switch-title"
                    checked={grantedMap.get(section.key) ?? false}
                    onCheckedChange={(v) => handleToggle(section.key, v)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function AgentPermissionsPage() {
  return (
    <RequireMerchantAdmin>
      <AgentPermissionsInner />
    </RequireMerchantAdmin>
  );
}
