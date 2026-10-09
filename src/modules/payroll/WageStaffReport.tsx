// #1035 彈性計薪 B 批 PB-B02:日薪／時薪服務人員的報表(商家「服務人員報表」與服務人員端「薪資報表」共用)。
// 三張卡「上工天數」「上工時數」「工資合計」+ 每天明細(日期、時段、時段外訂單、請假、金額、狀態屬性標籤)。
// 數字全部來自 get_staff_wage_by_range(只算到今天,未來不算);這裡只負責排版。

import {
  AlertNote,
  AttributeTag,
  DetailRow,
  DetailSection,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useStaffWageByRange } from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { validateDateRange } from "./dateRangeUtils";
import {
  WAGE_DAY_STATE_LABELS,
  formatWageDayLabel,
  formatWageMoney,
  formatWorkedMinutes,
  wageDayDetailText,
  wageRateSummaryText,
} from "./wageLogic";

const COMPENSATION_LABEL = { daily_wage: "日薪制", hourly_wage: "時薪制" } as const;

/** 商家視角的單一年月 → 那個月的 1 號到月底(YYYY-MM-DD)。 */
function monthRange(
  year: number | undefined,
  month: number | undefined,
): { startDate: string; endDate: string } | null {
  if (!year || !month) return null;
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${year}-${mm}-01`,
    endDate: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

function WageStatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

export function WageStaffReport({
  staffId,
  staffName,
  year,
  month,
  dateRange,
  showCsvExport = true,
}: {
  staffId: string;
  staffName: string;
  year?: number;
  month?: number;
  dateRange?: { startDate: string; endDate: string };
  showCsvExport?: boolean;
}) {
  const range = dateRange ?? monthRange(year, month);
  const {
    data: wage,
    isLoading,
    error,
    refetch,
  } = useStaffWageByRange(staffId, range ? range.startDate : null, range ? range.endDate : null);

  function handleExportCsv() {
    if (!wage || !range) return;
    const headers = [
      "日期",
      "計酬方式",
      "金額設定",
      "時段",
      "時段外訂單",
      "上工合計",
      "請假",
      "工資",
      "狀態",
    ];
    const rows = wage.days.map((d) => [
      d.date,
      COMPENSATION_LABEL[d.compensation_type],
      Number(d.wage_amount),
      formatWorkedMinutes(d.shift_minutes),
      formatWorkedMinutes(d.extra_booking_minutes),
      formatWorkedMinutes(d.worked_minutes),
      d.is_leave ? (d.leave_type_name ?? "是") : "",
      Number(d.pay_amount),
      WAGE_DAY_STATE_LABELS[d.state],
    ]);
    downloadCsv(
      `服務人員報表_${staffName}_${range.startDate}_${range.endDate}.csv`,
      buildCsvContent(headers, rows),
    );
  }

  // 日期填反時欄位底下已經有錯誤訊息,這裡整塊不渲染(同 MonthlySalaryStaffReport,#861)。
  if (dateRange && validateDateRange(dateRange.startDate, dateRange.endDate)) return null;
  if (isLoading) return <LoadingSkeleton variant="cards" rows={3} />;
  if (error || !wage)
    return (
      <ErrorState
        title="讀不到這份報表"
        reason="可能是網路斷了，或你沒有查看這位服務人員報表的權限"
        onRetry={() => void refetch()}
      />
    );

  const rateText = wageRateSummaryText(wage);
  const hasUnsettled = wage.days.some((d) => d.state === "unsettled");

  return (
    <div className="flex flex-col gap-4" data-testid="wage-staff-report">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm tabular-nums text-muted-foreground" data-testid="wage-rate-summary">
          {rateText ?? "這段期間沒有日薪／時薪的上工紀錄。"}
        </p>
        {showCsvExport ? (
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="shrink-0"
            onClick={handleExportCsv}
          >
            匯出這份報表為 CSV
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <WageStatCard label="上工天數" value={`${wage.work_days} 天`} />
        <WageStatCard label="上工時數" value={formatWorkedMinutes(wage.total_worked_minutes)} />
        <WageStatCard label="工資合計" value={`${formatWageMoney(wage.total_pay)} 元`} />
      </div>

      {wage.wage_missing ? (
        <AlertNote>
          還沒設定日薪／時薪金額（或金額是 0），那幾天以 0 元計算。金額請到「抽成與薪資設定」設定。
        </AlertNote>
      ) : null}
      {wage.includes_estimate ? (
        <AlertNote>今天的金額是預估，隔天凌晨結算後才會固定。未來的日子不計算。</AlertNote>
      ) : null}
      {hasUnsettled ? (
        <AlertNote>標示「尚未結算」的日子是用目前的行事曆即時算出來的，結算後才會固定。</AlertNote>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>每天明細</CardTitle>
          <CardDescription>
            上工時間照行事曆的可預約時段加上時段外被排的訂單計算，重疊的部分只算一次；請假那天不計薪。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {wage.days.length === 0 ? (
            <EmptyState
              title="這段期間沒有上工紀錄"
              description="日薪／時薪的上工時間照行事曆自動計算，換一個查詢期間看看。"
            />
          ) : (
            <DetailSection tone="amount">
              {wage.days.map((d) => (
                <DetailRow
                  key={`wage-day-${d.date}`}
                  size="sm"
                  label={
                    <>
                      <span className="flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
                        {formatWageDayLabel(d.date)}
                        <AttributeTag>{WAGE_DAY_STATE_LABELS[d.state]}</AttributeTag>
                      </span>
                      <span className="block">{wageDayDetailText(d)}</span>
                    </>
                  }
                >
                  {`${formatWageMoney(d.pay_amount)} 元`}
                </DetailRow>
              ))}
            </DetailSection>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
