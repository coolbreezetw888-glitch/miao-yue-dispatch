// 對應規格書 4.3:客服管理頁(新路由 /app/agents)。
// 清單(姓名/暱稱/email/狀態徽章)+ 新增表單(呼叫 Edge Function)+ 移除按鈕。

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { fetchMerchantAgents, inviteMerchantAgent, removeMerchantAgent } from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
import { AGENT_STATUS_LABELS, type AgentStatus } from "./types";

const agentListQueryKey = (merchantId: string) =>
  ["staff-agent-module", "agent-admin-list", merchantId] as const;

function statusBadgeVariant(status: AgentStatus): "default" | "secondary" | "destructive" {
  if (status === "active") return "default";
  if (status === "invited") return "secondary";
  return "destructive";
}

function AgentListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: agents, isLoading } = useQuery({
    queryKey: agentListQueryKey(merchantId),
    queryFn: () => fetchMerchantAgents(merchantId),
  });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: agentListQueryKey(merchantId) });
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !name.trim()) return;
    setInviting(true);
    try {
      const result = await inviteMerchantAgent({ merchantId, email, name, nickname, phone });
      await refetch();
      setEmail("");
      setName("");
      setNickname("");
      setPhone("");
      if (result.alreadyHadAccount) {
        toast.success("已加為客服", {
          description: "這個 email 已經有秒約帳號,已直接加為客服,對方下次登入就能看到這間店。",
        });
      } else {
        toast.success("邀請信已寄出", {
          description: "請提醒對方檢查信箱(含垃圾郵件夾),點連結設定密碼後即可登入。",
        });
      }
    } catch (err) {
      toast.error("邀請失敗", { description: getErrorMessage(err) });
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(agentId: string) {
    setRemovingId(agentId);
    try {
      await removeMerchantAgent(agentId);
      await refetch();
      toast.success("已移除客服");
    } catch (err) {
      toast.error("移除失敗", { description: getErrorMessage(err) });
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">客服管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的客服名單與邀請</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>邀請新客服</CardTitle>
          <CardDescription>
            對方會收到一封邀請信,點連結設定密碼後即可登入;如果對方已經有秒約帳號,會直接加為客服。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="agent-email">Email *</Label>
              <Input
                id="agent-email"
                type="email"
                className="mt-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="agent-name">姓名 *</Label>
              <Input
                id="agent-name"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="agent-nickname">暱稱</Label>
              <Input
                id="agent-nickname"
                className="mt-2"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="agent-phone">電話</Label>
              <Input
                id="agent-phone"
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={inviting || !email.trim() || !name.trim()}>
                {inviting ? "送出中⋯" : "送出邀請"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>客服名單</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !agents || agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前還沒有任何客服。</p>
          ) : (
            <ul className="space-y-2">
              {agents.map((agent) => (
                <li
                  key={agent.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                      {agent.nickname ? `(${agent.nickname})` : ""}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{agent.invited_email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={statusBadgeVariant(agent.status as AgentStatus)}>
                      {AGENT_STATUS_LABELS[agent.status as AgentStatus]}
                    </Badge>
                    {agent.status !== "removed" ? (
                      <>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/app/agents/${agent.id}/permissions`}>權限設定</Link>
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm" disabled={removingId === agent.id}>
                              移除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>確定要移除這位客服嗎?</AlertDialogTitle>
                              <AlertDialogDescription>
                                移除後對方無法再看到這間店的任何資料,但對方的秒約帳號本身不受影響,
                                資料採軟刪除,之後仍可查詢紀錄。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleRemove(agent.id)}>
                                確定移除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function AgentListPage() {
  return (
    <RequireMerchantAdmin>
      <AgentListInner />
    </RequireMerchantAdmin>
  );
}
