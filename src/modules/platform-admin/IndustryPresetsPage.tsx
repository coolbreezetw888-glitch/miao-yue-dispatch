// SPECS-INDEX #1025 功能開關 FG1-U02 / FG1-U08:「功能開關」頁(原「產業預設功能組合」改寫,網址 /platform-admin/industry-presets 不變)。
// 規格書 .project/specs/功能開關.md(第 2 版)FG1-U02、FG1-U08(⚠️5,使用者 F6「做」)、第三輪 ①~④。
//
// 每個功能一列(細部功能縮排在主功能底下,①),每列兩塊:
//   ・「新開商家預設」:到府派工 / 到店服務各一個開關(只影響之後新開的商家,T2)
//   ・「已開好的商家」:目前 N 間開、M 間關 +「全部開啟」「全部關閉」(⚠️5)
// 第三輪 ③:所有開關都「先調整、按儲存才生效」。按「儲存」先跳確認小卡窗(寫清楚會影響幾間、關掉會怎樣、可填備註),
// 確認後一個 RPC(platform_save_feature_settings)= 一個資料庫交易套用全部變更。未儲存就離開 ⇒ 提醒(useLeaveGuard)。
// 第三輪 ②:主功能打開時細部功能預設全部打開;主功能關時細部功能變灰不能操作(值保留)。
// 原本的「新增一項(手打 key)」表單與「刪除」按鈕已拿掉(T8)。畫面不出現任何方案 / 價格字眼(Q5)。

import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { INDUSTRY_TYPE_LABELS, INDUSTRY_TYPES } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

import {
  fetchIndustryFeaturePresets,
  fetchPlatformFeatures,
  platformFetchFeatureUsageSummary,
  platformSaveFeatureSettings,
} from "./api";
import {
  isBulkLockedByParent,
  isLockedByParent,
  orderFeaturesForDisplay,
  presetCellKey,
  stageBulk,
  togglePresetDraft,
  unstageBulk,
  type FeatureSettingsDraft,
} from "./featureDisplay";
import { getErrorMessage } from "./getErrorMessage";
import { PlatformAdminShell } from "./PlatformAdminShell";
import type { PlatformFeatureRow } from "./types";
import { useLeaveGuard } from "./useLeaveGuard";

const PRESETS_QUERY_KEY = ["platform-admin", "industry-feature-presets"] as const;
const FEATURES_QUERY_KEY = ["platform-admin", "platform-features"] as const;
const USAGE_QUERY_KEY = ["platform-admin", "feature-usage-summary"] as const;

const NOTE_MAX = 200;
const SAVE_FORM_ID = "feature-settings-save-form";
const EMPTY_DRAFT: FeatureSettingsDraft = { presets: {}, bulk: {} };

export default function IndustryPresetsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FeatureSettingsDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 每次打開小卡窗 +1 當 key(skill 三:關掉後很快又打開要重新掛載)。
  const [dialogSeq, setDialogSeq] = useState(0);
  const [note, setNote] = useState("");
  const noteDirty = useFormDirty(note);

  const featuresQuery = useQuery({ queryKey: FEATURES_QUERY_KEY, queryFn: fetchPlatformFeatures });
  const presetsQuery = useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: fetchIndustryFeaturePresets,
  });
  const usageQuery = useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: platformFetchFeatureUsageSummary,
  });

  const features = useMemo(
    () => orderFeaturesForDisplay(featuresQuery.data ?? []),
    [featuresQuery.data],
  );
  const savedPresets = useMemo(
    () =>
      new Map(
        (presetsQuery.data ?? []).map((p) => [
          presetCellKey(p.industry_type, p.feature_key),
          p.default_enabled,
        ]),
      ),
    [presetsQuery.data],
  );
  const usage = useMemo(
    () => new Map((usageQuery.data ?? []).map((u) => [u.feature_key, u])),
    [usageQuery.data],
  );

  /** 已存的值:有產業預設用產業預設,沒有就用功能清單的預設(= 新商家實際會拿到的值)。 */
  function savedPresetValue(industryType: IndustryType, feature: PlatformFeatureRow): boolean {
    return savedPresets.get(presetCellKey(industryType, feature.key)) ?? feature.default_enabled;
  }
  /** 畫面上的值(草稿優先)。 */
  function presetValue(industryType: IndustryType, feature: PlatformFeatureRow): boolean {
    return (
      draft.presets[presetCellKey(industryType, feature.key)] ??
      savedPresetValue(industryType, feature)
    );
  }
  /** 草稿裡每個產業的「主功能預設」,給細部功能判斷要不要變灰。 */
  function presetDraftForIndustry(industryType: IndustryType): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const f of features) result[f.key] = presetValue(industryType, f);
    return result;
  }

  const presetChanges = features.flatMap((f) =>
    INDUSTRY_TYPES.filter((t) => {
      const v = draft.presets[presetCellKey(t, f.key)];
      return v !== undefined && v !== savedPresetValue(t, f);
    }).map((t) => ({ industry_type: t, feature_key: f.key, default_enabled: presetValue(t, f) })),
  );
  const bulkChanges = features
    .filter((f) => draft.bulk[f.key] !== undefined)
    .map((f) => ({ feature_key: f.key, enabled: draft.bulk[f.key] as boolean }));
  const hasChanges = presetChanges.length > 0 || bulkChanges.length > 0;

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
    if (note.trim().length > NOTE_MAX) return;
    noteDirty.markClean(note);
    setSaving(true);
    try {
      const result = await platformSaveFeatureSettings({
        presets: presetChanges,
        bulk: bulkChanges,
        note: note.trim() || null,
      });
      const merchantsChanged = Object.values(result.merchants_changed).reduce((s, n) => s + n, 0);
      toast.success(
        bulkChanges.length > 0
          ? merchantsChanged > 0
            ? `已儲存，共更新 ${merchantsChanged} 間商家的開關。`
            : "已儲存，所有商家原本就是這個狀態。"
          : "已儲存新開商家的預設值。",
      );
      setDraft(EMPTY_DRAFT);
      setConfirmOpen(false);
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: USAGE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["platform-admin", "merchant-features"] }),
      ]);
    }
  }

  const isLoading = featuresQuery.isLoading || presetsQuery.isLoading;
  const error = featuresQuery.error ?? presetsQuery.error;
  const featureName = (key: string) => features.find((f) => f.key === key)?.name ?? key;

  return (
    <PlatformAdminShell>
      <div className="space-y-6" data-testid="feature-presets-page">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">功能開關</h1>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="feature-presets-intro">
            這裡可以一次調整所有商家，也可以設定新開商家的預設；要只調整某一間，請到「集團與商家」點進那間商家。調整完按「儲存」才會生效。
          </p>
        </div>

        {error ? (
          <ErrorState
            title="讀不到功能清單"
            reason={getErrorMessage(error)}
            onRetry={() => {
              void featuresQuery.refetch();
              void presetsQuery.refetch();
            }}
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4">
                  {/* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */}
                  <LoadingSkeleton variant="lines" rows={3} />
                </div>
              ) : (
                <ul>
                  {features.map((feature) => {
                    const isChild = feature.parent_key !== null;
                    const stats = usage.get(feature.key);
                    const staged = draft.bulk[feature.key];
                    const bulkLocked = isBulkLockedByParent(feature.parent_key, draft.bulk);
                    return (
                      <li
                        key={feature.key}
                        data-testid={`feature-preset-row-${feature.key}`}
                        className={cn(
                          "space-y-3 border-b border-border px-4 py-4 last:border-b-0",
                          isChild && "bg-muted/30 pl-9",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                            {feature.name}
                          </span>
                          <HelpPopover
                            label={`說明：${feature.name}`}
                            triggerTestId={`feature-preset-help-${feature.key}`}
                            popoverTestId="feature-preset-help-popover"
                          >
                            {feature.description}
                          </HelpPopover>
                        </div>

                        {/* 新開商家預設 */}
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                          <span className="text-[13px] text-muted-foreground">新開商家預設</span>
                          {INDUSTRY_TYPES.map((t) => {
                            const locked = isLockedByParent(
                              feature.parent_key,
                              presetDraftForIndustry(t),
                            );
                            return (
                              <label
                                key={`preset-${t}`}
                                className={cn(
                                  "flex items-center gap-2 text-sm text-foreground",
                                  locked && "opacity-50",
                                )}
                              >
                                <Switch
                                  aria-label={`${INDUSTRY_TYPE_LABELS[t]}新開商家預設開啟「${feature.name}」`}
                                  data-testid={`feature-preset-switch-${t}-${feature.key}`}
                                  checked={presetValue(t, feature)}
                                  disabled={saving || locked}
                                  onCheckedChange={(checked) =>
                                    setDraft((d) =>
                                      togglePresetDraft(d, t, feature.key, checked, features),
                                    )
                                  }
                                  className="data-[state=checked]:bg-brand"
                                />
                                {INDUSTRY_TYPE_LABELS[t]}
                              </label>
                            );
                          })}
                        </div>

                        {/* 已開好的商家(⚠️5) */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span
                            className="text-[13px] text-muted-foreground tabular-nums"
                            data-testid={`feature-usage-${feature.key}`}
                          >
                            {stats
                              ? `已開好的商家：目前 ${stats.enabled_count} 間開、${stats.disabled_count} 間關`
                              : "已開好的商家："}
                          </span>
                          {staged === undefined ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="neutral"
                                size="card"
                                data-testid={`feature-bulk-on-${feature.key}`}
                                disabled={saving || bulkLocked}
                                onClick={() =>
                                  setDraft((d) =>
                                    stageBulk(d, feature.key, true, features, INDUSTRY_TYPES),
                                  )
                                }
                              >
                                全部開啟
                              </Button>
                              <Button
                                type="button"
                                variant="neutral"
                                size="card"
                                data-testid={`feature-bulk-off-${feature.key}`}
                                disabled={saving || bulkLocked}
                                onClick={() =>
                                  setDraft((d) =>
                                    stageBulk(d, feature.key, false, features, INDUSTRY_TYPES),
                                  )
                                }
                              >
                                全部關閉
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <AttributeTag data-testid={`feature-bulk-staged-${feature.key}`}>
                                {staged ? "儲存後全部開啟" : "儲存後全部關閉"}
                              </AttributeTag>
                              <Button
                                type="button"
                                variant="neutral"
                                size="card"
                                data-testid={`feature-bulk-undo-${feature.key}`}
                                disabled={saving}
                                onClick={() =>
                                  setDraft((d) => unstageBulk(d, feature.key, features))
                                }
                              >
                                不調整
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {hasChanges ? (
                <div
                  className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-3"
                  data-testid="feature-presets-unsaved"
                >
                  <p className="text-sm font-semibold text-foreground">尚未儲存變更</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="neutral"
                      size="touch"
                      disabled={saving}
                      onClick={() => setDraft(EMPTY_DRAFT)}
                    >
                      放棄變更
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="touch"
                      data-testid="feature-presets-save"
                      disabled={saving}
                      onClick={openConfirm}
                    >
                      儲存
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>

      <CardDialog
        key={dialogSeq}
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <CardDialogContent dirty={noteDirty.dirty && !saving} data-testid="feature-presets-confirm">
          <CardDialogHeader>
            <CardDialogTitle>確定要儲存這些變更？</CardDialogTitle>
            <CardDialogDescription>按「儲存」後，下面的變更會一次同時生效。</CardDialogDescription>
          </CardDialogHeader>
          <ul
            className="space-y-3 text-sm text-foreground"
            data-testid="feature-presets-confirm-list"
          >
            {bulkChanges.map((b) => {
              const stats = usage.get(b.feature_key);
              const total = stats ? stats.enabled_count + stats.disabled_count : null;
              const feature = features.find((f) => f.key === b.feature_key);
              return (
                <li
                  key={`bulk-${b.feature_key}`}
                  className="rounded-md border border-border px-3 py-2"
                >
                  <p className="font-semibold">
                    {b.enabled
                      ? `所有商家的「${featureName(b.feature_key)}」都開啟`
                      : `所有商家的「${featureName(b.feature_key)}」都關閉`}
                  </p>
                  {stats && total !== null ? (
                    <p className="mt-0.5 text-muted-foreground tabular-nums">
                      {`會影響 ${total} 間商家，其中 ${stats.enabled_count} 間目前是開的。`}
                    </p>
                  ) : null}
                  {!b.enabled && feature ? (
                    <p className="mt-0.5 text-muted-foreground">{feature.off_impact}</p>
                  ) : null}
                </li>
              );
            })}
            {presetChanges.length > 0 ? (
              <li className="rounded-md border border-border px-3 py-2">
                <p className="font-semibold">新開商家預設</p>
                <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                  {presetChanges.map((p) => (
                    <li key={`preset-change-${p.industry_type}-${p.feature_key}`}>
                      {`${INDUSTRY_TYPE_LABELS[p.industry_type]}「${featureName(p.feature_key)}」改成${p.default_enabled ? "開" : "關"}`}
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>
          <form id={SAVE_FORM_ID} onSubmit={handleSave} className="flex flex-col gap-4">
            {bulkChanges.length > 0 ? (
              <FormField
                label="備註(選填)"
                htmlFor="feature-presets-note"
                counter={{ value: note.trim().length, max: NOTE_MAX }}
                error={note.trim().length > NOTE_MAX ? `備註最多 ${NOTE_MAX} 字。` : null}
              >
                <FieldInput
                  id="feature-presets-note"
                  value={note}
                  placeholder="例如：先藏起來，之後統一打開"
                  onChange={(e) => setNote(e.target.value)}
                />
              </FormField>
            ) : null}
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
              data-testid="feature-presets-confirm-save"
              disabled={saving || note.trim().length > NOTE_MAX}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>
      {leaveDialog}
    </PlatformAdminShell>
  );
}
