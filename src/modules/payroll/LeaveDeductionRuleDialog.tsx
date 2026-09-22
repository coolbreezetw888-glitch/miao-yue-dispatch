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
import { previewLeaveDeductionPerDay, calculateDayRate, getDaysInMonth } from "./previewCalculators";
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
  const exampleDayRate = calculateDayRate(exampleMonthlySalary, getDaysInMonth(now.getFullYear(), now.getMonth() + 1));
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

            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              範例試算:假設月薪 {exampleMonthlySalary} 元(依本月實際天數換算,一天薪水約{" "}
              {exampleDayRate.toFixed(2)} 元),請這個假一天扣{" "}
              <strong>{previewPerDay}</strong> 元(僅供參考,實際扣款以每位服務人員自己的月薪、
              請假當月的實際天數計算為準)。
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
