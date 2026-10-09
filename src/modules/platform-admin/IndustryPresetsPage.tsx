// SPECS-INDEX #1025 功能開關 FG1-U02:「功能開關」頁(原「產業預設功能組合」改寫,網址 /platform-admin/industry-presets 不變)。
// 規格書 .project/specs/功能開關.md(第 2 版)FG1-U02。
//
// 一張表:列 = 功能清單(主功能一列,細部功能縮排在它下面;依 sort_order),欄 = 功能 / 到府派工 / 到店服務。
// 每格一個開關,切換即存(直接 upsert industry_feature_presets,既有 RLS 只有超級管理員能寫)。
// 這裡只決定「之後新開的商家」預設開哪些(T2);已經開好的商家到「集團與商家」點進去個別調整。
//
// 原本的「新增一項(手打 key)」表單與「刪除」按鈕 / 刪除確認窗已拿掉(T8:功能清單由程式維護,
// 憑空新增的名稱不會有任何作用)。
// ⚠️5(F6 批次開關 + 統計欄)這次不做。

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ErrorState, HelpPopover, LoadingSkeleton } from "@/components/patterns";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { INDUSTRY_TYPE_LABELS, INDUSTRY_TYPES } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

import {
  fetchIndustryFeaturePresets,
  fetchPlatformFeatures,
  upsertIndustryFeaturePreset,
} from "./api";
import { orderFeaturesForDisplay } from "./featureDisplay";
import { getErrorMessage } from "./getErrorMessage";
import { PlatformAdminShell } from "./PlatformAdminShell";

const PRESETS_QUERY_KEY = ["platform-admin", "industry-feature-presets"] as const;
const FEATURES_QUERY_KEY = ["platform-admin", "platform-features"] as const;

/** 一格的識別:產業 + 功能。 */
const cellKey = (industryType: IndustryType, featureKey: string) => `${industryType}:${featureKey}`;

export default function IndustryPresetsPage() {
  const queryClient = useQueryClient();
  const [savingCell, setSavingCell] = useState<string | null>(null);

  const featuresQuery = useQuery({ queryKey: FEATURES_QUERY_KEY, queryFn: fetchPlatformFeatures });
  const presetsQuery = useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: fetchIndustryFeaturePresets,
  });

  const features = useMemo(
    () => orderFeaturesForDisplay(featuresQuery.data ?? []),
    [featuresQuery.data],
  );
  const presetMap = useMemo(
    () =>
      new Map(
        (presetsQuery.data ?? []).map((p) => [
          cellKey(p.industry_type, p.feature_key),
          p.default_enabled,
        ]),
      ),
    [presetsQuery.data],
  );

  /** 這一格目前的值:有產業預設用產業預設,沒有就用功能清單的預設(= 新商家實際會拿到的值)。 */
  function cellValue(industryType: IndustryType, featureKey: string, fallback: boolean): boolean {
    return presetMap.get(cellKey(industryType, featureKey)) ?? fallback;
  }

  async function handleToggle(industryType: IndustryType, featureKey: string, next: boolean) {
    const key = cellKey(industryType, featureKey);
    setSavingCell(key);
    try {
      await upsertIndustryFeaturePreset({ industryType, featureKey, defaultEnabled: next });
      await queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
      toast.success("已更新預設值。");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingCell(null);
    }
  }

  const isLoading = featuresQuery.isLoading || presetsQuery.isLoading;
  const error = featuresQuery.error ?? presetsQuery.error;

  return (
    <PlatformAdminShell>
      <div className="space-y-6" data-testid="feature-presets-page">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">功能開關</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            設定新開的商家預設開哪些功能。這裡只影響之後新開的商家；已經開好的商家，請到「集團與商家」點進那間商家個別調整。
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
              {/* 標題列:功能 / 到府派工 / 到店服務。窄螢幕時兩個產業欄的標題自動折成兩行,整頁不橫向捲動。 */}
              <div
                className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] items-end gap-x-3 border-b border-border px-4 py-3 text-[13px] font-semibold text-muted-foreground sm:grid-cols-[minmax(0,1fr)_6rem_6rem]"
                aria-hidden="true"
              >
                <span>功能</span>
                {INDUSTRY_TYPES.map((t) => (
                  <span key={t} className="text-center leading-snug">
                    {INDUSTRY_TYPE_LABELS[t]}
                  </span>
                ))}
              </div>
              {isLoading ? (
                <div className="p-4">
                  {/* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */}
                  <LoadingSkeleton variant="lines" rows={3} />
                </div>
              ) : (
                <ul>
                  {features.map((feature) => {
                    const isChild = feature.parent_key !== null;
                    return (
                      <li
                        key={feature.key}
                        data-testid={`feature-preset-row-${feature.key}`}
                        className="grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] items-center gap-x-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]"
                      >
                        <div className={cn("flex min-w-0 items-center gap-1", isChild && "pl-5")}>
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
                        {INDUSTRY_TYPES.map((t) => {
                          const key = cellKey(t, feature.key);
                          return (
                            <div key={t} className="flex justify-center">
                              <Switch
                                aria-label={`${INDUSTRY_TYPE_LABELS[t]}新開商家預設開啟「${feature.name}」`}
                                data-testid={`feature-preset-switch-${t}-${feature.key}`}
                                checked={cellValue(t, feature.key, feature.default_enabled)}
                                disabled={savingCell === key}
                                onCheckedChange={(checked) =>
                                  void handleToggle(t, feature.key, checked)
                                }
                                className="data-[state=checked]:bg-brand"
                              />
                            </div>
                          );
                        })}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </PlatformAdminShell>
  );
}
