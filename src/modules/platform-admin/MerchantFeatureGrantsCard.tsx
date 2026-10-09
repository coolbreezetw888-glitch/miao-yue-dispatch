// SPECS-INDEX #1025 功能開關 FG1-U03 / FG1-U05:超級管理員「商家詳情」頁的「功能開關」卡。
// 規格書 .project/specs/功能開關.md(第 2 版)FG1-U03、FG1-U05(⚠️1)、⚠️4、第三輪 ①~③。
//
//   ・每列:功能名稱(`?` 說明)、開關、標籤;細部功能縮排列在主功能底下(①)。
//   ・標籤(屬性標籤,小灰):值 ≠ 這間店產業的預設 ⇒「跟產業預設不同」;細部功能而且主功能(草稿)關著 ⇒
//     開關變灰不能切 +「主功能關閉中」(值保留,T9)。
//   ・第三輪 ③:開關「先調整、按儲存才生效」。主功能打開時細部功能預設全部打開(②)。
//     按「儲存」⇒ 小卡窗列出這次的變更(關掉的附 off_impact;主功能關掉時多一句「底下的細部功能也會一起停用。」)
//     + 選填備註(⚠️4)⇒ 確認後一個 RPC(platform_set_merchant_features)= 一個資料庫交易,大項 + 細項同時生效。
//     變更紀錄照舊每項一筆。未儲存就離開 ⇒ 提醒(useLeaveGuard)。
//   ・下方摺疊區「最近變更紀錄」(最近 20 筆)。
// 寫入一律走 platform_set_merchant_features(函式第一行檢查超級管理員,X1)。

import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

import {
  AttributeTag,
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  ErrorState,
  FieldInput,
  FormField,
  HelpPopover,
  LoadingSkeleton,
  useFormDirty,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatTaipeiDateTime } from "@/modules/members/memberPointsSettingsLogic";

import {
  platformFetchMerchantFeatures,
  platformListMerchantFeatureLogs,
  platformSetMerchantFeatures,
} from "./api";
import {
  draftChanges,
  featureLogChangeText,
  featureSwitchValue,
  hasChildFeatures,
  isLockedByParent,
  toggleDraft,
} from "./featureDisplay";
import { getErrorMessage } from "./getErrorMessage";
import { useLeaveGuard } from "./useLeaveGuard";

const NOTE_MAX = 200;
const SAVE_FORM_ID = "merchant-feature-save-form";

const platformMerchantFeaturesQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-features", merchantId] as const;
const featureLogsQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-feature-logs", merchantId] as const;

export function MerchantFeatureGrantsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteDirty = useFormDirty(note);
  // 每次打開小卡窗 +1 當 key(skill 三:關掉後很快又打開要重新掛載)。
  const [dialogSeq, setDialogSeq] = useState(0);
  const [logsOpen, setLogsOpen] = useState(false);

  const featuresQuery = useQuery({
    queryKey: platformMerchantFeaturesQueryKey(merchantId),
    queryFn: () => platformFetchMerchantFeatures(merchantId),
  });
  const logsQuery = useQuery({
    queryKey: featureLogsQueryKey(merchantId),
    queryFn: () => platformListMerchantFeatureLogs(merchantId, 20),
    enabled: logsOpen,
  });

  const rows = useMemo(() => featuresQuery.data ?? [], [featuresQuery.data]);
  const original = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.feature_key, featureSwitchValue(r)])),
    [rows],
  );
  const current = useMemo(() => ({ ...original, ...draft }), [original, draft]);
  const changes = draftChanges(
    rows.map((r) => r.feature_key),
    original,
    current,
  );
  const hasChanges = changes.length > 0;

  // 儲存中 dirty 一定要 false(skill 三之六第 5 點)。
  const { leaveDialog } = useLeaveGuard(hasChanges && !saving);

  function openConfirm() {
    setNote("");
    noteDirty.markClean("");
    setDialogSeq((n) => n + 1);
    setConfirmOpen(true);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!hasChanges || note.trim().length > NOTE_MAX) return;
    noteDirty.markClean(note);
    setSaving(true);
    try {
      await platformSetMerchantFeatures({
        merchantId,
        changes: changes.map((c) => ({ feature_key: c.key, enabled: c.enabled })),
        note: note.trim() || null,
      });
      toast.success("已儲存功能開關。");
      setDraft({});
      setConfirmOpen(false);
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: platformMerchantFeaturesQueryKey(merchantId) }),
        queryClient.invalidateQueries({ queryKey: featureLogsQueryKey(merchantId) }),
      ]);
    }
  }

  const nameOf = (key: string) => rows.find((r) => r.feature_key === key)?.name ?? key;

  return (
    <Card data-testid="merchant-feature-grants-card">
      <CardHeader>
        <CardTitle>功能開關</CardTitle>
        <CardDescription>
          這間店開了哪些功能。關掉的功能，商家後台會整個看不到。調整完按「儲存」才會生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {featuresQuery.isLoading ? (
          /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
          <LoadingSkeleton variant="lines" rows={3} />
        ) : featuresQuery.isError ? (
          <ErrorState
            title="讀不到這間店的功能開關"
            reason={getErrorMessage(featuresQuery.error)}
            onRetry={() => void featuresQuery.refetch()}
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => {
              const value = current[row.feature_key] === true;
              const locked = isLockedByParent(row.parent_key, current);
              const differs = row.preset_enabled !== null && value !== row.preset_enabled;
              const changed = value !== original[row.feature_key];
              return (
                <li
                  key={row.feature_key}
                  data-testid={`merchant-feature-row-${row.feature_key}`}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3",
                    row.parent_key !== null && "ml-5",
                    locked && "opacity-60",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                        {row.name}
                      </span>
                      <HelpPopover
                        label={`說明：${row.name}`}
                        triggerTestId={`merchant-feature-help-${row.feature_key}`}
                        popoverTestId="merchant-feature-help-popover"
                      >
                        {row.description}
                      </HelpPopover>
                    </div>
                    {differs || locked || changed ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {changed ? (
                          <AttributeTag data-testid={`merchant-feature-changed-${row.feature_key}`}>
                            尚未儲存
                          </AttributeTag>
                        ) : null}
                        {differs ? (
                          <AttributeTag data-testid={`merchant-feature-differs-${row.feature_key}`}>
                            跟產業預設不同
                          </AttributeTag>
                        ) : null}
                        {locked ? (
                          <AttributeTag
                            data-testid={`merchant-feature-parent-off-${row.feature_key}`}
                          >
                            主功能關閉中
                          </AttributeTag>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <Switch
                    aria-label={`這間店的「${row.name}」`}
                    data-testid={`merchant-feature-switch-${row.feature_key}`}
                    checked={value}
                    disabled={locked || saving}
                    onCheckedChange={(checked) =>
                      setDraft((d) =>
                        toggleDraft({ ...original, ...d }, row.feature_key, checked, rows),
                      )
                    }
                    className="shrink-0 data-[state=checked]:bg-brand"
                  />
                </li>
              );
            })}
          </ul>
        )}

        {hasChanges ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3.5 py-3"
            data-testid="merchant-feature-unsaved"
          >
            <p className="text-sm font-semibold text-foreground">尚未儲存變更</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="neutral"
                size="card"
                disabled={saving}
                onClick={() => setDraft({})}
              >
                放棄變更
              </Button>
              <Button
                type="button"
                variant="primary"
                size="card"
                data-testid="merchant-feature-save"
                disabled={saving}
                onClick={openConfirm}
              >
                儲存
              </Button>
            </div>
          </div>
        ) : null}

        {/* FG1-U05(⚠️1):最近變更紀錄(摺疊區,展開才讀)。 */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between gap-2 text-left text-sm font-semibold text-foreground"
            aria-expanded={logsOpen}
            data-testid="merchant-feature-logs-toggle"
            onClick={() => setLogsOpen((v) => !v)}
          >
            最近變更紀錄
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 shrink-0 transition-transform", logsOpen && "rotate-180")}
            />
          </button>
          {logsOpen ? (
            <div className="mt-2" data-testid="merchant-feature-logs">
              {logsQuery.isLoading ? (
                <LoadingSkeleton variant="lines" rows={2} />
              ) : logsQuery.isError ? (
                <ErrorState
                  title="讀不到變更紀錄"
                  reason={getErrorMessage(logsQuery.error)}
                  onRetry={() => void logsQuery.refetch()}
                />
              ) : (logsQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">還沒有變更紀錄。</p>
              ) : (
                <ul className="space-y-2">
                  {(logsQuery.data ?? []).map((log, index) => (
                    <li
                      key={`${log.created_at}-${log.feature_key}-${index}`}
                      className="rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-semibold text-foreground">{log.feature_name}</span>
                        <span className="tabular-nums text-foreground">
                          {featureLogChangeText(log.old_enabled, log.new_enabled)}
                        </span>
                        {log.is_bulk ? <AttributeTag>批次</AttributeTag> : null}
                      </div>
                      <p className="mt-0.5 break-all text-xs text-muted-foreground tabular-nums">
                        {formatTaipeiDateTime(log.created_at)}・{log.changed_by_email ?? "—"}
                      </p>
                      {log.note ? (
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">
                          備註：{log.note}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>

      <CardDialog
        key={dialogSeq}
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <CardDialogContent
          dirty={noteDirty.dirty && !saving}
          data-testid="merchant-feature-save-dialog"
        >
          <CardDialogHeader>
            <CardDialogTitle>確定要儲存這些變更？</CardDialogTitle>
            <CardDialogDescription>按「儲存」後，下面的變更會一次同時生效。</CardDialogDescription>
          </CardDialogHeader>
          <ul
            className="space-y-3 text-sm text-foreground"
            data-testid="merchant-feature-save-list"
          >
            {changes.map((c) => {
              const row = rows.find((r) => r.feature_key === c.key);
              return (
                <li key={`change-${c.key}`} className="rounded-md border border-border px-3 py-2">
                  <p className="font-semibold">
                    {c.enabled ? `開啟「${nameOf(c.key)}」` : `關閉「${nameOf(c.key)}」`}
                  </p>
                  {!c.enabled && row ? (
                    <p className="mt-0.5 text-muted-foreground">
                      {row.off_impact}
                      {hasChildFeatures(row, rows) ? "底下的細部功能也會一起停用。" : null}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <form id={SAVE_FORM_ID} onSubmit={handleSave} className="flex flex-col gap-4">
            <FormField
              label="備註(選填)"
              htmlFor="merchant-feature-save-note"
              counter={{ value: note.trim().length, max: NOTE_MAX }}
              error={note.trim().length > NOTE_MAX ? `備註最多 ${NOTE_MAX} 字。` : null}
            >
              <FieldInput
                id="merchant-feature-save-note"
                value={note}
                placeholder="例如：試用到期"
                onChange={(e) => setNote(e.target.value)}
              />
            </FormField>
          </form>
          <CardDialogFooter>
            <CardDialogClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </CardDialogClose>
            <Button
              type="submit"
              form={SAVE_FORM_ID}
              variant="primary"
              size="touch"
              data-testid="merchant-feature-save-confirm"
              disabled={saving || note.trim().length > NOTE_MAX}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>
      {leaveDialog}
    </Card>
  );
}
