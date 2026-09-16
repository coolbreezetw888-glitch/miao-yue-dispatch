// 對應規格書 4.4:客服權限勾選畫面(新路由 /app/agents/:agentId/permissions)。
// 針對某位客服,列出 1.4 節的 section_key 初稿清單,逐項提供開關。

import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { fetchAgentPermissions, fetchMerchantAgents, setAgentPermission } from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
import { AGENT_PERMISSION_SECTIONS } from "./types";

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
            這是先設定,不是現在就能用——大部分區塊對應的實際功能頁面都還沒開發,對應的功能上線後才會實際生效。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <ul className="space-y-2">
              {AGENT_PERMISSION_SECTIONS.map((section) => (
                <li
                  key={section.key}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{section.label}</p>
                    <p className="text-xs text-muted-foreground">{section.description}</p>
                  </div>
                  <Switch
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
