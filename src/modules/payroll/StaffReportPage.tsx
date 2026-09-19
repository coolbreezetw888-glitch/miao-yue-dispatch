// 對應模組 8(薪資與帳務)規格書 §4.4:師傅報表頁(新路由 /app/staff-report)。服務人員選擇 +
// 年月選擇器,依選中服務人員的計酬類型顯示不同版面(按件計酬:訂單明細+總計;月薪制:扣款明細+
// 淨額)+ CSV 匯出按鈕。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { useStaffCommissionSummary, useStaffMonthlyPayrollSummary } from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { RequireStaffReportAccess } from "./RequireStaffReportAccess";
import { YearMonthPicker, useYearMonthState } from "./YearMonthPicker";

function PieceRateStaffReport({
  staffId,
  staffName,
  year,
  month,
}: {
  staffId: string;
  staffName: string;
  year: number;
  month: number;
}) {
  const { data: summary, isLoading, error } = useStaffCommissionSummary(staffId, year, month);

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["日期", "客戶", "抽成基準", "比例(%)", "抽成金額", "已被人工重算"];
    const rows = summary.details.map((d) => [
      d.order_date,
      d.customer_name,
      d.commission_base_amount,
      d.commission_rate_percentage,
      d.commission_amount,
      d.recalculated ? "是" : "否",
    ]);
    downloadCsv(
      `師傅報表_${staffName}_${year}-${String(month).padStart(2, "0")}.csv`,
      buildCsvContent(headers, rows),
    );
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  if (error || !summary) return <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          以助手身份參與 {summary.assistant_booking_count} 筆訂單(不列入抽成計算,只是參考資訊)
        </p>
        <Button variant="outline" size="sm" onClick={handleExportCsv}>
          匯出這份報表為 CSV
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>訂單明細</CardTitle>
          <CardDescription>總計 {summary.total_orders} 筆訂單,抽成合計 {summary.total_commission_amount} 元</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.details.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個月沒有已完成的訂單。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>客戶</TableHead>
                  <TableHead className="text-right">抽成基準</TableHead>
                  <TableHead className="text-right">比例</TableHead>
                  <TableHead className="text-right">抽成金額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.details.map((d) => (
                  <TableRow key={d.booking_id}>
                    <TableCell>{new Date(d.order_date).toLocaleDateString("zh-TW")}</TableCell>
                    <TableCell>{d.customer_name}</TableCell>
                    <TableCell className="text-right">{d.commission_base_amount}</TableCell>
                    <TableCell className="text-right">{d.commission_rate_percentage}%</TableCell>
                    <TableCell className="text-right">
                      {d.commission_amount}
                      {d.recalculated ? <span className="ml-1 text-xs text-warn">(已重算)</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MonthlySalaryStaffReport({
  staffId,
  staffName,
  year,
  month,
}: {
  staffId: string;
  staffName: string;
  year: number;
  month: number;
}) {
  const { data: summary, isLoading, error } = useStaffMonthlyPayrollSummary(staffId, year, month);

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["假別", "天數", "扣款模式", "扣款金額"];
    const rows = summary.details.map((d) => [d.leave_type_name, d.days, d.deduction_mode, d.deduction_amount]);
    downloadCsv(
      `師傅報表_${staffName}_${year}-${String(month).padStart(2, "0")}.csv`,
      buildCsvContent(headers, rows),
    );
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  if (error || !summary) return <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          本月休假額度 {summary.monthly_leave_quota_days ?? "未設定"} 天(僅供參考,不影響薪資計算)
          ,實際請假 {summary.total_leave_days} 天
        </p>
        <Button variant="outline" size="sm" onClick={handleExportCsv}>
          匯出這份報表為 CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>月薪基本額</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold text-foreground">{summary.monthly_base_salary} 元</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>總扣款</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold text-foreground">{summary.total_deduction_amount} 元</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>實發淨額</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold text-foreground">{summary.net_pay} 元</p>
          </CardContent>
        </Card>
      </div>

      {summary.over_deduction_warning ? (
        <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
          扣款金額已超過月薪基本額,請留意這個月的請假紀錄或薪資設定是否正確。
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>假別扣款明細</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.details.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個月沒有需要扣款的請假紀錄。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>假別</TableHead>
                  <TableHead className="text-right">天數</TableHead>
                  <TableHead className="text-right">扣款金額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.details.map((d) => (
                  <TableRow key={d.leave_type_id}>
                    <TableCell>{d.leave_type_name}</TableCell>
                    <TableCell className="text-right">{d.days}</TableCell>
                    <TableCell className="text-right">{d.deduction_amount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StaffReportPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffList } = useMerchantStaffList(merchantId);
  const { year, month, setYear, setMonth } = useYearMonthState();
  const [selectedStaffId, setSelectedStaffId] = useState("");

  useEffect(() => {
    const firstStaff = staffList?.[0];
    if (!selectedStaffId && firstStaff) {
      setSelectedStaffId(firstStaff.id);
    }
  }, [staffList, selectedStaffId]);

  const selectedStaff = (staffList ?? []).find((s) => s.id === selectedStaffId) ?? null;

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">師傅報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」個別服務人員的抽成/薪資報表
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="staff-select">
            服務人員
          </label>
          <Select value={selectedStaffId} onValueChange={setSelectedStaffId}>
            <SelectTrigger id="staff-select" className="mt-1 w-56">
              <SelectValue placeholder="選擇服務人員" />
            </SelectTrigger>
            <SelectContent>
              {(staffList ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <YearMonthPicker year={year} month={month} onYearChange={setYear} onMonthChange={setMonth} />
      </div>

      {!staffList || staffList.length === 0 ? (
        <p className="text-sm text-muted-foreground">目前沒有在職的服務人員。</p>
      ) : !selectedStaff ? (
        <p className="text-sm text-muted-foreground">請選擇服務人員。</p>
      ) : selectedStaff.compensation_type === "monthly_salary" ? (
        <MonthlySalaryStaffReport
          staffId={selectedStaff.id}
          staffName={selectedStaff.name}
          year={year}
          month={month}
        />
      ) : (
        <PieceRateStaffReport
          staffId={selectedStaff.id}
          staffName={selectedStaff.name}
          year={year}
          month={month}
        />
      )}
    </main>
  );
}

export default function StaffReportPage() {
  return (
    <RequireStaffReportAccess>
      <StaffReportPageInner />
    </RequireStaffReportAccess>
  );
}
