// #1035 彈性計薪 A 批(月薪加獎金)— 「抽成與薪資設定」頁的「月薪獎金方案」區塊 + 規則編輯器 + 試算。
// 規格書:母版 .project/specs/彈性計薪.md PA-U01~U03(⚠️範圍 1 試算、2 上限、3 整月都算都做)。
//
// 版面依 ui-overlay-patterns:
//   - 方案清單一律 ListCard;「編輯」是主要動作;「封存」不可逆 ⇒ 收進 ⋯、紅字、分隔線下方,再跳確認窗。
//   - 編輯器開在全頁層(規則多、有試算,要捲動);有「按儲存才寫入」的欄位 ⇒ 傳 dirty。
//   - 「下個月起另有設定」是屬性(方角灰底);「這次只會改本月」這種「狀態跟你以為的不一樣」⇒ `!` 常駐。
// 🔴 C 批(PC-U01)起「給什麼」多「自訂公式（進階）」;公式欄位在 BonusFormulaFields.tsx。
// 🔴 前端不算獎金:試算一律呼叫資料庫 preview_staff_bonus / preview_bonus_formula(跟報表同一套算法)。

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AlertNote,
  AttributeTag,
  CardAlertDialog,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  ChoiceChipGroup,
  DetailRow,
  DetailSection,
  EmptyState,
  ErrorState,
  FieldAmountInput,
  FieldInput,
  FieldMonth,
  FieldMultiSelect,
  FieldSelect,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  ListCard,
  LoadingSkeleton,
  StatusTag,
  SwitchRow,
  useFormDirty,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import type { MerchantStaff } from "@/modules/staff-agent/types";

import {
  archiveStaffBonusPlan,
  previewStaffBonus,
  saveStaffBonusPlan,
  staffBonusPlansQueryKey,
  useStaffBonusPlans,
  type BonusPlanEffective,
} from "./api";
import {
  BONUS_METRIC_OPTIONS,
  BONUS_PLAN_NAME_MAX,
  BONUS_EDITOR_KIND_OPTIONS,
  BONUS_RULE_LABEL_MAX,
  BONUS_RULE_MAX_COUNT,
  bonusDraftUnit,
  bonusFlagNotes,
  bonusRulesFromDrafts,
  createBonusRuleDraft,
  describeBonusRuleDraft,
  describeBonusRuleResult,
  draftFromBonusRule,
  formatBonusNumber,
  formulaSaveBlocker,
  summarizeBonusPlanRules,
  type BonusFormulaCheckState,
  type BonusRuleDraft,
  type BonusRuleDraftField,
} from "./bonusRuleLogic";
import { BonusFormulaFields } from "./BonusFormulaFields";
import type {
  BonusMetric,
  BonusPlan,
  BonusPlansListing,
  BonusRule,
  BonusRuleKind,
  StaffMonthlyBonus,
} from "./types";

const SECTION_DESCRIPTION =
  "好幾位月薪人員用同一套獎金規則時，先建一個方案再套用給他們；改方案時，用這個方案的人一起變。";
const EMPTY_DESCRIPTION = "建立方案後，到下方月薪人員選擇要套用哪一個。";
const EDITOR_SUBTITLE =
  "每條規則 =「超過多少才開始算」+「給什麼」，多條規則的獎金會加在一起。獎金只算這位服務人員當主要服務人員、已完成的訂單。";
const EFFECTIVE_NOTE = "過去月份的獎金不會改變。";
const NEXT_MONTH_OVERRIDE_NOTE =
  "這個方案下個月起另有一份設定。這次選「從本月起」只會改本月，下個月起仍然用那份設定。";
const REVENUE_HELP =
  "業績 = 服務金額扣掉折扣；如果「料錢影響抽成」是開啟的，再扣掉料錢（跟抽成的算法一樣，照現在的設定算）。";
const RETROACTIVE_HELP =
  "不勾：只有超過門檻之後的部分才加錢（例：超過 10 份後，第 11 份起每份加錢）。勾選：超過門檻後，這個月從第 1 份起全部都加錢。";
const ARCHIVE_DESCRIPTION =
  "封存後不能再套用給任何人，也不能再修改；過去月份已經算進報表的獎金照常保留。封存之後沒有辦法恢復。";
const PREVIEW_HELP = "用還沒存檔的規則，算算看某位月薪人員某個月會拿到多少。真正的金額以報表為準。";

const EFFECTIVE_OPTIONS: ReadonlyArray<{ value: BonusPlanEffective; label: string }> = [
  { value: "this_month", label: "從本月起生效" },
  { value: "next_month", label: "從下個月起生效" },
];

function serviceNameLookup(listing: BonusPlansListing | undefined) {
  const map = new Map((listing?.service_items ?? []).map((s) => [s.id, s.name]));
  return (id: string) => map.get(id);
}

// =========================================================================
// 區塊本體(PA-U01)
// =========================================================================
export function BonusPlanSection({
  merchantId,
  monthlyStaff,
}: {
  merchantId: string;
  /** 目前在職的月薪人員(試算用)。 */
  monthlyStaff: MerchantStaff[];
}) {
  const queryClient = useQueryClient();
  const { data: listing, isLoading, isError, refetch } = useStaffBonusPlans(merchantId);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSeq, setEditorSeq] = useState(0);
  const [editingPlan, setEditingPlan] = useState<BonusPlan | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<BonusPlan | null>(null);
  const [archiveSeq, setArchiveSeq] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const activePlans = (listing?.plans ?? []).filter((p) => p.status === "active");
  const archivedPlans = (listing?.plans ?? []).filter((p) => p.status === "archived");

  function openEditor(plan: BonusPlan | null) {
    setEditingPlan(plan);
    setEditorSeq((n) => n + 1);
    setEditorOpen(true);
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await archiveStaffBonusPlan(archiveTarget.id);
      toast.success(`已封存「${archiveTarget.name}」`);
      setArchiveTarget(null);
      await queryClient.invalidateQueries({ queryKey: staffBonusPlansQueryKey(merchantId) });
    } catch (err) {
      toast.error("封存失敗", { description: getErrorMessage(err) });
    } finally {
      setArchiving(false);
    }
  }

  const newPlanButton = (
    <Button
      type="button"
      variant="neutral"
      size="touch"
      onClick={() => openEditor(null)}
      data-testid="bonus-plan-new"
    >
      新增方案
    </Button>
  );

  return (
    <Card data-testid="bonus-plan-section">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle>月薪獎金方案</CardTitle>
            <CardDescription className="mt-1.5">{SECTION_DESCRIPTION}</CardDescription>
          </div>
          {activePlans.length > 0 ? <div className="shrink-0">{newPlanButton}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading ? (
          <LoadingSkeleton variant="cards" rows={2} />
        ) : isError || !listing ? (
          <ErrorState
            title="讀不到獎金方案"
            reason="可能是網路斷了，或你沒有「抽成與薪資設定」的權限"
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {activePlans.length === 0 ? (
              <EmptyState
                title="還沒有獎金方案"
                description={EMPTY_DESCRIPTION}
                action={newPlanButton}
              />
            ) : (
              <ul className="flex flex-col gap-2.5" data-testid="bonus-plan-list">
                {activePlans.map((plan) => (
                  <li key={plan.id}>
                    <ListCard
                      title={plan.name}
                      tags={
                        plan.next_version ? (
                          <AttributeTag>下個月起另有設定</AttributeTag>
                        ) : undefined
                      }
                      meta={
                        <>
                          <span className="block">
                            {summarizeBonusPlanRules(
                              plan.current_version?.rules ?? plan.next_version?.rules ?? [],
                            )}
                          </span>
                          <span className="block">
                            {plan.staff_count > 0
                              ? `使用中 ${plan.staff_count} 人：${plan.staff_names.join("、")}`
                              : "目前沒有人使用"}
                          </span>
                        </>
                      }
                      primaryAction={
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => openEditor(plan)}
                        >
                          編輯
                        </Button>
                      }
                      menuItems={[
                        {
                          label: "封存",
                          danger: true,
                          onSelect: () => {
                            setArchiveSeq((n) => n + 1);
                            setArchiveTarget(plan);
                          },
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}

            {archivedPlans.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                <Button
                  type="button"
                  variant="text"
                  size="touch"
                  className="self-start px-0"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived
                    ? `收合已封存的方案（${archivedPlans.length}）`
                    : `已封存的方案（${archivedPlans.length}）`}
                </Button>
                {showArchived ? (
                  <ul className="flex flex-col gap-2.5">
                    {archivedPlans.map((plan) => (
                      <li key={plan.id}>
                        <ListCard
                          state="inactive"
                          title={plan.name}
                          tags={<StatusTag tone="neutral">已封存</StatusTag>}
                          meta={summarizeBonusPlanRules(
                            plan.current_version?.rules ?? plan.next_version?.rules ?? [],
                          )}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      {listing ? (
        <BonusPlanEditor
          key={`editor-${editorSeq}`}
          open={editorOpen}
          onOpenChange={setEditorOpen}
          merchantId={merchantId}
          plan={editingPlan}
          listing={listing}
          monthlyStaff={monthlyStaff}
        />
      ) : null}

      <CardAlertDialog
        key={`archive-${archiveSeq}`}
        open={archiveTarget !== null}
        onOpenChange={(next) => {
          if (!next && !archiving) setArchiveTarget(null);
        }}
      >
        <CardAlertDialogContent
          data-testid="bonus-plan-archive-confirm"
          onEscapeKeyDown={(e) => {
            if (archiving) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>{`封存「${archiveTarget?.name ?? ""}」？`}</CardAlertDialogTitle>
            <CardAlertDialogDescription>{ARCHIVE_DESCRIPTION}</CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={archiving}>取消</CardAlertDialogCancel>
            <Button
              type="button"
              variant="danger"
              size="touch"
              disabled={archiving}
              onClick={() => void handleArchive()}
            >
              {archiving ? "封存中⋯" : "封存"}
            </Button>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </Card>
  );
}

// =========================================================================
// 規則編輯器(PA-U02)+ 試算(PA-U03)
// =========================================================================
const EDITOR_FORM_ID = "bonus-plan-editor-form";

function initialDrafts(plan: BonusPlan | null): BonusRuleDraft[] {
  const version = plan?.current_version ?? plan?.next_version ?? null;
  if (version && version.rules.length > 0) return version.rules.map(draftFromBonusRule);
  return [createBonusRuleDraft([])];
}

function BonusPlanEditor({
  open,
  onOpenChange,
  merchantId,
  plan,
  listing,
  monthlyStaff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  merchantId: string;
  plan: BonusPlan | null;
  listing: BonusPlansListing;
  monthlyStaff: MerchantStaff[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(plan?.name ?? "");
  const [drafts, setDrafts] = useState<BonusRuleDraft[]>(() => initialDrafts(plan));
  const [effective, setEffective] = useState<BonusPlanEffective>(
    plan && !plan.current_version && plan.next_version ? "next_month" : "this_month",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // #1035 C 批:每條公式規則的即時檢查結果(key → 狀態),決定存檔按鈕擋不擋。
  const [formulaChecks, setFormulaChecks] = useState<
    Record<string, BonusFormulaCheckState | undefined>
  >({});

  const formDirty = useFormDirty({ name, drafts, effective });
  const markFormClean = formDirty.markClean;
  useEffect(() => {
    markFormClean({ name: plan?.name ?? "", drafts: initialDrafts(plan), effective });
    // 只在打開(重新掛載)的那一次記下初始值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serviceNameOf = useMemo(() => serviceNameLookup(listing), [listing]);
  const parsed = useMemo(
    () => bonusRulesFromDrafts(drafts, serviceNameOf),
    [drafts, serviceNameOf],
  );
  const errorsByIndex = !parsed.ok && showErrors ? parsed.errorsByIndex : [];
  const saveBlocker = formulaSaveBlocker(drafts, formulaChecks);

  function updateDraft(index: number, patch: Partial<BonusRuleDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }
  function moveDraft(index: number, delta: -1 | 1) {
    setDrafts((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }
  function removeDraft(index: number) {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  }
  function addDraft() {
    setDrafts((prev) => [...prev, createBonusRuleDraft(prev.map((d) => d.key))]);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const trimmed = name.trim();
    const nameProblem =
      trimmed.length === 0
        ? "請填方案名稱。"
        : trimmed.length > BONUS_PLAN_NAME_MAX
          ? `方案名稱最多 ${BONUS_PLAN_NAME_MAX} 個字。`
          : null;
    setNameError(nameProblem);
    setShowErrors(true);
    if (nameProblem || !parsed.ok || drafts.length === 0 || saveBlocker) return;
    setSaving(true);
    try {
      await saveStaffBonusPlan({
        merchantId,
        planId: plan?.id ?? null,
        name: trimmed,
        rules: parsed.rules,
        effective,
      });
      markFormClean({ name, drafts, effective });
      toast.success(plan ? "已更新獎金方案" : "已建立獎金方案");
      await queryClient.invalidateQueries({ queryKey: staffBonusPlansQueryKey(merchantId) });
      onOpenChange(false);
    } catch (err) {
      setServerError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const serviceOptions = useMemo(
    () =>
      listing.service_items.map((s) => ({
        value: s.id,
        label: s.name,
        removed: s.status !== "active",
      })),
    [listing.service_items],
  );

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        dirty={formDirty.dirty && !saving}
        title={plan ? `編輯「${plan.name}」` : "新增獎金方案"}
        subtitle={EDITOR_SUBTITLE}
        footer={
          <div className="flex flex-col gap-2">
            {saveBlocker ? (
              <AlertNote data-testid="bonus-plan-save-blocker">{saveBlocker}</AlertNote>
            ) : null}
            <ActionBar>
              <FullPageLayerClose asChild>
                <Button type="button" variant="neutral" size="touch" disabled={saving}>
                  取消
                </Button>
              </FullPageLayerClose>
              <Button
                type="submit"
                form={EDITOR_FORM_ID}
                variant="primary"
                size="touch"
                disabled={saving || saveBlocker !== null}
                data-testid="bonus-plan-save"
              >
                {saving ? "儲存中⋯" : "儲存"}
              </Button>
            </ActionBar>
          </div>
        }
      >
        {/* 全頁層寬度對齊頁面內容欄(這一頁 max-w-3xl,#1010),放不下左右兩欄 ⇒ 試算一律接在規則下面。 */}
        <div className="flex flex-col gap-6">
          <form id={EDITOR_FORM_ID} onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-5">
            <FormField
              label="方案名稱"
              htmlFor="bonus-plan-name"
              required
              error={nameError}
              counter={{ value: name.trim().length, max: BONUS_PLAN_NAME_MAX }}
            >
              <FieldInput
                id="bonus-plan-name"
                value={name}
                placeholder="例：冷氣組"
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
              />
            </FormField>

            <section className="flex flex-col gap-3" aria-label="獎金規則">
              <p className="text-sm font-semibold text-foreground">獎金規則</p>
              {drafts.map((draft, index) => (
                <BonusRuleCard
                  key={draft.key}
                  index={index}
                  total={drafts.length}
                  draft={draft}
                  errors={errorsByIndex[index] ?? {}}
                  serviceOptions={serviceOptions}
                  serviceNameOf={serviceNameOf}
                  merchantId={merchantId}
                  monthlyStaff={monthlyStaff}
                  thisMonth={listing.this_month}
                  onFormulaCheck={(state) =>
                    setFormulaChecks((prev) => ({ ...prev, [draft.key]: state }))
                  }
                  onChange={(patch) => updateDraft(index, patch)}
                  onMove={(delta) => moveDraft(index, delta)}
                  onRemove={() => removeDraft(index)}
                />
              ))}
              {drafts.length === 0 ? <AlertNote>至少要有 1 條規則才能儲存。</AlertNote> : null}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="neutral"
                  size="touch"
                  className="self-start"
                  disabled={drafts.length >= BONUS_RULE_MAX_COUNT}
                  onClick={addDraft}
                  data-testid="bonus-rule-add"
                >
                  新增規則
                </Button>
                {drafts.length >= BONUS_RULE_MAX_COUNT ? (
                  <AlertNote>{`一個方案最多 ${BONUS_RULE_MAX_COUNT} 條規則。`}</AlertNote>
                ) : null}
              </div>
            </section>

            <FormField label="從哪個月開始生效" required>
              <ChoiceChipGroup
                aria-label="從哪個月開始生效"
                value={effective}
                onValueChange={setEffective}
                options={EFFECTIVE_OPTIONS}
              />
              <p className="text-xs text-muted-foreground">{EFFECTIVE_NOTE}</p>
            </FormField>
            {plan?.next_version && effective === "this_month" ? (
              <AlertNote>{NEXT_MONTH_OVERRIDE_NOTE}</AlertNote>
            ) : null}
            {showErrors && !parsed.ok ? (
              <AlertNote tone="danger">有規則還沒填好，請看上面標紅字的欄位。</AlertNote>
            ) : null}
            {serverError ? <AlertNote tone="danger">{serverError}</AlertNote> : null}
          </form>

          <BonusPreviewPanel
            merchantId={merchantId}
            monthlyStaff={monthlyStaff}
            thisMonth={listing.this_month}
            rules={parsed.ok ? parsed.rules : null}
          />
        </div>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

function BonusRuleCard({
  index,
  total,
  draft,
  errors,
  serviceOptions,
  serviceNameOf,
  merchantId,
  monthlyStaff,
  thisMonth,
  onFormulaCheck,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  draft: BonusRuleDraft;
  errors: Partial<Record<BonusRuleDraftField, string>>;
  serviceOptions: Array<{ value: string; label: string; removed: boolean }>;
  serviceNameOf: (id: string) => string | undefined;
  merchantId: string;
  monthlyStaff: MerchantStaff[];
  thisMonth: string;
  onFormulaCheck: (state: BonusFormulaCheckState | undefined) => void;
  onChange: (patch: Partial<BonusRuleDraft>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const prefix = `bonus-rule-${draft.key}`;
  const unit = bonusDraftUnit(draft);
  const summary = describeBonusRuleDraft(draft, serviceNameOf);
  const selected = useMemo(() => new Set(draft.serviceItemIds), [draft.serviceItemIds]);
  const isLump = draft.kind === "lump_sum";
  const isFormula = draft.kind === "formula";

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-3.5"
      data-testid="bonus-rule-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{`第 ${index + 1} 條`}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="neutral"
            size="card"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label={`第 ${index + 1} 條往上移`}
          >
            上移
          </Button>
          <Button
            type="button"
            variant="neutral"
            size="card"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            aria-label={`第 ${index + 1} 條往下移`}
          >
            下移
          </Button>
          <Button
            type="button"
            variant="neutral"
            size="card"
            onClick={onRemove}
            aria-label={`刪除第 ${index + 1} 條`}
          >
            刪除
          </Button>
        </div>
      </div>

      <FormField label="給什麼" required>
        <ChoiceChipGroup<BonusRuleKind>
          aria-label={`第 ${index + 1} 條給什麼`}
          value={draft.kind}
          onValueChange={(kind) => {
            onChange({ kind, retroactive: kind === "lump_sum" ? false : draft.retroactive });
            if (kind !== "formula") onFormulaCheck(undefined);
          }}
          options={BONUS_EDITOR_KIND_OPTIONS}
        />
      </FormField>

      {isFormula ? (
        <BonusFormulaFields
          index={index}
          ruleKey={draft.key}
          text={draft.formulaText}
          draftError={errors.formula}
          merchantId={merchantId}
          monthlyStaff={monthlyStaff}
          thisMonth={thisMonth}
          serviceOptions={serviceOptions}
          onTextChange={(formulaText) => onChange({ formulaText })}
          onCheckChange={onFormulaCheck}
        />
      ) : null}

      {isLump ? (
        <FormField label="用什麼量判斷達標" required>
          <ChoiceChipGroup<BonusMetric>
            aria-label={`第 ${index + 1} 條用什麼量判斷達標`}
            value={draft.lumpSumMetric}
            onValueChange={(lumpSumMetric) => onChange({ lumpSumMetric })}
            options={BONUS_METRIC_OPTIONS}
          />
        </FormField>
      ) : null}

      {!isFormula ? (
        <>
          <FormField label="只算這些服務">
            <FieldMultiSelect
              id={`${prefix}-services`}
              aria-label={`第 ${index + 1} 條只算這些服務`}
              options={serviceOptions}
              selected={selected}
              placeholder="全部服務"
              onToggle={(value, next) => {
                const set = new Set(draft.serviceItemIds);
                if (next) set.add(value);
                else set.delete(value);
                onChange({ serviceItemIds: [...set] });
              }}
              testIdPrefix={`${prefix}-services`}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={isLump ? `達到多少就給（${unit}）` : `超過多少後才開始算（${unit}）`}
              htmlFor={`${prefix}-threshold`}
              required
              error={errors.threshold}
              helpLabel={
                draft.kind === "percent" || (isLump && draft.lumpSumMetric === "revenue")
                  ? "說明：業績怎麼算"
                  : undefined
              }
              help={
                draft.kind === "percent" || (isLump && draft.lumpSumMetric === "revenue")
                  ? REVENUE_HELP
                  : undefined
              }
            >
              <FieldInput
                id={`${prefix}-threshold`}
                inputMode="decimal"
                className="tabular-nums"
                value={draft.threshold}
                onChange={(e) => onChange({ threshold: e.target.value })}
              />
            </FormField>
            <FormField
              label={`算到多少為止（${unit}，選填）`}
              htmlFor={`${prefix}-cap`}
              error={errors.cap}
            >
              <FieldInput
                id={`${prefix}-cap`}
                inputMode="decimal"
                className="tabular-nums"
                placeholder="不設上限"
                value={draft.cap}
                onChange={(e) => onChange({ cap: e.target.value })}
              />
            </FormField>
          </div>

          {draft.kind === "percent" ? (
            <FormField
              label="百分比（%）"
              htmlFor={`${prefix}-percent`}
              required
              error={errors.percent}
            >
              <FieldInput
                id={`${prefix}-percent`}
                inputMode="decimal"
                className="tabular-nums"
                value={draft.percent}
                onChange={(e) => onChange({ percent: e.target.value })}
              />
            </FormField>
          ) : (
            <FormField
              label={
                isLump
                  ? "給多少（元）"
                  : draft.kind === "per_order"
                    ? "每單加多少（元）"
                    : "每份加多少（元）"
              }
              htmlFor={`${prefix}-amount`}
              required
              error={errors.amount}
            >
              <FieldAmountInput
                id={`${prefix}-amount`}
                value={draft.amount}
                onChange={(e) => onChange({ amount: e.target.value })}
              />
            </FormField>
          )}

          {!isLump ? (
            <SwitchRow
              title="達標後整月都算"
              description={RETROACTIVE_HELP}
              descriptionMode="popover"
              helpLabel="說明：達標後整月都算是什麼"
              checked={draft.retroactive}
              onCheckedChange={(retroactive) => onChange({ retroactive })}
            />
          ) : null}
        </>
      ) : null}

      <FormField
        label="規則名稱（選填）"
        htmlFor={`${prefix}-label`}
        error={errors.label}
        counter={{ value: draft.label.trim().length, max: BONUS_RULE_LABEL_MAX }}
      >
        <FieldInput
          id={`${prefix}-label`}
          value={draft.label}
          placeholder={isFormula ? "空白時名稱是「自訂公式」" : "空白時用下面這句話當名稱"}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </FormField>

      <p
        className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed text-foreground"
        data-testid="bonus-rule-summary"
      >
        {summary ?? "填好數字後，這裡會用一句話說明這條規則怎麼算。"}
      </p>
    </div>
  );
}

function monthInputValue(month: string): string {
  return month.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function BonusPreviewPanel({
  merchantId,
  monthlyStaff,
  thisMonth,
  rules,
}: {
  merchantId: string;
  monthlyStaff: MerchantStaff[];
  thisMonth: string;
  rules: BonusRule[] | null;
}) {
  const [staffId, setStaffId] = useState<string>(monthlyStaff[0]?.id ?? "");
  const [month, setMonth] = useState<string>(monthInputValue(thisMonth));
  const [result, setResult] = useState<StaffMonthlyBonus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const rulesKey = rules ? JSON.stringify(rules) : null;

  useEffect(() => {
    if (!staffId && monthlyStaff[0]) setStaffId(monthlyStaff[0].id);
  }, [monthlyStaff, staffId]);

  useEffect(() => {
    if (!rulesKey || !staffId || !month || rules === null || rules.length === 0) {
      setResult(null);
      setError(null);
      return;
    }
    const current = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      previewStaffBonus({ merchantId, rules, staffId, month: `${month}-01` })
        .then((r) => {
          if (seq.current !== current) return;
          setResult(r);
          setError(null);
        })
        .catch((err: unknown) => {
          if (seq.current !== current) return;
          setResult(null);
          setError(getErrorMessage(err));
        })
        .finally(() => {
          if (seq.current === current) setLoading(false);
        });
    }, 600);
    return () => clearTimeout(timer);
    // rules 用 rulesKey 判斷有沒有變。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, staffId, month, merchantId]);

  return (
    <aside
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/20 p-3.5"
      data-testid="bonus-preview"
    >
      <p className="text-sm font-semibold text-foreground">試算</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{PREVIEW_HELP}</p>
      {monthlyStaff.length === 0 ? (
        <p className="text-sm text-muted-foreground">沒有月薪人員可以試算</p>
      ) : (
        <>
          <FormField label="月薪人員" htmlFor="bonus-preview-staff">
            <FieldSelect
              id="bonus-preview-staff"
              value={staffId}
              onValueChange={guardPhantomEmptyChange(setStaffId)}
              options={monthlyStaff.map((s) => ({ value: s.id, label: s.name }))}
            />
          </FormField>
          <FormField label="月份" htmlFor="bonus-preview-month">
            <FieldMonth
              id="bonus-preview-month"
              value={month}
              min={shiftMonth(thisMonth, -23)}
              max={monthInputValue(thisMonth)}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
              }}
            />
          </FormField>
          {rules === null ? (
            <p className="text-sm text-muted-foreground">規則填好之後會自動試算。</p>
          ) : loading && !result ? (
            <LoadingSkeleton variant="lines" rows={2} />
          ) : error ? (
            <AlertNote tone="danger">{error}</AlertNote>
          ) : result ? (
            <div data-testid="bonus-preview-result">
              <DetailSection tone="amount" className="gap-1">
                {result.rules.map((r) => (
                  <DetailRow
                    key={r.key}
                    size="sm"
                    label={`${r.label}（${describeBonusRuleResult(r)}）`}
                  >
                    {`${formatBonusNumber(Number(r.amount))} 元`}
                  </DetailRow>
                ))}
                <DetailRow label="合計">{`${formatBonusNumber(Number(result.amount))} 元`}</DetailRow>
                {bonusFlagNotes(result.flags).map((n) => (
                  <AlertNote key={`preview-flag-${n}`}>{n}</AlertNote>
                ))}
              </DetailSection>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
