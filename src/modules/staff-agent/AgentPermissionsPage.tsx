// 對應規格書 4.4:客服權限勾選畫面(新路由 /app/agents/:agentId/permissions)。
// 針對某位客服,列出 1.4 節的 section_key 初稿清單,逐項提供開關。
//
// 第 11 批 E(#992,2026-10-07):相依權限「打開時提示、按確定就一併開啟」。
//   規格書 .project/specs/改掛會員與預設文案全形-第11批.md §11.4~§11.8;判斷與文案在 agentPermissionDependencies.ts。
//   ・按下開關的當下**不切換**:先算閉包,不是空的就開小卡窗(取消 / 只開這一個 / 一起開啟),開關維持原狀。
//   ・寫入一律走 setAgentPermissions(一次呼叫 = 一個交易,失敗全退),單一切換也走同一支。
//   ・寫入中:這次所有變更先放進 pending(樂觀值,開關立刻顯示新狀態),同時整頁開關 disabled ——
//     避免上一筆還沒存完時,用舊狀態算出錯的閉包。成功 ⇒ 重抓後清空 pending;失敗 ⇒ 清空 pending(全部回到資料庫的值)。
//   ・「開著但需要的沒開」⇒ 該權限下方常駐黃色 `!`(舊資料與商家按「只開這一個」做出來的狀態一視同仁)。

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  LoadingSkeleton,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { MERCHANT_FEATURE_KEYS, useMerchantFeatures } from "@/modules/merchant/features";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  AGENT_PERMISSION_GRANT_EFFECTS,
  AGENT_PERMISSION_REVOKE_EFFECTS,
  DEPENDENCY_CONFIRM_COPY,
  keysToDisableWith,
  keysToEnableWith,
  legacyDependencyNotes,
} from "./agentPermissionDependencies";
import {
  fetchAgentPermissions,
  fetchMerchantAgents,
  setAgentPermissions,
  type AgentPermissionChange,
} from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
// ⚠️ 刻意用 visibleAgentPermissionSections() 而不是直接用 AGENT_PERMISSION_SECTIONS:
//    後者是完整定義,包含「刻意隱藏、不顯示在這個畫面上」的項目(2026-09-24:排班一覽),
//    詳見 types.ts 裡 AgentPermissionSectionDef.hidden 的說明。
import { AGENT_PERMISSION_SECTIONS, visibleAgentPermissionSections } from "./types";

const permissionsQueryKey = (agentId: string) =>
  ["staff-agent-module", "agent-permissions", agentId] as const;

/** 三顆按鈕:手機由上到下「主要 / 只開這一個 / 取消」整條寬;電腦一列三顆等寬(skill 二之三)。
 *  只套在這一個小卡窗,不改 CARD_FOOTER_CLASS(其他小卡窗不受影響)。
 *  🔴 手機直排時要把 CARD_FOOTER_CLASS 的 `[&>*]:flex-1` 蓋成 flex-none:直排 + flex-basis 0 會把按鈕高度
 *     壓扁成一行字高(e2e-local 375 實測 24.5px),不是 44px。 */
const THREE_BUTTON_FOOTER_CLASS =
  "flex-col-reverse items-stretch [&>*]:flex-none sm:flex-row sm:items-center sm:[&>*]:flex-1 sm:[&>*]:px-3";

const SECTION_LABELS = new Map(AGENT_PERMISSION_SECTIONS.map((s) => [s.key, s.label]));
const HIDDEN_KEYS = new Set(AGENT_PERMISSION_SECTIONS.filter((s) => s.hidden).map((s) => s.key));
const isHidden = (key: string) => HIDDEN_KEYS.has(key);

interface DependencyConfirm {
  mode: "enable" | "disable";
  key: string;
  others: string[];
}

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

  const {
    data: permissions,
    isLoading,
    isError,
  } = useQuery({
    queryKey: permissionsQueryKey(agentId ?? ""),
    queryFn: () => fetchAgentPermissions(agentId as string),
    enabled: Boolean(agentId),
  });

  const grantedMap = new Map((permissions ?? []).map((p) => [p.section_key, p.granted]));
  /** 寫入中的樂觀值(null = 沒有在寫入)。 */
  const [pending, setPending] = useState<Map<string, boolean> | null>(null);
  const [confirm, setConfirm] = useState<DependencyConfirm | null>(null);
  /** 每次打開小卡窗 +1,當成 CardAlertDialog 的 key:上一次關閉時還在播退場動畫的節點直接丟掉、整組重新掛載。
   *  🔴 不加的話,連續「關掉 → 很快又打開」時,上一次的 Content 節點還留在 body、新的遮罩被插在它後面,
   *     遮罩疊在小卡窗上面 ⇒ 三顆按鈕都點不到(e2e-local 1280 實測重現)。 */
  const [dialogSeq, setDialogSeq] = useState(0);
  const writing = pending !== null;
  // 權限清單讀不到時不猜:不顯示相依提醒、不開小卡窗(沿用頁面既有行為)。
  const dependencyAware = !isLoading && !isError && permissions !== undefined;

  const effective = (key: string): boolean =>
    pending?.has(key) ? pending.get(key)! : (grantedMap.get(key) ?? false);

  async function commit(changes: AgentPermissionChange[]) {
    if (!agentId || changes.length === 0) return;
    setPending(new Map(changes.map((c) => [c.sectionKey, c.granted])));
    try {
      await setAgentPermissions(agentId, changes);
      await queryClient.invalidateQueries({ queryKey: permissionsQueryKey(agentId) });
    } catch (err) {
      toast.error("設定失敗", { description: `這次的變更都沒有套用。${getErrorMessage(err)}` });
    } finally {
      setPending(null);
    }
  }

  function handleToggle(sectionKey: string, next: boolean) {
    if (!agentId || writing) return;
    const others = !dependencyAware
      ? []
      : next
        ? keysToEnableWith(sectionKey, effective, isHidden)
        : keysToDisableWith(sectionKey, effective, isHidden);
    if (others.length === 0) {
      void commit([{ sectionKey, granted: next }]);
      return;
    }
    setDialogSeq((n) => n + 1);
    setConfirm({ mode: next ? "enable" : "disable", key: sectionKey, others });
  }

  function confirmAll() {
    if (!confirm) return;
    const granted = confirm.mode === "enable";
    const changes: AgentPermissionChange[] = [
      { sectionKey: confirm.key, granted },
      ...confirm.others.map((k) => ({ sectionKey: k, granted })),
    ];
    setConfirm(null);
    void commit(changes);
  }

  function confirmOnlyThis() {
    if (!confirm) return;
    const change: AgentPermissionChange = {
      sectionKey: confirm.key,
      granted: confirm.mode === "enable",
    };
    setConfirm(null);
    void commit([change]);
  }

  // SPECS-INDEX #1025 FG1-U06 第 4 點:平台沒開通「報表匯出中心」⇒ 那一個權限開關整列不顯示
  // (值保留不改 —— T9,重新開通後原值直接生效)。讀取中 / 讀取失敗先不顯示這一列。
  const { hasFeature } = useMerchantFeatures();
  const isSectionFeatureVisible = (sectionKey: string): boolean =>
    sectionKey !== "report_export" || hasFeature(MERCHANT_FEATURE_KEYS.reportExport) === true;

  const copy = confirm ? DEPENDENCY_CONFIRM_COPY[confirm.mode] : null;
  const effects =
    confirm?.mode === "disable" ? AGENT_PERMISSION_REVOKE_EFFECTS : AGENT_PERMISSION_GRANT_EFFECTS;

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
               保留 <ul><li> 結構(e2e 用 `main ul > li` 數列數);SwitchRow 也讓每個開關有正確的無障礙名稱。
               第 11 批 E:相依提醒放在 SwitchRow 的 children 插槽(仍在同一個 li 內,列數不變)。 */
            <ul className="space-y-2">
              {visibleAgentPermissionSections()
                .filter((section) => isSectionFeatureVisible(section.key))
                .map((section) => {
                  const notes = dependencyAware
                    ? legacyDependencyNotes(section.key, effective, isHidden)
                    : [];
                  return (
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
                        checked={effective(section.key)}
                        disabled={writing}
                        onCheckedChange={(v) => handleToggle(section.key, v)}
                      >
                        {notes.length > 0 ? (
                          /* skill 二:「現在的狀態跟你以為的不一樣」⇒ 常駐黃色 `!`(比照 #977,不用紅色)。 */
                          <AlertNote data-testid={`permission-dependency-note-${section.key}`}>
                            {notes.map((note) => (
                              <p key={note}>{note}</p>
                            ))}
                          </AlertNote>
                        ) : null}
                      </SwitchRow>
                    </li>
                  );
                })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 第 11 批 E §11.5:相依權限小卡窗(比照服務人員 #977 的 order-switch-confirm,多一顆「只開 / 只關這一個」)。
          取消、按 Esc ⇒ 原本那個開關不動,什麼都不變,不呼叫任何 API。 */}
      <CardAlertDialog
        key={dialogSeq}
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
      >
        <CardAlertDialogContent data-testid="agent-permission-dependency-confirm">
          {confirm && copy ? (
            <>
              <CardAlertDialogHeader>
                <CardAlertDialogTitle>{copy.title(confirm.others.length)}</CardAlertDialogTitle>
                <CardAlertDialogDescription>
                  {copy.lead(SECTION_LABELS.get(confirm.key) ?? confirm.key)}
                </CardAlertDialogDescription>
              </CardAlertDialogHeader>
              <ul className="flex flex-col gap-2.5 text-[13px] leading-relaxed">
                {confirm.others.map((k) => (
                  <li
                    key={k}
                    data-testid={`agent-permission-dependency-item-${k}`}
                    className="break-words"
                  >
                    <strong className="font-semibold text-foreground">
                      {SECTION_LABELS.get(k) ?? k}
                    </strong>
                    <p className="text-muted-foreground">{effects[k]}</p>
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.hint}</p>
              <CardAlertDialogFooter className={THREE_BUTTON_FOOTER_CLASS}>
                <CardAlertDialogCancel>{DEPENDENCY_CONFIRM_COPY.cancel}</CardAlertDialogCancel>
                <Button
                  type="button"
                  variant="neutral"
                  size="touch"
                  data-testid="agent-permission-dependency-only-this"
                  onClick={confirmOnlyThis}
                >
                  {copy.onlyThis}
                </Button>
                <CardAlertDialogAction onClick={confirmAll}>{copy.action}</CardAlertDialogAction>
              </CardAlertDialogFooter>
            </>
          ) : null}
        </CardAlertDialogContent>
      </CardAlertDialog>
    </main>
  );
}

export default function AgentPermissionsPage() {
  return (
    <RequireMerchantAdmin featureName="客服權限設定">
      <AgentPermissionsInner />
    </RequireMerchantAdmin>
  );
}
