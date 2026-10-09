// 客戶端第 5 批(C5-K02、C5-Q01~Q03):「LINE 通知事件」頁最上方的「通知客人」卡。
// 規格:.project/specs/客戶端第5批-LINE通知與綁定.md;純邏輯在 customerLineSettingsLogic.ts。
//
// ・權限跟這一頁一樣(管理員 + 有 LINE 通知權限的客服,頁面外層 RequireLineNotificationAccess 已擋;
//   資料庫函式也擋)。
// ・每種通知一列:開關(切換立即儲存)+ 何時發 + 大約用幾則 +「編輯文字」(展開文字框 + 變數按鈕 + 即時預覽)。
//   文字改過才出現「恢復預設」;沒改時「儲存文字」停用並常駐黃色 !(ui-overlay-patterns 二之三)。
// ・同一頁很多張一樣的卡,儲存鈕一律用次要(skill 二之三例外條款)。
// ・5-B(#1047):額度區(本月已用幾則、停發中紅字)+ 每月客人通知上限(只有管理員看得到、改得到)、
//   服務前提醒(含「服務前 N 小時」下拉,改了立即儲存)、服務完成、聯絡人申請與移除。

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Loader2 } from "lucide-react";

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
  ErrorState,
  FieldInput,
  FieldNativeSelect,
  FieldTextarea,
  FormField,
  HelpToggle,
  LoadingSkeleton,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  customerLineSettingsQueryKey,
  lineQuotaStatusQueryKey,
  setCustomerLineMonthlyCap,
  updateCustomerLineSettings,
  useCustomerLineSettings,
  useLineQuotaStatus,
  type CustomerLineSettingsPatch,
} from "./customerLineSettingsApi";
import {
  countTemplateChars,
  customerLineSaveErrorMessage,
  CUSTOMER_LINE_KINDS,
  CUSTOMER_LINE_TEMPLATE_MAX,
  CUSTOMER_LINE_USAGE,
  CUSTOMER_SELF_OPT_OUT_NOTE,
  customerLineSampleValues,
  customerLineTemplateVariables,
  effectiveCustomerLineTemplate,
  formatMonthlyCapReadonly,
  formatQuotaSummary,
  isQuotaBlocked,
  LINE_LOGIN_OFF_NOTE,
  MONTHLY_CAP_HELP,
  MONTHLY_CAP_INVALID_MESSAGE,
  monthlyCapToInput,
  NOT_CONNECTED_NOTE,
  parseMonthlyCapInput,
  QUOTA_BLOCKED_NOTE,
  QUOTA_HELP,
  QUOTA_LINE_UNAVAILABLE_NOTE,
  REMINDER_HOURS_OPTIONS,
  renderCustomerLineTemplate,
  validateCustomerLineTemplate,
  type CustomerLineKindDefinition,
  type CustomerLineSettings,
  type CustomerLineSwitchKey,
  type CustomerLineTemplateCode,
} from "./customerLineSettingsLogic";
import { TemplateVariablePreview } from "./TemplateVariablePreview";

export interface CustomerLineSettingsCardProps {
  merchantId: string;
  merchantName: string | null | undefined;
  merchantPhone: string | null | undefined;
  bookingSlug: string | null | undefined;
  isOnSite: boolean;
}

export function CustomerLineSettingsCard(props: CustomerLineSettingsCardProps) {
  const { merchantId } = props;
  const queryClient = useQueryClient();
  const { data: role } = useCurrentMerchantRole();
  const { data: settings, isLoading, isError, refetch } = useCustomerLineSettings(merchantId);
  const [savingSwitch, setSavingSwitch] = useState<CustomerLineSwitchKey | null>(null);
  const [savingHours, setSavingHours] = useState(false);

  async function save(patch: CustomerLineSettingsPatch): Promise<boolean> {
    try {
      const next = await updateCustomerLineSettings(merchantId, patch);
      queryClient.setQueryData(customerLineSettingsQueryKey(merchantId), next);
      return true;
    } catch (err) {
      toast.error("儲存失敗", { description: customerLineSaveErrorMessage(err) });
      return false;
    }
  }

  async function toggle(key: CustomerLineSwitchKey, value: boolean) {
    if (!settings || savingSwitch) return;
    const before = settings;
    // 先改畫面,失敗再退回。
    queryClient.setQueryData<CustomerLineSettings>(customerLineSettingsQueryKey(merchantId), {
      ...before,
      switches: { ...before.switches, [key]: value },
    });
    setSavingSwitch(key);
    const ok = await save({ switches: { [key]: value } });
    if (!ok) {
      queryClient.setQueryData(customerLineSettingsQueryKey(merchantId), before);
    } else {
      toast.success("已儲存通知客人設定");
    }
    setSavingSwitch(null);
  }

  async function changeReminderHours(hours: number) {
    if (!settings || savingHours || hours === settings.reminderHoursBefore) return;
    const before = settings;
    queryClient.setQueryData<CustomerLineSettings>(customerLineSettingsQueryKey(merchantId), {
      ...before,
      reminderHoursBefore: hours,
    });
    setSavingHours(true);
    const ok = await save({ reminderHoursBefore: hours });
    if (!ok) {
      queryClient.setQueryData(customerLineSettingsQueryKey(merchantId), before);
    } else {
      toast.success("已儲存提醒時間");
    }
    setSavingHours(false);
  }

  // 每月上限只有管理員(伺服器回的 is_admin 為準;沒回時看目前角色)。
  const isAdmin = settings ? (settings.isAdmin ?? role === "admin") : false;

  return (
    <Card data-testid="customer-line-card">
      <CardContent className="flex flex-col gap-4 pt-6">
        <div>
          <h2 className="text-base font-bold text-foreground">通知客人</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
            預約有變動時，用 LINE 通知會員（下單的聯絡人與主要聯絡人）。
          </p>
        </div>

        {isLoading ? (
          <LoadingSkeleton variant="cards" rows={2} />
        ) : isError || !settings ? (
          <ErrorState
            title="讀不到通知客人的設定"
            reason="可能是網路不穩"
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {!settings.isConnected ? (
              <AlertNote data-testid="customer-line-not-connected">
                <span>{NOT_CONNECTED_NOTE}</span>
                {role === "admin" ? (
                  <Link
                    to="/app/line-settings"
                    className="ml-1 font-semibold underline underline-offset-2"
                  >
                    去 LINE 串接設定
                  </Link>
                ) : (
                  <span>請商家管理員到「LINE 串接設定」接上。</span>
                )}
              </AlertNote>
            ) : null}
            {!settings.lineLoginEnabled ? (
              <p
                className="text-[13px] leading-relaxed text-muted-foreground"
                data-testid="customer-line-login-off"
              >
                {LINE_LOGIN_OFF_NOTE}
              </p>
            ) : null}
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[13px] leading-relaxed text-foreground"
              data-testid="customer-line-quota-note"
            >
              {CUSTOMER_LINE_USAGE.quotaNote}
            </p>

            <QuotaSection
              merchantId={merchantId}
              settings={settings}
              isAdmin={isAdmin}
              onSaved={(next) =>
                queryClient.setQueryData(customerLineSettingsQueryKey(merchantId), next)
              }
            />

            <div className="flex flex-col gap-3">
              {CUSTOMER_LINE_KINDS.map((kind) => (
                <KindRow
                  key={kind.key}
                  kind={kind}
                  settings={settings}
                  saving={savingSwitch === kind.key}
                  onToggle={(v) => void toggle(kind.key, v)}
                  savingHours={savingHours}
                  onChangeHours={(h) => void changeReminderHours(h)}
                  onSaveTemplate={save}
                  cardProps={props}
                />
              ))}
            </div>

            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {CUSTOMER_SELF_OPT_OUT_NOTE}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function KindRow({
  kind,
  settings,
  saving,
  onToggle,
  savingHours,
  onChangeHours,
  onSaveTemplate,
  cardProps,
}: {
  kind: CustomerLineKindDefinition;
  settings: CustomerLineSettings;
  saving: boolean;
  onToggle: (value: boolean) => void;
  savingHours: boolean;
  onChangeHours: (hours: number) => void;
  onSaveTemplate: (patch: CustomerLineSettingsPatch) => Promise<boolean>;
  cardProps: CustomerLineSettingsCardProps;
}) {
  const [editing, setEditing] = useState(false);
  const checked = settings.switches[kind.key];
  return (
    <div data-testid={`customer-line-kind-${kind.key}`}>
      <SwitchRow
        title={
          <>
            {kind.title}
            {saving ? (
              <Loader2
                className="ml-1.5 inline h-3.5 w-3.5 animate-spin align-[-2px] text-muted-foreground"
                aria-hidden="true"
              />
            ) : null}
          </>
        }
        description={kind.when}
        checked={checked}
        disabled={saving}
        onCheckedChange={onToggle}
      >
        <p className="text-xs leading-snug text-muted-foreground" data-testid="customer-line-usage">
          {`大約用量：${kind.usage}`}
        </p>
        {kind.key === "on_reminder" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label
              htmlFor="customer-line-reminder-hours"
              className="text-[13px] font-semibold text-foreground"
            >
              服務前
            </label>
            <FieldNativeSelect
              id="customer-line-reminder-hours"
              className="w-24"
              value={String(settings.reminderHoursBefore)}
              disabled={savingHours}
              onChange={(e) => onChangeHours(Number(e.target.value))}
              options={REMINDER_HOURS_OPTIONS.map((h) => ({ value: String(h), label: String(h) }))}
              data-testid="customer-line-reminder-hours"
            />
            <span className="text-[13px] text-foreground">小時提醒</span>
            {savingHours ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : null}
          </div>
        ) : null}
        <Button
          type="button"
          variant="text"
          size="card"
          className="mt-1 -ml-2 px-2"
          aria-expanded={editing}
          onClick={() => setEditing((v) => !v)}
          data-testid="customer-line-edit-toggle"
        >
          {editing ? "收起文字" : "編輯文字"}
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", editing && "rotate-180")}
            aria-hidden="true"
          />
        </Button>
        {editing ? (
          <div className="mt-2 flex flex-col gap-4">
            {kind.templates.map((t) => (
              <TemplateEditor
                key={t.code}
                code={t.code}
                label={t.label}
                settings={settings}
                onSave={onSaveTemplate}
                cardProps={cardProps}
              />
            ))}
          </div>
        ) : null}
      </SwitchRow>
    </div>
  );
}

function TemplateEditor({
  code,
  label,
  settings,
  onSave,
  cardProps,
}: {
  code: CustomerLineTemplateCode;
  label: string | null;
  settings: CustomerLineSettings;
  onSave: (patch: CustomerLineSettingsPatch) => Promise<boolean>;
  cardProps: CustomerLineSettingsCardProps;
}) {
  const isOnSite = settings.isOnSite ?? cardProps.isOnSite;
  const current = effectiveCustomerLineTemplate(settings, code, isOnSite);
  const defaultText = effectiveCustomerLineTemplate({ ...settings, templates: {} }, code, isOnSite);
  const customized = settings.templates[code] !== undefined;
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  // 恢復預設 = 刪掉店家自訂的文字、沒辦法還原 ⇒ 先問一次(ui-overlay-patterns:確認窗 + 危險樣式)。
  const [confirmRestore, setConfirmRestore] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = text.trim() !== current.trim();
  const tooLong = validateCustomerLineTemplate(text) === "too_long";
  const empty = text.trim() === "";
  const variables = customerLineTemplateVariables(code);
  const sampleValues = customerLineSampleValues({
    merchantName: cardProps.merchantName,
    merchantPhone: cardProps.merchantPhone,
    bookingSlug: cardProps.bookingSlug,
    siteOrigin: typeof window !== "undefined" ? window.location.origin : "",
  });
  const fieldId = `customer-line-template-${code}`;

  function insertVariable(key: string) {
    const token = `{{${key}}}`;
    const el = textareaRef.current;
    if (!el) {
      setText((v) => v + token);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function handleSave(value: string, restore: boolean): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    const ok = await onSave({ templates: { [code]: restore ? "" : value.trim() } });
    setBusy(false);
    if (ok) {
      toast.success(restore ? "已恢復預設文字" : "已儲存通知文字");
      if (restore) setText(defaultText);
    }
    return ok;
  }

  async function runRestore() {
    const ok = await handleSave("", true);
    if (ok) setConfirmRestore(false);
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`customer-line-template-${code}`}>
      <FormField
        label={label ? `文字：${label}` : "文字"}
        htmlFor={fieldId}
        counter={{ value: countTemplateChars(text), max: CUSTOMER_LINE_TEMPLATE_MAX }}
        error={tooLong ? `最多 ${CUSTOMER_LINE_TEMPLATE_MAX} 字，請刪短一點。` : null}
      >
        <FieldTextarea
          id={fieldId}
          ref={textareaRef}
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </FormField>
      <div className="flex flex-wrap gap-1.5" aria-label="插入變數">
        {variables.map((v) => (
          <button
            key={v.key}
            type="button"
            className="min-h-9 cursor-pointer rounded-md border border-border bg-background px-2.5 text-[12.5px] text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => insertVariable(v.key)}
            aria-label={`插入變數：${v.label}`}
          >
            {`+ ${v.label}`}
          </button>
        ))}
      </div>
      <TemplateVariablePreview
        variables={variables}
        sampleValues={sampleValues}
        recipientLabel="客人"
        previews={[
          {
            text: renderCustomerLineTemplate(empty ? defaultText : text, sampleValues).trim(),
          },
        ]}
      />
      {empty ? (
        <p className="text-xs leading-snug text-muted-foreground">
          文字留空並儲存，會恢復成預設文字（上面預覽的就是預設文字）。
        </p>
      ) : null}
      {!dirty ? <AlertNote>還沒有修改文字。</AlertNote> : null}
      <div className="flex flex-wrap gap-2">
        {customized ? (
          <Button
            type="button"
            variant="neutral"
            size="card"
            disabled={busy}
            onClick={() => setConfirmRestore(true)}
            data-testid="customer-line-template-restore"
          >
            恢復預設
          </Button>
        ) : null}
        <Button
          type="button"
          variant="neutral"
          size="card"
          disabled={busy || !dirty || tooLong}
          onClick={() => {
            // 留空儲存 = 恢復預設;店家有自訂文字時一樣要先確認(會刪掉、不能還原)。
            if (empty && customized) setConfirmRestore(true);
            else void handleSave(text, empty);
          }}
          data-testid="customer-line-template-save"
        >
          {busy ? "儲存中⋯" : "儲存文字"}
        </Button>
      </div>

      <CardAlertDialog
        open={confirmRestore}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRestore(false);
        }}
      >
        <CardAlertDialogContent
          data-testid="customer-line-template-restore-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>恢復成預設文字嗎？</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              你自訂的通知文字會被刪掉，改回系統預設文字，刪掉後無法還原。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={busy}>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void runRestore();
              }}
              data-testid="customer-line-template-restore-confirm"
            >
              {busy ? "處理中⋯" : "恢復預設"}
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </div>
  );
}

// =========================================================================
// 5-B 額度區(C5-Q02)+ 每月客人通知上限(C5-Q01,只有管理員看得到、改得到)
// =========================================================================

function QuotaSection({
  merchantId,
  settings,
  isAdmin,
  onSaved,
}: {
  merchantId: string;
  settings: CustomerLineSettings;
  isAdmin: boolean;
  onSaved: (next: CustomerLineSettings) => void;
}) {
  const queryClient = useQueryClient();
  // 沒接上官方帳號就不查 LINE(查不到,也不會有用量)。
  const quota = useLineQuotaStatus(merchantId, settings.isConnected);
  const blockedUntil = settings.quotaBlockedUntil ?? quota.data?.blockedUntil ?? null;
  const blocked = isQuotaBlocked(blockedUntil);

  const [capText, setCapText] = useState(monthlyCapToInput(settings.monthlyCap));
  const [savingCap, setSavingCap] = useState(false);
  useEffect(() => {
    setCapText(monthlyCapToInput(settings.monthlyCap));
  }, [settings.monthlyCap]);

  const parsed = parseMonthlyCapInput(capText);
  const invalid = !parsed.ok;
  const dirty = parsed.ok ? parsed.value !== settings.monthlyCap : true;

  async function saveCap() {
    if (!parsed.ok || savingCap || !dirty) return;
    setSavingCap(true);
    try {
      const next = await setCustomerLineMonthlyCap(merchantId, parsed.value);
      onSaved(next);
      setCapText(monthlyCapToInput(next.monthlyCap));
      toast.success(next.monthlyCap === null ? "已改成不限制" : "已儲存每月上限");
      void queryClient.invalidateQueries({ queryKey: lineQuotaStatusQueryKey(merchantId) });
    } catch (err) {
      toast.error("儲存失敗", { description: customerLineSaveErrorMessage(err) });
    } finally {
      setSavingCap(false);
    }
  }

  // 客服 + 沒接上官方帳號:沒有用量可看、也不能改上限 ⇒ 整區不出現。
  if (!settings.isConnected && !isAdmin) return null;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3"
      data-testid="customer-line-quota"
    >
      {settings.isConnected ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            <p className="text-sm font-semibold text-foreground">本月訊息額度</p>
            <HelpToggle label="說明：本月訊息額度怎麼算">{QUOTA_HELP}</HelpToggle>
          </div>
          {quota.isLoading ? (
            <LoadingSkeleton variant="cards" rows={1} />
          ) : quota.isError || !quota.data ? (
            <div className="flex flex-wrap items-center gap-x-1">
              <p
                className="text-[13px] leading-relaxed text-muted-foreground"
                data-testid="customer-line-quota-error"
              >
                暫時查不到本月用量。
              </p>
              <Button
                type="button"
                variant="text"
                size="card"
                className="px-1.5"
                onClick={() => void quota.refetch()}
              >
                重新查詢
              </Button>
            </div>
          ) : (
            <>
              <p
                className="break-words text-[13px] leading-relaxed tabular-nums text-foreground"
                data-testid="customer-line-quota-summary"
              >
                {formatQuotaSummary(quota.data)}
              </p>
              {quota.data.used === null ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  {QUOTA_LINE_UNAVAILABLE_NOTE}
                </p>
              ) : null}
            </>
          )}
          {blocked ? (
            <p
              className="text-[13px] font-semibold leading-relaxed text-destructive"
              data-testid="customer-line-quota-blocked"
            >
              {QUOTA_BLOCKED_NOTE}
            </p>
          ) : null}
        </div>
      ) : null}

      {isAdmin ? (
        <div className="flex flex-col gap-2" data-testid="customer-line-monthly-cap">
          <FormField
            label="每月客人通知上限"
            htmlFor="customer-line-monthly-cap"
            help={MONTHLY_CAP_HELP}
            helpLabel="說明：每月客人通知上限是什麼"
            error={invalid ? MONTHLY_CAP_INVALID_MESSAGE : null}
          >
            <div className="flex flex-wrap items-center gap-2">
              <FieldInput
                id="customer-line-monthly-cap"
                inputMode="numeric"
                className="w-32"
                placeholder="不限制"
                value={capText}
                disabled={savingCap}
                onChange={(e) => setCapText(e.target.value)}
                data-testid="customer-line-monthly-cap-input"
              />
              <span className="text-[13px] text-foreground">則（留空 = 不限制）</span>
            </div>
          </FormField>
          {!dirty ? <AlertNote>還沒有修改上限。</AlertNote> : null}
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="self-start"
            disabled={savingCap || !dirty || invalid}
            onClick={() => void saveCap()}
            data-testid="customer-line-monthly-cap-save"
          >
            {savingCap ? "儲存中⋯" : "儲存上限"}
          </Button>
        </div>
      ) : (
        // c5-contract 5B-1:客服看得到上限數字,但不能改(只有管理員能改)。
        <p
          className="text-[13px] leading-relaxed text-foreground"
          data-testid="customer-line-monthly-cap-readonly"
        >
          {formatMonthlyCapReadonly(settings.monthlyCap)}
        </p>
      )}
    </section>
  );
}
