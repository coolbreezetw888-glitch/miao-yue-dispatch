// 對應模組 8(薪資與帳務)規格書 §4.2:假別扣款規則設定 Dialog,由模組 7 LeaveTypesPage.tsx
// 的每一列假別 ⋯ 選單裡的「扣款規則」開啟。選擇扣款模式(四選一單選)、依模式顯示對應的數值輸入欄
// (百分比或固定金額),送出呼叫本模組的 upsertLeaveTypeDeductionRule。
//
// 這個元件是「掛載點借用模組 7 既有頁面」,不修改模組 7 原本的假別新增/編輯/上下架邏輯本身
// (呼應模組獨立性原則——本模組的資料/邏輯自己管,只是掛載點借用既有畫面)。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 #15):
//   - 外殼改小卡窗(CardDialog),改成受控開關(open / onOpenChange)——觸發點現在是 LeaveTypesPage
//     ListCard 的 ⋯ 選單項目,不再由這個元件自己包 Trigger。
//   - 四選一改 ChoiceChipGroup(skill 二之七:單選用可點的方塊,radiogroup 語意);數值欄改 FormField +
//     FieldInput / FieldAmountInput;底部「取消 / 儲存」。
//   - 試算文字維持原本的虛線灰底區塊(skill 沒有定義「即時試算」的樣式,不另創,已在交付回報中列出)。
// **只動外觀與版面,不動任何行為**:模式白名單、驗證、寫入照舊。

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  ChoiceChipGroup,
  ErrorState,
  FieldAmountInput,
  FieldInput,
  FormField,
  LoadingSkeleton,
  parseAmountInput,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { upsertLeaveTypeDeductionRule, useLeaveTypeDeductionRule } from "./api";
import {
  previewLeaveDeductionPerDay,
  calculateDayRate,
  getDaysInMonth,
} from "./previewCalculators";
import { DEDUCTION_MODE_LABELS, type DeductionMode } from "./types";

const DEDUCTION_MODES: DeductionMode[] = [
  "no_deduction",
  "full_day_rate",
  "percentage_of_day_rate",
  "fixed_amount_per_day",
];

const RULE_FORM_ID = "leave-deduction-rule-form";

export function LeaveDeductionRuleDialog({
  merchantId,
  leaveTypeId,
  leaveTypeName,
  open,
  onOpenChange,
}: {
  merchantId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    data: rule,
    isLoading,
    isError,
    refetch,
  } = useLeaveTypeDeductionRule(open ? leaveTypeId : null);

  const [mode, setMode] = useState<DeductionMode>("no_deduction");
  const [percentageValue, setPercentageValue] = useState("0");
  const [fixedAmountValue, setFixedAmountValue] = useState("0");
  const [saving, setSaving] = useState(false);
  // 固定金額的欄位級錯誤(skill 二之七:框變紅 + 下面一行 `!` 說明)。
  const [fixedAmountError, setFixedAmountError] = useState<string | null>(null);

  useEffect(() => {
    // 🔴 2026-09-30 QA:這個 effect 靠「rule 有值」才會跑,所以查詢失敗時三個 state 會停在
    // 初始值(模式 = 不扣款 / 0 / 0)。原本底部的儲存鈕只 disabled 在 saving || isLoading,
    // 「錯誤但不是載入中」的狀態下是可以按的 ⇒ 一按就把真實規則靜默覆寫成「不扣款」。
    // 現在出錯時整個表單換成 ErrorState(下面),儲存鈕也一起擋掉,見 disabled 的條件。
    if (!open || !rule) return;
    setMode(rule.deduction_mode as DeductionMode);
    setPercentageValue(rule.percentage_value !== null ? String(rule.percentage_value) : "0");
    setFixedAmountValue(rule.fixed_amount_value !== null ? String(rule.fixed_amount_value) : "0");
    setFixedAmountError(null);
  }, [open, rule]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    let percentageToSave: number | null = null;
    let fixedAmountToSave: number | null = null;

    if (mode === "percentage_of_day_rate") {
      const numeric = Number(percentageValue);
      if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
        toast.error("百分比必須介於 0~100 之間");
        return;
      }
      percentageToSave = numeric;
    }

    if (mode === "fixed_amount_per_day") {
      // 🔴 2026-09-30:這一欄是 FieldAmountInput(type="text"),原生的 min={0} step="1" 已經不存在,
      // 所以解析走 parseAmountInput + integerOnly(原本 step="1",每天扣的金額不收小數)。
      const parsed = parseAmountInput(fixedAmountValue, { integerOnly: true });
      if (!parsed.ok) {
        setFixedAmountError(parsed.error);
        return;
      }
      setFixedAmountError(null);
      fixedAmountToSave = parsed.value;
    }

    setSaving(true);
    try {
      await upsertLeaveTypeDeductionRule(merchantId, leaveTypeId, {
        deductionMode: mode,
        percentageValue: percentageToSave,
        fixedAmountValue: fixedAmountToSave,
      });
      toast.success("已更新扣款規則");
      onOpenChange(false);
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  // 這裡的試算刻意用固定的範例月薪(3000 元),不是任何一位真實服務人員的實際月薪——這個 Dialog
  // 是針對「假別」設定扣款規則,不是針對特定服務人員,不知道要套用哪位的月薪才合理,用範例數字
  // 純粹幫助商家理解「這個模式/這個數字,實際換算成一天大概是扣多少錢」。
  // §十 10.1:「月折算天數」已改成系統依當月實際天數動態計算,不再是商家設定值,這裡用「本月」
  // 的實際天數預覽試算(純粹輔助理解,不是任何寫入依據)。
  const exampleMonthlySalary = 3000;
  const now = new Date();
  // 抽成變數是為了讓下面的試算文字能寫出「以本月 N 天換算」,跟 PayrollSettingsPage.tsx 月薪制
  // 服務人員編輯對話框的試算句型一致(2026-09-24 使用者要求兩邊用語統一)。
  const exampleDaysInMonth = getDaysInMonth(now.getFullYear(), now.getMonth() + 1);
  const exampleDayRate = calculateDayRate(exampleMonthlySalary, exampleDaysInMonth);
  const previewPerDay = previewLeaveDeductionPerDay(
    exampleDayRate,
    mode,
    mode === "percentage_of_day_rate" ? Number(percentageValue) : null,
    mode === "fixed_amount_per_day" ? Number(fixedAmountValue) : null,
  );

  return (
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent>
        <CardDialogHeader>
          {/* 假別名稱是商家自填的,長度不固定 ⇒ 標題要能折行。 */}
          <CardDialogTitle className="break-words">「{leaveTypeName}」的扣款規則</CardDialogTitle>
          <CardDialogDescription>
            設定請這個假的扣款計算模式與數值,系統不會自動幫你套用任何非零數字,請自己填入實際
            要扣多少。
          </CardDialogDescription>
        </CardDialogHeader>

        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={3} />
        ) : isError ? (
          // 🔴 2026-09-30 QA:讀不到現有規則時不可以顯示表單——表單上的值會是初始值
          // (不扣款 / 0 / 0),使用者以為那是現在的設定,一按儲存就把真實規則覆寫掉。
          <ErrorState
            title="讀不到這個假別現在的扣款規則"
            reason="可能是網路斷了;現在先不顯示表單,避免你把預設值當成現有設定存回去"
            onRetry={() => void refetch()}
          />
        ) : (
          <form id={RULE_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
            <FormField label="扣款模式" required>
              {/* skill 二之七:單選用 ChoiceChipGroup(role="radiogroup",方向鍵可切換)。 */}
              <ChoiceChipGroup
                aria-label="扣款模式"
                value={mode}
                onValueChange={setMode}
                options={DEDUCTION_MODES.map((m) => ({
                  value: m,
                  label: DEDUCTION_MODE_LABELS[m],
                }))}
              />
            </FormField>

            {mode === "percentage_of_day_rate" ? (
              <FormField label="每天扣一天薪水的百分比(%)" htmlFor="percentage-value" required>
                <FieldInput
                  id="percentage-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.01"
                  className="tabular-nums"
                  value={percentageValue}
                  onChange={(e) => setPercentageValue(e.target.value)}
                />
              </FormField>
            ) : null}

            {mode === "fixed_amount_per_day" ? (
              <FormField
                label="每天扣固定金額"
                htmlFor="fixed-amount-value"
                required
                error={fixedAmountError}
                helpLabel="說明:每天扣的金額要怎麼填"
                help="只能填整數(不含小數點),例如 500。"
              >
                <FieldAmountInput
                  id="fixed-amount-value"
                  value={fixedAmountValue}
                  onChange={(e) => {
                    setFixedAmountValue(e.target.value);
                    if (fixedAmountError) setFixedAmountError(null);
                  }}
                />
              </FormField>
            ) : null}

            {/* 2026-09-24:句型跟 PayrollSettingsPage.tsx 月薪制服務人員編輯對話框的「試算:以本月 N 天
                換算⋯天數由系統依請假當月自動換算,不用另外設定」對齊,讓兩個對話框講同一套話。
                跟那邊刻意不同的兩點:(1) 這裡是全店共用的假別、不綁定特定人,所以月薪是假想數字,
                「僅供參考、實際以每位服務人員自己的月薪為準」這句不能省;(2) 這裡不在薪資設定頁,
                不寫「詳見上方【月薪制】月折算天數」,那個欄位不在這一頁,指過去會讓人找不到。 */}
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground tabular-nums">
              試算:假設月薪 {exampleMonthlySalary} 元,以本月 {exampleDaysInMonth} 天換算,一天薪水約{" "}
              {exampleDayRate.toFixed(2)} 元,請這個假一天扣 <strong>{previewPerDay}</strong> 元。
              天數由系統依請假當月自動換算,不用另外設定;這裡的月薪只是範例,僅供參考,實際扣款以每位
              服務人員自己的月薪計算為準。
            </p>
          </form>
        )}

        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={RULE_FORM_ID}
            variant="primary"
            size="touch"
            // 🔴 出錯時也要擋:原本只擋 saving || isLoading,「錯誤但非載入中」是 enabled,
            // 一按就把真實規則覆寫成表單上的初始值(不扣款)。
            disabled={saving || isLoading || isError}
          >
            {saving ? "儲存中⋯" : "儲存"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}
