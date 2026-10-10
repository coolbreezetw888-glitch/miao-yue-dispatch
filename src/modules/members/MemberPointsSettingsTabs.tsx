// 紅利系統重構 批次 6(規格書 .project/specs/紅利系統重構.md §4.1~§4.5,#836~#841):
// 紅利點數管理頁的四個橫向分頁「紅利計算 / 點數使用 / 推薦系統 / 生日獎勵」。
//
// 結構(§4.1):
//   - 分頁列用 UnderlineTabs variant="pages"(skill 二之四:內容分頁列放不下就整條橫向捲,不換行),
//     捲動時吸在後台頁首正下方(sticky)。
//   - 每個分頁底部一顆「儲存設定」= 該分頁唯一的 ① 主要按鈕。
//   - 切換分頁時若目前分頁有未儲存的改動 ⇒ 小卡窗確認(skill 三:確認類)。
//   - Radix TabsContent 只渲染目前的分頁 ⇒ 確認「放棄改動並切換」之後,舊分頁卸載,改動自然丟掉。
//   - 儲存成功後重新讀設定,再用 key 讓分頁重新掛載,草稿從資料庫的最新值重新開始
//     (不在 settings 一變就覆寫草稿:視窗切回來時 react-query 會自動重抓,那會把正在打的字洗掉)。
//
// 🔴 寫入一律用 saveMerchantMemberSettings(局部 patch,只送這個分頁自己的欄位),不再整列 upsert ——
//    四個分頁各自存檔,不會把別的分頁(或會員系統設定頁)的欄位寫回舊值或預設值(§3.14)。
// 🔴 商家輸入的文字(公式名稱、生日文案、會員姓名、失敗原因)一律當純文字渲染,不用 dangerouslySetInnerHTML。

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";

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
  CardAlertDialogTrigger,
  EmptyState,
  ErrorState,
  FieldAmountInput,
  FieldError,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
  HelpPanel,
  HelpToggle,
  LoadingSkeleton,
  StatusTag,
  SwitchRow,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { TemplateVariablePreview } from "@/modules/line-notifications/TemplateVariablePreview";
import { useMerchantLineBotPublicInfo } from "@/modules/line-notifications/api";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  birthdayBonusGrantsQueryKey,
  pointFormulaServiceItemsQueryKey,
  pointFormulasQueryKey,
  saveMerchantMemberSettings,
  upsertMemberPointFormulas,
  useBirthdayBonusGrants,
  useMerchantPointFormulas,
  usePointFormulaServiceItems,
  type MerchantMemberSettingsPatch,
} from "./api";
import {
  ALL_SERVICE_ITEMS_VALUE,
  BIRTHDAY_LINE_MESSAGE_MAX,
  BIRTHDAY_TEMPLATE_VARIABLES,
  REDEEM_PAIR_MESSAGE,
  TIERED_NEEDS_MIN_AMOUNT_MESSAGE,
  basicFieldLabels,
  birthdayLineStatusTone,
  birthdaySampleValues,
  computeBasicPoints,
  computeRedeemExample,
  countMessageChars,
  duplicateFormulaMessage,
  earnModeFromSwitch,
  findDuplicateFormula,
  formatNtd,
  formatTaipeiDateTime,
  formulaItemOptions,
  formulaPreviewSentence,
  formulaToDraft,
  nextFormulaName,
  normalizePointsSettingsTab,
  parsePointsField,
  renderBirthdayMessage,
  shouldShowOwnFormulaNote,
  validateBasicDraft,
  validateFormulaDraft,
  validateRedeemDraft,
  visiblePointsSettingsTabs,
  type FormulaDraft,
  type PointsSettingsTab,
} from "./memberPointsSettingsLogic";
import { REFERRAL_UI_HIDDEN } from "./referralVisibility";
import {
  BIRTHDAY_LINE_STATUS_LABELS,
  type MemberSettingsView,
  type MerchantPointFormula,
  type PointFormulaServiceItem,
} from "./types";

const SETTINGS_QUERY_PREFIX = ["members-module", "merchant-member-settings"] as const;

interface TabBodyProps {
  merchantId: string;
  merchantName: string;
  settings: MemberSettingsView;
  onDirtyChange: (dirty: boolean) => void;
  /** 存檔成功後由外層重新讀設定並重新掛載分頁(草稿從最新值開始)。 */
  onSaved: () => Promise<void>;
}

/** 分頁底部的「儲存設定」(該分頁唯一的 ① 主要按鈕)+ 不能按時的常駐 `!`。 */
function SaveBar({
  saving,
  blockedReason,
  onSave,
}: {
  saving: boolean;
  blockedReason: string | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {blockedReason ? <AlertNote>{blockedReason}</AlertNote> : null}
      <Button
        type="button"
        variant="primary"
        size="touch"
        className="w-full sm:w-auto sm:self-start"
        disabled={saving || blockedReason !== null}
        onClick={onSave}
      >
        {saving ? "儲存中⋯" : "儲存設定"}
      </Button>
    </div>
  );
}

function useReportDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
}

// =========================================================================
// 外層:分頁列 + 未儲存切換確認
// =========================================================================

export function MemberPointsSettingsTabs({
  merchantId,
  merchantName,
  settings,
}: {
  merchantId: string;
  merchantName: string;
  settings: MemberSettingsView;
}) {
  const queryClient = useQueryClient();
  const [rawActiveTab, setActiveTab] = useState<PointsSettingsTab>("calc");
  // #1037:「推薦系統」分頁藏起來時,停在那一頁的狀態一律改回第一個分頁。
  const activeTab = normalizePointsSettingsTab(rawActiveTab, REFERRAL_UI_HIDDEN);
  const visibleTabs = visiblePointsSettingsTabs(REFERRAL_UI_HIDDEN);
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<PointsSettingsTab | null>(null);
  const [version, setVersion] = useState(0);

  function handleTabChange(next: string) {
    const target = next as PointsSettingsTab;
    if (target === activeTab) return;
    if (!visibleTabs.some((tab) => tab.value === target)) return;
    if (dirty) {
      setPendingTab(target);
      return;
    }
    setActiveTab(target);
  }

  async function handleSaved() {
    await queryClient.invalidateQueries({ queryKey: [...SETTINGS_QUERY_PREFIX, merchantId] });
    setDirty(false);
    setVersion((v) => v + 1);
  }

  const bodyProps = {
    merchantId,
    merchantName,
    settings,
    onDirtyChange: setDirty,
    onSaved: handleSaved,
  };

  return (
    <>
      <Tabs value={activeTab} onValueChange={guardPhantomEmptyChange(handleTabChange)}>
        {/* §4.1 第 4 點:分頁列捲動時固定在頂部。後台頁首是 sticky top-0、高 56px + 1px 底線
            (AppLayout.tsx / lib/fixedLayers.ts TOP_LAYER_HEADER),所以這裡吸在它正下方;
            z-20 低於頁首的 z-40,捲動時不會蓋住頁首。 */}
        <div className="sticky top-[57px] z-20 -mx-5 bg-surface px-5 pt-1">
          <UnderlineTabsList variant="pages" aria-label="紅利點數設定分頁">
            {visibleTabs.map((tab) => (
              <UnderlineTabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </UnderlineTabsTrigger>
            ))}
          </UnderlineTabsList>
        </div>
        <TabsContent value="calc" className="mt-4">
          <CalcTab key={`calc-${version}`} {...bodyProps} />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <UsageTab key={`usage-${version}`} {...bodyProps} />
        </TabsContent>
        {REFERRAL_UI_HIDDEN ? null : (
          <TabsContent value="referral" className="mt-4">
            <ReferralTab key={`referral-${version}`} {...bodyProps} />
          </TabsContent>
        )}
        <TabsContent value="birthday" className="mt-4">
          <BirthdayTab key={`birthday-${version}`} {...bodyProps} />
        </TabsContent>
      </Tabs>

      {/* §4.1:切換分頁時有未儲存的改動 ⇒ 小卡窗(確認類)。放棄改動不可逆 ⇒ ③ 危險(白底紅字)。 */}
      <CardAlertDialog
        open={pendingTab !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTab(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>這個分頁還有改動沒有儲存</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              直接切換的話，這個分頁剛剛改的內容會被丟掉(資料庫裡原本的設定不受影響)。要先按「儲存設定」嗎？
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>留下來繼續編輯</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              onClick={() => {
                if (pendingTab) {
                  setDirty(false);
                  setActiveTab(pendingTab);
                }
                setPendingTab(null);
              }}
            >
              放棄改動並切換
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </>
  );
}

// =========================================================================
// §4.2 紅利計算(#837 / #838)
// =========================================================================

function CalcTab({ merchantId, onDirtyChange, onSaved, settings }: TabBodyProps) {
  const formulasQuery = useMerchantPointFormulas(merchantId);
  const itemsQuery = usePointFormulaServiceItems(merchantId);

  if (formulasQuery.isLoading || itemsQuery.isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <LoadingSkeleton variant="lines" rows={4} />
        </CardContent>
      </Card>
    );
  }
  if (formulasQuery.isError || itemsQuery.isError || !formulasQuery.data || !itemsQuery.data) {
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorState
            title="讀不到紅利計算的設定"
            reason="可能是網路斷了；現在先不顯示欄位，避免你把畫面上的空白公式當成目前的設定存回去"
            onRetry={() => {
              void formulasQuery.refetch();
              void itemsQuery.refetch();
            }}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <CalcTabForm
      merchantId={merchantId}
      settings={settings}
      formulas={formulasQuery.data}
      items={itemsQuery.data}
      onDirtyChange={onDirtyChange}
      onSaved={onSaved}
    />
  );
}

let formulaKeySeq = 0;
function newFormulaKey() {
  formulaKeySeq += 1;
  return `new-${Date.now()}-${formulaKeySeq}`;
}

function formulaDraftSignature(drafts: FormulaDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => [d.id, d.name, d.enabled, d.serviceItemId, d.minUnitPrice, d.pointsPerUnit]),
  );
}

function CalcTabForm({
  merchantId,
  settings,
  formulas,
  items,
  onDirtyChange,
  onSaved,
}: {
  merchantId: string;
  settings: MemberSettingsView;
  formulas: MerchantPointFormula[];
  items: PointFormulaServiceItem[];
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const initial = useMemo(
    () => ({
      advanced: settings.earn_mode === "advanced",
      basic: {
        pointsPerOrder: String(settings.basic_points_per_order),
        minAmount: String(settings.basic_min_amount),
        tieredEnabled: settings.basic_tiered_enabled,
      },
      formulas: formulas.map(formulaToDraft),
    }),
    // 只在掛載時取一次(見檔頭:存檔後用 key 重新掛載)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [advanced, setAdvanced] = useState(initial.advanced);
  const [basic, setBasic] = useState(initial.basic);
  const [drafts, setDrafts] = useState<FormulaDraft[]>(initial.formulas);
  const [saving, setSaving] = useState(false);

  const dirty =
    advanced !== initial.advanced ||
    basic.pointsPerOrder !== initial.basic.pointsPerOrder ||
    basic.minAmount !== initial.basic.minAmount ||
    basic.tieredEnabled !== initial.basic.tieredEnabled ||
    formulaDraftSignature(drafts) !== formulaDraftSignature(initial.formulas);
  useReportDirty(dirty, onDirtyChange);

  const basicCheck = validateBasicDraft(basic);
  const formulaChecks = drafts.map(validateFormulaDraft);
  const formulasOk = formulaChecks.every((c) => c.ok);
  const duplicate = findDuplicateFormula(drafts, items);
  const labels = basicFieldLabels(basic.tieredEnabled);

  // 兩邊都要存(切換模式不清空另一邊,§2.1),所以兩邊都要合格才能存;
  // 看不到的那一邊有錯時要講清楚錯在哪裡(否則使用者只看到按鈕灰了卻找不到紅框)。
  let blockedReason: string | null = null;
  if (duplicate) {
    blockedReason = `${duplicateFormulaMessage(duplicate)}。請改選別的服務項目或刪掉其中一條。`;
  } else if (advanced && !formulasOk) {
    blockedReason = "上面有公式的欄位填錯了(標紅的那幾格)，修好之後才能儲存。";
  } else if (!advanced && !basicCheck.ok) {
    blockedReason = "上面有欄位填錯了(標紅的那幾格)，修好之後才能儲存。";
  } else if (advanced && !basicCheck.ok) {
    blockedReason =
      "「基本設定」裡有欄位填錯了(進階設定開著時那一區是收起來的)。請先關掉「進階設定」修好，再打開儲存。";
  } else if (!advanced && !formulasOk) {
    blockedReason =
      "「進階設定」的公式裡有欄位填錯了(現在是收起來的)。請先打開「進階設定」修好，再關掉儲存。";
  }

  const exampleBase = 1000;
  const examplePoints = basicCheck.ok
    ? computeBasicPoints(exampleBase, {
        pointsPerOrder: basicCheck.pointsPerOrder.ok ? basicCheck.pointsPerOrder.value : 0,
        minAmount: basicCheck.minAmount.ok ? basicCheck.minAmount.value : 0,
        tieredEnabled: basic.tieredEnabled,
      })
    : null;

  function updateDraft(key: string, patch: Partial<FormulaDraft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function addFormula() {
    setDrafts((prev) => {
      // 預設選一個還沒被用掉的項目:先試「全部服務項目」,再試第一個上架中、沒公式的項目。
      const used = new Set(prev.map((d) => d.serviceItemId ?? ALL_SERVICE_ITEMS_VALUE));
      const firstFree = used.has(ALL_SERVICE_ITEMS_VALUE)
        ? (items.find((i) => i.status === "active" && !used.has(i.id))?.id ?? null)
        : null;
      return [
        ...prev,
        {
          key: newFormulaKey(),
          id: null,
          name: nextFormulaName(prev),
          enabled: true,
          serviceItemId: firstFree,
          minUnitPrice: "0",
          pointsPerUnit: "1",
        },
      ];
    });
  }

  async function handleSave() {
    if (blockedReason) return;
    if (!basicCheck.pointsPerOrder.ok || !basicCheck.minAmount.ok) return;
    setSaving(true);
    try {
      // 先存公式、再存模式:萬一第二步失敗,只是「公式存了、模式沒切」,不會出現
      // 「已經切到進階,但公式還是舊的」這種會立刻影響新訂單派點的組合。
      await upsertMemberPointFormulas(
        merchantId,
        drafts.map((d, index) => {
          const check = validateFormulaDraft(d);
          return {
            id: d.id,
            name: d.name.trim(),
            enabled: d.enabled,
            serviceItemId: d.serviceItemId,
            minUnitPrice: check.minUnitPrice.ok ? check.minUnitPrice.value : 0,
            pointsPerUnit: check.pointsPerUnit.ok ? check.pointsPerUnit.value : 0,
            sortOrder: index + 1,
          };
        }),
      );
      const patch: MerchantMemberSettingsPatch = {
        earnMode: earnModeFromSwitch(advanced),
        basicPointsPerOrder: basicCheck.pointsPerOrder.value,
        basicMinAmount: basicCheck.minAmount.value,
        basicTieredEnabled: basic.tieredEnabled,
      };
      await saveMerchantMemberSettings(merchantId, patch);
      await queryClient.invalidateQueries({ queryKey: pointFormulasQueryKey(merchantId) });
      await queryClient.invalidateQueries({
        queryKey: pointFormulaServiceItemsQueryKey(merchantId),
      });
      toast.success("已儲存紅利計算設定");
      await onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const hasAllItemsFormula = drafts.some((d) => d.serviceItemId === null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
          <h2 className="text-base font-semibold text-foreground">紅利計算</h2>
          {/* §4.2 第 5 點 (d):分頁最上方的 `?`,完整例子逐字採用(使用者第 2 題定案文案)。 */}
          <HelpToggle label="說明：「全部服務項目」跟個別項目的公式怎麼一起算">
            <p>
              每張訂單派幾點，有兩種算法二選一：「基本設定」整張訂單一個規則；「進階設定」每個服務項目各自設公式。
            </p>
            <p className="mt-2">
              例：設定『全部服務項目 → 每 1 件 1 點』+『冷氣安裝 → 每 1 件 5 點』。客人買了 1
              台冷氣安裝 + 1 次清洗 ⇒ 冷氣安裝吃自己那條給 5 點，清洗沒有自己的公式所以吃『全部』給
              1 點，合計 6 點。
            </p>
          </HelpToggle>
        </div>

        <SwitchRow
          id="earn-mode-advanced"
          title="進階設定"
          description="開啟後改成「每個服務項目各自的公式」；基本設定的欄位會先收起來，值會保留，關掉就回來。"
          checked={advanced}
          onCheckedChange={setAdvanced}
        />

        {!advanced ? (
          <div className="flex flex-col gap-4" data-testid="basic-settings">
            <FormField
              label={labels.pointsPerOrder}
              htmlFor="basic-points-per-order"
              error={basicCheck.pointsPerOrder.ok ? null : basicCheck.pointsPerOrder.error}
            >
              <div className="flex items-center gap-2">
                <FieldInput
                  id="basic-points-per-order"
                  type="text"
                  inputMode="numeric"
                  className="tabular-nums sm:w-40"
                  value={basic.pointsPerOrder}
                  onChange={(e) => setBasic((b) => ({ ...b, pointsPerOrder: e.target.value }))}
                />
                <span className="shrink-0 text-sm text-muted-foreground">點</span>
              </div>
            </FormField>
            <FormField
              label={labels.minAmount}
              htmlFor="basic-min-amount"
              error={
                !basicCheck.minAmount.ok
                  ? basicCheck.minAmount.error
                  : basicCheck.tieredNeedsMinAmount
                    ? TIERED_NEEDS_MIN_AMOUNT_MESSAGE
                    : null
              }
              help="比對的是客人打完折、含稅之後要付的金額，但還沒用紅利點數折抵之前的數字(用點數折抵不會反過來害自己拿不到點數)。填 0 代表每筆訂單都給。"
              helpLabel="說明：消費金額比的是哪一個金額"
            >
              <FieldAmountInput
                id="basic-min-amount"
                className="sm:w-48"
                value={basic.minAmount}
                onChange={(e) => setBasic((b) => ({ ...b, minAmount: e.target.value }))}
              />
            </FormField>
            <SwitchRow
              id="basic-tiered"
              title="每滿額累計贈點"
              description="開啟：每滿額就再贈一次；關閉：單筆達門檻只贈一次"
              checked={basic.tieredEnabled}
              onCheckedChange={(v) => setBasic((b) => ({ ...b, tieredEnabled: v }))}
            />
            {examplePoints !== null ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                範例試算：一筆 {formatNtd(exampleBase)} 的訂單可獲得{" "}
                <strong className="tabular-nums">{examplePoints}</strong> 點
                {basicCheck.pointsPerOrder.ok && basicCheck.pointsPerOrder.value === 0
                  ? "(每筆訂單獲得是 0，代表還沒設定，不會派點)"
                  : "(實際點數在建單當下依訂單金額計算)"}
                。
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="advanced-settings">
            {drafts.length === 0 ? (
              <EmptyState
                title="還沒有任何公式"
                description="進階設定開著但沒有公式時，每筆訂單都是 0 點。新增一條公式，指定哪個服務項目每個數量給幾點。"
                action={
                  <Button type="button" variant="neutral" size="touch" onClick={addFormula}>
                    <Plus aria-hidden="true" />
                    新增公式
                  </Button>
                }
              />
            ) : (
              drafts.map((draft, index) => (
                <FormulaCard
                  key={draft.key}
                  draft={draft}
                  index={index}
                  drafts={drafts}
                  items={items}
                  hasAllItemsFormula={hasAllItemsFormula}
                  onChange={(patch) => updateDraft(draft.key, patch)}
                  onDelete={() => setDrafts((prev) => prev.filter((d) => d.key !== draft.key))}
                />
              ))
            )}
            {drafts.length > 0 ? (
              <Button
                type="button"
                variant="neutral"
                size="touch"
                className="w-full sm:w-auto sm:self-start"
                onClick={addFormula}
              >
                <Plus aria-hidden="true" />
                新增公式
              </Button>
            ) : null}
          </div>
        )}

        <SaveBar saving={saving} blockedReason={blockedReason} onSave={() => void handleSave()} />
      </CardContent>
    </Card>
  );
}

function FormulaCard({
  draft,
  index,
  drafts,
  items,
  hasAllItemsFormula,
  onChange,
  onDelete,
}: {
  draft: FormulaDraft;
  index: number;
  drafts: FormulaDraft[];
  items: PointFormulaServiceItem[];
  hasAllItemsFormula: boolean;
  onChange: (patch: Partial<FormulaDraft>) => void;
  onDelete: () => void;
}) {
  const check = validateFormulaDraft(draft);
  const options = formulaItemOptions(drafts, draft.key, items);
  const item = draft.serviceItemId
    ? (items.find((i) => i.id === draft.serviceItemId) ?? null)
    : null;
  const preview = formulaPreviewSentence({
    item,
    pointsPerUnit: draft.pointsPerUnit,
    minUnitPrice: draft.minUnitPrice,
  });
  const idPrefix = `formula-${index}`;
  const isAllItems = draft.serviceItemId === null;
  const displayName = draft.name.trim() || `第 ${index + 1} 條公式`;

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border bg-background p-3.5"
      data-testid="formula-card"
    >
      <div className="flex items-start gap-2">
        <FormField
          label="公式名稱"
          htmlFor={`${idPrefix}-name`}
          error={check.name}
          className="min-w-0 flex-1"
        >
          <FieldInput
            id={`${idPrefix}-name`}
            value={draft.name}
            maxLength={50}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </FormField>
        {/* skill 二之三 ③ 危險:白底、紅字、淡紅框,卡片內 36px;二次確認用小卡窗。 */}
        <CardAlertDialog>
          <CardAlertDialogTrigger asChild>
            <Button type="button" variant="danger" size="card" className="mt-[22px] shrink-0">
              刪除
            </Button>
          </CardAlertDialogTrigger>
          <CardAlertDialogContent>
            <CardAlertDialogHeader>
              <CardAlertDialogTitle>確定要刪除「{displayName}」嗎？</CardAlertDialogTitle>
              <CardAlertDialogDescription>
                按「儲存設定」之後才會真的刪除；刪除後，之後新建的訂單就不會再用這條公式派點(已經建好的訂單點數不受影響)。
              </CardAlertDialogDescription>
            </CardAlertDialogHeader>
            <CardAlertDialogFooter>
              <CardAlertDialogCancel>取消</CardAlertDialogCancel>
              <CardAlertDialogAction tone="danger" onClick={onDelete}>
                刪除這條公式
              </CardAlertDialogAction>
            </CardAlertDialogFooter>
          </CardAlertDialogContent>
        </CardAlertDialog>
      </div>

      <SwitchRow
        id={`${idPrefix}-enabled`}
        title="啟用這條公式"
        description="關掉是暫停使用，不會刪除。"
        checked={draft.enabled}
        onCheckedChange={(v) => onChange({ enabled: v })}
      />

      <FormField label="服務項目" htmlFor={`${idPrefix}-item`}>
        <FieldSelect<string>
          id={`${idPrefix}-item`}
          value={draft.serviceItemId ?? ALL_SERVICE_ITEMS_VALUE}
          onValueChange={guardPhantomEmptyChange<string>(
            (v) => onChange({ serviceItemId: v === ALL_SERVICE_ITEMS_VALUE ? null : v }),
            (v) => options.some((o) => o.value === v && !o.disabled),
          )}
          options={options.map((o) => ({
            value: o.value,
            disabled: o.disabled,
            label: (
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="break-all">{o.label}</span>
                {o.note ? <span className="text-xs text-muted-foreground">{o.note}</span> : null}
              </span>
            ),
          }))}
        />
      </FormField>

      {/* §4.2 第 5 點 (a):「全部服務項目」那條的常駐 `!`(逐字採用,不可改寫)。 */}
      {isAllItems ? (
        <AlertNote>
          這條套用在<strong>還沒有自己公式</strong>
          的服務項目。已經單獨設過公式的項目，吃它自己那條，不會兩邊都拿。
        </AlertNote>
      ) : null}

      {item?.status === "removed" ? (
        <AlertNote>
          這個服務項目<strong>已下架</strong>
          ：新訂單選不到它，所以這條公式只會在編輯下架前建立的舊訂單時用到。不需要的話可以把這條公式關掉。
        </AlertNote>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="單項金額門檻"
          htmlFor={`${idPrefix}-min`}
          error={check.minUnitPrice.ok ? null : check.minUnitPrice.error}
          help="比的是建單當下這個項目實際的單價(大於等於才給點)，不是價目表上的現價。填 0 代表不設門檻。"
          helpLabel="說明：單項金額門檻比的是哪個價錢"
        >
          <FieldAmountInput
            id={`${idPrefix}-min`}
            value={draft.minUnitPrice}
            onChange={(e) => onChange({ minUnitPrice: e.target.value })}
          />
        </FormField>
        <FormField
          label="每個數量獲得"
          htmlFor={`${idPrefix}-points`}
          error={check.pointsPerUnit.ok ? null : check.pointsPerUnit.error}
        >
          <div className="flex items-center gap-2">
            <FieldInput
              id={`${idPrefix}-points`}
              type="text"
              inputMode="numeric"
              className="tabular-nums"
              value={draft.pointsPerUnit}
              onChange={(e) => onChange({ pointsPerUnit: e.target.value })}
            />
            <span className="shrink-0 text-sm text-muted-foreground">點</span>
          </div>
        </FormField>
      </div>

      {preview ? (
        <p
          className="break-words rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[13px] leading-relaxed text-foreground"
          data-testid="formula-preview"
        >
          {preview}
        </p>
      ) : null}

      {/* §4.2 第 5 點 (b)(逐字)+ 主腦補的那一行(放在 (b) 後面)。 */}
      {hasAllItemsFormula && shouldShowOwnFormulaNote(draft, drafts) ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          這個項目有自己的公式，不吃『全部服務項目』那條。把這條公式關掉後，這個項目會改吃『全部服務項目』那條。
        </p>
      ) : null}
    </div>
  );
}

// =========================================================================
// §4.3 點數使用(#839)
// =========================================================================

function UsageTab({ merchantId, settings, onDirtyChange, onSaved }: TabBodyProps) {
  const initial = useMemo(
    () => ({
      pointsUnit: String(settings.redeem_points_unit),
      amountUnit: String(settings.redeem_amount_unit),
      maxRatioPercent: String(settings.redeem_max_ratio_percent),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty =
    draft.pointsUnit !== initial.pointsUnit ||
    draft.amountUnit !== initial.amountUnit ||
    draft.maxRatioPercent !== initial.maxRatioPercent;
  useReportDirty(dirty, onDirtyChange);

  const check = validateRedeemDraft(draft);
  const example =
    check.ok && check.pointsUnit.ok && check.amountUnit.ok && check.maxRatioPercent.ok
      ? computeRedeemExample({
          pointsUnit: check.pointsUnit.value,
          amountUnit: check.amountUnit.value,
          maxRatioPercent: check.maxRatioPercent.value,
          payable: 1000,
        })
      : null;

  const blockedReason = check.pairMismatch
    ? REDEEM_PAIR_MESSAGE
    : !check.ok
      ? "上面有欄位填錯了(標紅的那幾格)，修好之後才能儲存。"
      : null;

  async function handleSave() {
    if (!check.ok || !check.pointsUnit.ok || !check.amountUnit.ok || !check.maxRatioPercent.ok) {
      return;
    }
    setSaving(true);
    try {
      await saveMerchantMemberSettings(merchantId, {
        redeemPointsUnit: check.pointsUnit.value,
        redeemAmountUnit: check.amountUnit.value,
        redeemMaxRatioPercent: check.maxRatioPercent.value,
      });
      toast.success("已儲存點數使用設定");
      await onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const pairError =
    (!check.pointsUnit.ok && check.pointsUnit.error) ||
    (!check.amountUnit.ok && check.amountUnit.error) ||
    (check.pairMismatch ? REDEEM_PAIR_MESSAGE : null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <h2 className="text-base font-semibold text-foreground">點數使用</h2>

        <div
          className="group/field flex flex-col gap-1.5"
          data-invalid={pairError ? "true" : undefined}
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <span
              className="text-[13px] font-semibold leading-none text-foreground"
              id="redeem-ratio-label"
            >
              點數兌換比例(點數 : 金額)
            </span>
            {/* §2.10 第 6 點的三行說明(使用者原文),看過一次就懂 ⇒ 收進 `?`(skill 二點名的例子)。 */}
            <HelpToggle label="說明：點數兌換比例怎麼設定">
              <p>點數兌換比例設定：前面是點數，後面是金額</p>
              <p>單次最大使用比例：會員單次最多能使用的點數比例</p>
              <p>範例：100:10 代表 100 點 = 10 元，50% 代表最多能用訂單 50% 的點數</p>
            </HelpToggle>
          </div>
          <div className="flex items-center gap-2">
            <FieldInput
              aria-label="兌換比例：點數"
              type="text"
              inputMode="numeric"
              className="tabular-nums sm:w-32"
              value={draft.pointsUnit}
              onChange={(e) => setDraft((d) => ({ ...d, pointsUnit: e.target.value }))}
            />
            <span className="shrink-0 text-sm text-muted-foreground">點 :</span>
            <FieldAmountInput
              aria-label="兌換比例：金額"
              className="sm:w-32"
              value={draft.amountUnit}
              onChange={(e) => setDraft((d) => ({ ...d, amountUnit: e.target.value }))}
            />
          </div>
          {pairError ? <FieldError>{pairError}</FieldError> : null}
        </div>

        <FormField
          label="單次最大使用比例"
          htmlFor="redeem-max-ratio"
          error={check.maxRatioPercent.ok ? null : check.maxRatioPercent.error}
        >
          <div className="flex items-center gap-2">
            <FieldInput
              id="redeem-max-ratio"
              type="text"
              inputMode="numeric"
              className="tabular-nums sm:w-32"
              value={draft.maxRatioPercent}
              onChange={(e) => setDraft((d) => ({ ...d, maxRatioPercent: e.target.value }))}
            />
            <span className="shrink-0 text-sm text-muted-foreground">%</span>
          </div>
        </FormField>

        {check.ok ? (
          <p
            className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
            data-testid="redeem-example"
          >
            {example ? (
              <>
                以目前設定，一筆 {formatNtd(1000)} 的訂單最多可用{" "}
                <strong className="tabular-nums">{example.maxPoints}</strong> 點折抵{" "}
                <strong className="tabular-nums">{formatNtd(example.maxAmount)}</strong>
                (會員點數夠的話)。
              </>
            ) : (
              "目前不開放折抵：兌換比例或單次最大使用比例是 0(或一筆 NT$1,000 的訂單連 1 元都折不到)。"
            )}
          </p>
        ) : null}

        <SaveBar saving={saving} blockedReason={blockedReason} onSave={() => void handleSave()} />
      </CardContent>
    </Card>
  );
}

// =========================================================================
// §4.4 推薦系統(#840)
// =========================================================================

function ReferralTab({ merchantId, settings, onDirtyChange, onSaved }: TabBodyProps) {
  const initial = useMemo(
    () => ({
      inviterReward: settings.referral_inviter_reward_enabled,
      firstPoints: String(settings.referral_bonus_points),
      subsequentPoints: String(settings.referral_subsequent_bonus_points),
      inviterEarning: settings.referral_inviter_earning_enabled,
      inviteeEarning: settings.referral_invitee_earning_enabled,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useReportDirty(dirty, onDirtyChange);

  const firstCheck = parsePointsField(draft.firstPoints);
  const subsequentCheck = parsePointsField(draft.subsequentPoints);
  // 開關 1 關著時兩個數字欄位是隱藏的 ⇒ 不驗也不送(資料庫維持原值,打開時還在)。
  const numbersOk = !draft.inviterReward || (firstCheck.ok && subsequentCheck.ok);
  const blockedReason = numbersOk ? null : "上面有欄位填錯了(標紅的那幾格)，修好之後才能儲存。";

  async function handleSave() {
    if (!numbersOk) return;
    setSaving(true);
    try {
      const patch: MerchantMemberSettingsPatch = {
        referralInviterRewardEnabled: draft.inviterReward,
        referralInviterEarningEnabled: draft.inviterEarning,
        referralInviteeEarningEnabled: draft.inviteeEarning,
      };
      if (draft.inviterReward && firstCheck.ok && subsequentCheck.ok) {
        patch.referralBonusPoints = firstCheck.value;
        patch.referralSubsequentBonusPoints = subsequentCheck.value;
      }
      await saveMerchantMemberSettings(merchantId, patch);
      toast.success("已儲存推薦系統設定");
      await onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-6">
        <h2 className="text-base font-semibold text-foreground">推薦系統</h2>
        {/* §4.4 第 1 點:三個開關的白話說明集中放在最上面一個說明區塊(截圖第 8 點)。 */}
        <HelpPanel>
          <p>
            <strong>推薦者邀請是否累積紅利：</strong>
            當推薦的會員透過連結加入並消費時，推薦者可以獲得紅利點數。關閉則無法獲得。
          </p>
          <p className="mt-1.5">
            <strong>推薦者消費是否累積紅利：</strong>控制推薦者自己消費時是否能累積紅利點數。
          </p>
          <p className="mt-1.5">
            <strong>被推薦者消費是否累積紅利：</strong>控制被推薦者自己消費時是否能累積紅利點數。
          </p>
        </HelpPanel>

        <SwitchRow
          id="referral-inviter-reward"
          title="推薦者邀請是否累積紅利"
          description="開啟後才能設定推薦獎勵的點數。"
          checked={draft.inviterReward}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, inviterReward: v }))}
        />
        {draft.inviterReward ? (
          <div className="flex flex-col gap-4" data-testid="referral-reward-fields">
            <FormField
              label="首次推薦獎勵獲得"
              htmlFor="referral-first-points"
              error={firstCheck.ok ? null : firstCheck.error}
              help="被推薦的會員完成第一筆訂單時，推薦者拿到的點數。"
              helpLabel="說明：首次推薦獎勵什麼時候發"
            >
              <div className="flex items-center gap-2">
                <FieldInput
                  id="referral-first-points"
                  type="text"
                  inputMode="numeric"
                  className="tabular-nums sm:w-40"
                  value={draft.firstPoints}
                  onChange={(e) => setDraft((d) => ({ ...d, firstPoints: e.target.value }))}
                />
                <span className="shrink-0 text-sm text-muted-foreground">點</span>
              </div>
            </FormField>
            <FormField
              label="後續每次達標獲得"
              htmlFor="referral-subsequent-points"
              error={subsequentCheck.ok ? null : subsequentCheck.error}
              help="「達標」= 被推薦的會員之後每完成一筆「本身有派到點」的訂單(沒達到派點門檻、派 0 點的訂單不算)。"
              helpLabel="說明：後續每次達標是什麼意思"
            >
              <div className="flex items-center gap-2">
                <FieldInput
                  id="referral-subsequent-points"
                  type="text"
                  inputMode="numeric"
                  className="tabular-nums sm:w-40"
                  value={draft.subsequentPoints}
                  onChange={(e) => setDraft((d) => ({ ...d, subsequentPoints: e.target.value }))}
                />
                <span className="shrink-0 text-sm text-muted-foreground">點</span>
              </div>
            </FormField>
          </div>
        ) : null}

        <SwitchRow
          id="referral-inviter-earning"
          title="推薦者消費是否累積紅利"
          checked={draft.inviterEarning}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, inviterEarning: v }))}
        />
        <SwitchRow
          id="referral-invitee-earning"
          title="被推薦者消費是否累積紅利"
          checked={draft.inviteeEarning}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, inviteeEarning: v }))}
        />
        {!draft.inviterEarning || !draft.inviteeEarning ? (
          // 第 14、15 題:關掉只擋「累積」,不擋折抵 / 兌換;同時是推薦者與被推薦者的人,任一關閉就不累積。
          <AlertNote>
            關閉後，這類會員之後的訂單<strong>不會再累積紅利點數</strong>
            (既有的點數照樣可以折抵或兌換)；同時是推薦者也是被推薦者的會員，兩個開關任一個關閉就不累積。
          </AlertNote>
        ) : null}

        <SaveBar saving={saving} blockedReason={blockedReason} onSave={() => void handleSave()} />
      </CardContent>
    </Card>
  );
}

// =========================================================================
// §4.5 生日獎勵(#841)
// =========================================================================

function BirthdayTab({ merchantId, merchantName, settings, onDirtyChange, onSaved }: TabBodyProps) {
  const initial = useMemo(
    () => ({
      enabled: settings.birthday_bonus_enabled,
      points: String(settings.birthday_bonus_points),
      message: settings.birthday_line_message,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useReportDirty(dirty, onDirtyChange);

  const lineInfo = useMerchantLineBotPublicInfo(merchantId);
  const pointsCheck = parsePointsField(draft.points);
  const messageLength = countMessageChars(draft.message);
  const messageTooLong = messageLength > BIRTHDAY_LINE_MESSAGE_MAX;
  const blockedReason = messageTooLong
    ? `LINE 文字訊息最多 ${BIRTHDAY_LINE_MESSAGE_MAX} 個字，目前 ${messageLength} 個字，請刪短一點再儲存。`
    : !pointsCheck.ok
      ? "上面有欄位填錯了(標紅的那幾格)，修好之後才能儲存。"
      : null;
  const sampleValues = birthdaySampleValues({
    merchantName,
    points: pointsCheck.ok ? pointsCheck.value : null,
  });

  async function handleSave() {
    if (blockedReason || !pointsCheck.ok) return;
    setSaving(true);
    try {
      await saveMerchantMemberSettings(merchantId, {
        birthdayBonusEnabled: draft.enabled,
        birthdayBonusPoints: pointsCheck.value,
        birthdayLineMessage: draft.message,
      });
      toast.success("已儲存生日獎勵設定");
      await onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <h2 className="text-base font-semibold text-foreground">生日獎勵</h2>
            {/* 第 11、12 題:補發窗口是「看過一次就懂」的規則說明 ⇒ `?`。 */}
            <HelpToggle label="說明：錯過當天的生日會不會補發">
              如果當天系統維護或您當天才開啟這個功能，生日在最近 7
              天內、今年還沒收到的會員會自動補發；超過 7 天就不補。
            </HelpToggle>
          </div>

          <SwitchRow
            id="birthday-bonus-enabled"
            title="是否啟用生日贈點"
            description="依台北時區比對生日月、日；每位會員每年只發放一次；每天 00:05 自動發放點數，09:10 發送 LINE 訊息"
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />

          <FormField
            label="生日贈送點數"
            htmlFor="birthday-bonus-points"
            error={pointsCheck.ok ? null : pointsCheck.error}
          >
            <div className="flex items-center gap-2">
              <FieldInput
                id="birthday-bonus-points"
                type="text"
                inputMode="numeric"
                className="tabular-nums sm:w-40"
                value={draft.points}
                onChange={(e) => setDraft((d) => ({ ...d, points: e.target.value }))}
              />
              <span className="shrink-0 text-sm text-muted-foreground">點</span>
            </div>
          </FormField>
          {draft.enabled && pointsCheck.ok && pointsCheck.value === 0 ? (
            <AlertNote>
              生日贈送點數是 0：開關雖然開著，系統不會發任何點數、也不會發 LINE。
            </AlertNote>
          ) : null}

          <FormField
            label="LINE 文字訊息"
            htmlFor="birthday-line-message"
            counter={{ value: messageLength, max: BIRTHDAY_LINE_MESSAGE_MAX }}
            error={messageTooLong ? `最多 ${BIRTHDAY_LINE_MESSAGE_MAX} 個字` : null}
          >
            <FieldTextarea
              id="birthday-line-message"
              rows={4}
              value={draft.message}
              onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
            />
          </FormField>
          <TemplateVariablePreview
            variables={BIRTHDAY_TEMPLATE_VARIABLES}
            sampleValues={sampleValues}
            recipientLabel="會員"
            previews={[{ text: renderBirthdayMessage(draft.message, sampleValues) }]}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">未綁定 LINE 的會員仍會收到點數</strong>
            ，只是不會收到這則訊息。
          </p>
          {lineInfo.data && !lineInfo.data.isConnected ? (
            // skill 二 第三類:現在的狀態跟使用者以為的不一樣(以為會發 LINE,其實不會)⇒ 常駐 `!`。
            <AlertNote>目前尚未完成 LINE 串接，訊息不會發送，點數仍會照發。</AlertNote>
          ) : null}

          <SaveBar saving={saving} blockedReason={blockedReason} onSave={() => void handleSave()} />
        </CardContent>
      </Card>

      <BirthdayGrantsCard merchantId={merchantId} />
    </div>
  );
}

function BirthdayGrantsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const grants = useBirthdayBonusGrants(merchantId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">生日點數發送紀錄</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">最近 50 筆</p>
          </div>
          {/* 只重新讀取紀錄清單(§3.8),不會觸發發送(規格書「本次明確不做」)。 */}
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="shrink-0"
            disabled={grants.isFetching}
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: birthdayBonusGrantsQueryKey(merchantId),
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            重新整理
          </Button>
        </div>

        {grants.isLoading ? (
          <LoadingSkeleton variant="cards" rows={2} />
        ) : grants.isError ? (
          <ErrorState
            title="讀不到生日點數發送紀錄"
            reason="可能是網路斷了"
            onRetry={() => void grants.refetch()}
          />
        ) : !grants.data || grants.data.length === 0 ? (
          <EmptyState
            title="目前尚無生日紅利紀錄"
            description="會員資料填了生日，系統會在生日當天(台北時間 00:05)自動發放，紀錄就會出現在這裡。"
            action={
              <Button asChild variant="neutral" size="touch">
                <Link to="/app/members">去會員管理填生日</Link>
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5" data-testid="birthday-grants">
            {grants.data.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-col gap-1.5 rounded-xl border border-border bg-background p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all text-sm font-semibold text-foreground">
                    {grant.memberName}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {grant.points} 點
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusTag tone={birthdayLineStatusTone(grant.lineStatus)}>
                    {BIRTHDAY_LINE_STATUS_LABELS[grant.lineStatus] ?? grant.lineStatus}
                  </StatusTag>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    發放時間 {formatTaipeiDateTime(grant.grantedAt)}
                  </span>
                </div>
                {grant.lineError ? (
                  <p className="break-words text-xs leading-relaxed text-destructive-strong">
                    失敗原因：{grant.lineError}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
