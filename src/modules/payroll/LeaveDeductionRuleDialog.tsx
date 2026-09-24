// 對應模組 8(薪資與帳務)規格書 §4.2:假別扣款規則設定 Dialog,由模組 7 LeaveTypesPage.tsx
// 的每一列假別旁「扣款規則」按鈕開啟。選擇扣款模式(四選一單選)、依模式顯示對應的數值輸入欄
// (百分比或固定金額),送出呼叫本模組的 upsertLeaveTypeDeductionRule。
//
// 這個元件是「掛載點借用模組 7 既有頁面」,不修改模組 7 原本的假別新增/編輯/上下架邏輯本身
// (呼應模組獨立性原則——本模組的資料/邏輯自己管,只是掛載點借用既有畫面)。

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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

export function LeaveDeductionRuleDialog({
  merchantId,
  leaveTypeId,
  leaveTypeName,
  trigger,
}: {
  merchantId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data: rule, isLoading } = useLeaveTypeDeductionRule(open ? leaveTypeId : null);

  const [mode, setMode] = useState<DeductionMode>("no_deduction");
  const [percentageValue, setPercentageValue] = useState("0");
  const [fixedAmountValue, setFixedAmountValue] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !rule) return;
    setMode(rule.deduction_mode as DeductionMode);
    setPercentageValue(rule.percentage_value !== null ? String(rule.percentage_value) : "0");
    setFixedAmountValue(rule.fixed_amount_value !== null ? String(rule.fixed_amount_value) : "0");
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
      const numeric = Number(fixedAmountValue);
      if (Number.isNaN(numeric) || numeric < 0) {
        toast.error("固定金額不可為負數");
        return;
      }
      fixedAmountToSave = numeric;
    }

    setSaving(true);
    try {
      await upsertLeaveTypeDeductionRule(merchantId, leaveTypeId, {
        deductionMode: mode,
        percentageValue: percentageToSave,
        fixedAmountValue: fixedAmountToSave,
      });
      toast.success("已更新扣款規則");
      setOpen(false);
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>「{leaveTypeName}」的扣款規則</DialogTitle>
          <DialogDescription>
            設定請這個假的扣款計算模式與數值,系統不會自動幫你套用任何非零數字,請自己填入實際
            要扣多少。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as DeductionMode)}
              className="space-y-2"
            >
              {DEDUCTION_MODES.map((m) => (
                <div key={m} className="flex items-center gap-2">
                  <RadioGroupItem value={m} id={`deduction-mode-${m}`} />
                  <Label htmlFor={`deduction-mode-${m}`} className="font-normal">
                    {DEDUCTION_MODE_LABELS[m]}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {mode === "percentage_of_day_rate" ? (
              <div>
                <Label htmlFor="percentage-value">每天扣一天薪水的百分比(%)</Label>
                <Input
                  id="percentage-value"
                  className="mt-2 w-32"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={percentageValue}
                  onChange={(e) => setPercentageValue(e.target.value)}
                />
              </div>
            ) : null}

            {mode === "fixed_amount_per_day" ? (
              <div>
                <Label htmlFor="fixed-amount-value">每天扣固定金額(元)</Label>
                <Input
                  id="fixed-amount-value"
                  className="mt-2 w-32"
                  type="number"
                  min={0}
                  step="1"
                  value={fixedAmountValue}
                  onChange={(e) => setFixedAmountValue(e.target.value)}
                />
              </div>
            ) : null}

            {/* 2026-09-24:句型跟 PayrollSettingsPage.tsx 月薪制服務人員編輯對話框的「試算:以本月 N 天
                換算⋯天數由系統依請假當月自動換算,不用另外設定」對齊,讓兩個對話框講同一套話。
                跟那邊刻意不同的兩點:(1) 這裡是全店共用的假別、不綁定特定人,所以月薪是假想數字,
                「僅供參考、實際以每位服務人員自己的月薪為準」這句不能省;(2) 這裡不在薪資設定頁,
                不寫「詳見上方【月薪制】月折算天數」,那個欄位不在這一頁,指過去會讓人找不到。 */}
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              試算:假設月薪 {exampleMonthlySalary} 元,以本月 {exampleDaysInMonth} 天換算,一天薪水約{" "}
              {exampleDayRate.toFixed(2)} 元,請這個假一天扣 <strong>{previewPerDay}</strong> 元。
              天數由系統依請假當月自動換算,不用另外設定;這裡的月薪只是範例,僅供參考,實際扣款以每位
              服務人員自己的月薪計算為準。
            </p>

            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "儲存中⋯" : "儲存"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
