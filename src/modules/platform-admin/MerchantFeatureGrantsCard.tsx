// SPECS-INDEX #1025 功能開關 FG1-U03 / FG1-U05:超級管理員「商家詳情」頁的「功能開關」卡。
// 規格書 .project/specs/功能開關.md(第 2 版)FG1-U03、FG1-U05(⚠️1)、⚠️4。
//
//   ・每列:功能名稱(`?` 說明)、開關(值 = granted)、標籤。
//   ・標籤(屬性標籤,小灰):值 ≠ 這間店產業的預設 ⇒「跟產業預設不同」;細部功能而且主功能關著 ⇒ 開關變灰不能切 +「主功能關閉中」。
//   ・打開:直接存,toast「已開啟「X」。」
//   ・關掉:先跳小卡窗(有選填備註欄 ⇒ 用 CardDialog + dirty,skill 三之六),內文 = off_impact;
//          主功能底下有細部功能時多一句「底下的細部功能也會一起停用。」
//   ・存完重新讀;下方摺疊區「最近變更紀錄」(最近 20 筆)。
// 寫入一律走 platform_set_merchant_feature(函式第一行檢查超級管理員,X1)。

import { useState, type FormEvent } from "react";
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
import type { MerchantFeatureRow } from "@/modules/merchant/features";
import { formatTaipeiDateTime } from "@/modules/members/memberPointsSettingsLogic";

import {
  platformFetchMerchantFeatures,
  platformListMerchantFeatureLogs,
  platformSetMerchantFeature,
} from "./api";
import {
  differsFromPreset,
  featureLogChangeText,
  featureSwitchValue,
  hasChildFeatures,
  isParentOff,
} from "./featureDisplay";
import { getErrorMessage } from "./getErrorMessage";

const NOTE_MAX = 200;
const CLOSE_FORM_ID = "merchant-feature-close-form";

const platformMerchantFeaturesQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-features", merchantId] as const;
const featureLogsQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-feature-logs", merchantId] as const;

export function MerchantFeatureGrantsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [closing, setClosing] = useState<MerchantFeatureRow | null>(null);
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

  const rows = featuresQuery.data ?? [];

  async function save(row: MerchantFeatureRow, enabled: boolean, noteText: string | null) {
    setSavingKey(row.feature_key);
    try {
      await platformSetMerchantFeature({
        merchantId,
        featureKey: row.feature_key,
        enabled,
        note: noteText,
      });
      toast.success(enabled ? `已開啟「${row.name}」。` : `已關閉「${row.name}」。`);
      return true;
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
      return false;
    } finally {
      setSavingKey(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: platformMerchantFeaturesQueryKey(merchantId) }),
        queryClient.invalidateQueries({ queryKey: featureLogsQueryKey(merchantId) }),
      ]);
    }
  }

  function handleSwitch(row: MerchantFeatureRow, next: boolean) {
    if (next) {
      void save(row, true, null);
      return;
    }
    setNote("");
    noteDirty.markClean("");
    setDialogSeq((n) => n + 1);
    setClosing(row);
  }

  async function handleConfirmClose(e: FormEvent) {
    e.preventDefault();
    if (!closing || note.trim().length > NOTE_MAX) return;
    const row = closing;
    // 送出時 dirty 一定要 false(skill 三之六第 5 點)。
    noteDirty.markClean(note);
    const ok = await save(row, false, note.trim() || null);
    if (ok) setClosing(null);
  }

  return (
    <Card data-testid="merchant-feature-grants-card">
      <CardHeader>
        <CardTitle>功能開關</CardTitle>
        <CardDescription>這間店開了哪些功能。關掉的功能，商家後台會整個看不到。</CardDescription>
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
              const parentOff = isParentOff(row, rows);
              const differs = differsFromPreset(row);
              return (
                <li
                  key={row.feature_key}
                  data-testid={`merchant-feature-row-${row.feature_key}`}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3",
                    row.parent_key !== null && "ml-5",
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
                    {differs || parentOff ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {differs ? (
                          <AttributeTag data-testid={`merchant-feature-differs-${row.feature_key}`}>
                            跟產業預設不同
                          </AttributeTag>
                        ) : null}
                        {parentOff ? (
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
                    checked={featureSwitchValue(row)}
                    disabled={parentOff || savingKey === row.feature_key}
                    onCheckedChange={(checked) => handleSwitch(row, checked)}
                    className="shrink-0 data-[state=checked]:bg-brand"
                  />
                </li>
              );
            })}
          </ul>
        )}

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
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <CardDialogContent dirty={noteDirty.dirty} data-testid="merchant-feature-close-dialog">
          <CardDialogHeader>
            <CardDialogTitle>{closing ? `確定要關閉「${closing.name}」？` : ""}</CardDialogTitle>
            <CardDialogDescription>
              {closing?.off_impact}
              {closing && hasChildFeatures(closing, rows) ? "底下的細部功能也會一起停用。" : null}
            </CardDialogDescription>
          </CardDialogHeader>
          <form id={CLOSE_FORM_ID} onSubmit={handleConfirmClose} className="flex flex-col gap-4">
            <FormField
              label="備註(選填)"
              htmlFor="merchant-feature-close-note"
              counter={{ value: note.trim().length, max: NOTE_MAX }}
              error={note.trim().length > NOTE_MAX ? `備註最多 ${NOTE_MAX} 字。` : null}
            >
              <FieldInput
                id="merchant-feature-close-note"
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
              form={CLOSE_FORM_ID}
              variant="primary"
              size="touch"
              data-testid="merchant-feature-close-confirm"
              disabled={savingKey !== null || note.trim().length > NOTE_MAX}
            >
              {savingKey !== null ? "關閉中⋯" : "關閉功能"}
            </Button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>
    </Card>
  );
}
