// 對應規格書 4.6:產業預設功能組合編輯器(`/platform-admin/industry-presets`)。
// feature_key 用 <datalist> 列出目前資料庫裡已經出現過的 key 當自動完成建議，不做強制白名單
// (見規格書 4.6 邊界情況說明)。刪除前用一般的 AlertDialog「確定要刪除嗎」對話框，比照規則 2.6
// 的判斷結論(不算危險操作，不需要 JSON 備份)。

import { useMemo, useState, type FormEvent } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { INDUSTRY_TYPE_LABELS, INDUSTRY_TYPES } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

import {
  createIndustryFeaturePreset,
  deleteIndustryFeaturePreset,
  fetchIndustryFeaturePresets,
  updateIndustryFeaturePresetEnabled,
} from "./api";
import { getErrorMessage } from "./getErrorMessage";
import { PlatformAdminShell } from "./PlatformAdminShell";

const PRESETS_QUERY_KEY = ["platform-admin", "industry-feature-presets"] as const;
const FEATURE_KEY_DATALIST_ID = "existing-feature-keys";

export default function IndustryPresetsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<IndustryType>("on_site_dispatch");
  const [newFeatureKey, setNewFeatureKey] = useState("");
  const [newDefaultEnabled, setNewDefaultEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const {
    data: presets,
    isLoading,
    error,
  } = useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: fetchIndustryFeaturePresets,
  });

  const existingFeatureKeys = useMemo(
    () => Array.from(new Set((presets ?? []).map((p) => p.feature_key))),
    [presets],
  );

  const presetsForActiveTab = useMemo(
    () => (presets ?? []).filter((p) => p.industry_type === activeTab),
    [presets, activeTab],
  );

  async function refetchPresets() {
    await queryClient.invalidateQueries({ queryKey: PRESETS_QUERY_KEY });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newFeatureKey.trim()) return;
    setCreating(true);
    try {
      await createIndustryFeaturePreset({
        industryType: activeTab,
        featureKey: newFeatureKey,
        defaultEnabled: newDefaultEnabled,
      });
      setNewFeatureKey("");
      setNewDefaultEnabled(true);
      await refetchPresets();
      toast.success("已新增一項預設功能");
    } catch (err) {
      toast.error("新增失敗", { description: getErrorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(id: string, nextEnabled: boolean) {
    setTogglingId(id);
    try {
      await updateIndustryFeaturePresetEnabled(id, nextEnabled);
      await refetchPresets();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await deleteIndustryFeaturePreset(id);
      await refetchPresets();
      toast.success("已刪除");
    } catch (err) {
      toast.error("刪除失敗", { description: getErrorMessage(err) });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <PlatformAdminShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">產業預設功能組合</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            新商家建立時，會依照選的產業自動套用這裡設定的預設值。修改這裡不會影響已經建立的商家。
          </p>
        </div>

        {error ? (
          <p className="text-sm text-destructive">載入失敗:{(error as Error).message}</p>
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as IndustryType)}>
            <TabsList>
              {INDUSTRY_TYPES.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {INDUSTRY_TYPE_LABELS[t]}
                </TabsTrigger>
              ))}
            </TabsList>

            {INDUSTRY_TYPES.map((t) => (
              <TabsContent key={t} value={t}>
                <Card>
                  <CardHeader>
                    <CardTitle>{INDUSTRY_TYPE_LABELS[t]}</CardTitle>
                    <CardDescription>目前設定的預設功能開關</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {isLoading ? (
                      <p className="text-sm text-muted-foreground">載入中⋯</p>
                    ) : (
                      <ul className="space-y-2">
                        {presetsForActiveTab.map((preset) => (
                          <li
                            key={preset.id}
                            className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                          >
                            <span className="font-mono text-sm text-foreground">
                              {preset.feature_key}
                            </span>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={preset.default_enabled}
                                disabled={togglingId === preset.id}
                                onCheckedChange={(checked) => handleToggle(preset.id, checked)}
                              />
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={deletingId === preset.id}
                                  >
                                    刪除
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>確定要刪除這一項嗎?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      刪除「{preset.feature_key}」不會影響已經建立的商家目前的功能
                                      開關，只影響之後新建商家的預設值。
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>取消</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => handleDelete(preset.id)}>
                                      確定刪除
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </li>
                        ))}
                        {presetsForActiveTab.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            目前沒有設定任何預設功能
                          </p>
                        ) : null}
                      </ul>
                    )}

                    <form
                      onSubmit={handleCreate}
                      className="flex items-end gap-3 border-t border-border pt-4"
                    >
                      <div className="flex-1">
                        <Label htmlFor="new-feature-key">新增一項(功能鍵值)</Label>
                        <Input
                          id="new-feature-key"
                          className="mt-2"
                          list={FEATURE_KEY_DATALIST_ID}
                          value={newFeatureKey}
                          onChange={(e) => setNewFeatureKey(e.target.value)}
                          placeholder="例如 online_booking"
                        />
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        <Label htmlFor="new-feature-enabled">預設開啟</Label>
                        <Switch
                          id="new-feature-enabled"
                          checked={newDefaultEnabled}
                          onCheckedChange={setNewDefaultEnabled}
                        />
                      </div>
                      <Button type="submit" disabled={creating || !newFeatureKey.trim()}>
                        {creating ? "新增中⋯" : "新增"}
                      </Button>
                    </form>
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        )}

        <datalist id={FEATURE_KEY_DATALIST_ID}>
          {existingFeatureKeys.map((key) => (
            <option key={key} value={key} />
          ))}
        </datalist>
      </div>
    </PlatformAdminShell>
  );
}
