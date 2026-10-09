// #1035 彈性計薪 B 批 PB-U02:「抽成與薪資設定」頁的「日薪／時薪制服務人員」區塊(放在月薪區塊後面)。
// 每位目前在職的日薪／時薪人員一張卡:姓名|日薪制／時薪制屬性標籤|金額輸入(元／天 或 元／小時),改完立刻存。
// 金額 0 的卡片整張變黃 + 待辦標籤「尚未設定金額」(比照抽成制「尚未設定可接服務」)。沒有人時整個區塊不顯示。
//
// 🔴 金額範圍與小數位由資料庫 set_staff_wage 驗證(PX-05);這裡用 parseAmountInput 只是體驗。

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AttributeTag,
  ErrorState,
  FieldAmountInput,
  FormField,
  ListCard,
  TodoTag,
  parseAmountInput,
} from "@/components/patterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { STAFF_COMPENSATION_TYPE_LABELS } from "@/modules/staff-agent/types";

import { setStaffWage, staffWagesQueryKey, useStaffWages } from "./api";
import type { StaffWageSetting } from "./types";
import {
  HOURLY_PREVIEW_EXAMPLE_MINUTES,
  formatWageMoney,
  hourlyPreviewText,
  wageUnitLabel,
} from "./wageLogic";

/** 待辦標籤文字(金額 0)。 */
export const WAGE_NOT_SET_TODO = "尚未設定金額";

export function WageStaffSection({ merchantId }: { merchantId: string }) {
  const { data: rows, isLoading, isError, refetch } = useStaffWages(merchantId);

  // 讀取中、或沒有任何日薪／時薪人員 ⇒ 整個區塊不顯示(沒用到這個功能的店畫面跟改版前一樣)。
  if (isLoading) return null;
  if (isError) {
    return (
      <ErrorState
        title="讀不到日薪／時薪設定"
        reason="可能是網路斷了，或你沒有「抽成與薪資設定」的權限"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!rows || rows.length === 0) return null;

  return (
    <Card data-testid="wage-staff-section">
      <CardHeader>
        <CardTitle>日薪／時薪制服務人員</CardTitle>
        <CardDescription>
          上工時間照行事曆的可預約時段加上時段外被排的訂單自動計算，請假那天不算。金額改完立刻生效，過去已結算的日子不會改變。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <WageStaffRow key={`wage-${row.staff_id}`} merchantId={merchantId} row={row} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WageStaffRow({ merchantId, row }: { merchantId: string; row: StaffWageSetting }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(String(Number(row.wage_amount)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = `staff-wage-${row.staff_id}`;
  const amount = Number(row.wage_amount);
  const missing = amount === 0;

  // 重抓之後(別處改了)同步顯示值。
  useEffect(() => {
    setDraft(String(Number(row.wage_amount)));
  }, [row.wage_amount]);

  async function save() {
    const parsed = parseAmountInput(draft, { max: 1000000 });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.value === amount) return;
    setSaving(true);
    try {
      await setStaffWage(row.staff_id, parsed.value);
      toast.success(
        `已更新「${row.name}」的${STAFF_COMPENSATION_TYPE_LABELS[row.compensation_type]}金額`,
      );
      await queryClient.invalidateQueries({ queryKey: staffWagesQueryKey(merchantId) });
    } catch (err) {
      toast.error("更新金額失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <li>
      <ListCard
        title={row.name}
        state={missing ? "attention" : "default"}
        tags={
          <>
            <AttributeTag>{STAFF_COMPENSATION_TYPE_LABELS[row.compensation_type]}</AttributeTag>
            {missing ? <TodoTag>{WAGE_NOT_SET_TODO}</TodoTag> : null}
          </>
        }
        meta={
          row.compensation_type === "hourly_wage" && amount > 0
            ? `例：${hourlyPreviewText(amount, HOURLY_PREVIEW_EXAMPLE_MINUTES)}`
            : row.compensation_type === "daily_wage" && amount > 0
              ? `有上工的日子每天 ${formatWageMoney(amount)} 元`
              : null
        }
      >
        <FormField
          label={`金額（${wageUnitLabel(row.compensation_type)}）`}
          htmlFor={inputId}
          error={error ?? undefined}
          className="mt-3 sm:max-w-xs"
        >
          <FieldAmountInput
            id={inputId}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
          />
        </FormField>
      </ListCard>
    </li>
  );
}
