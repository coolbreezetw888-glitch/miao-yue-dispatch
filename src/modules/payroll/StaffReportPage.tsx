// 對應模組 8(薪資與帳務)規格書 §4.4:師傅報表頁(新路由 /app/staff-report)。服務人員選擇 +
// 年月選擇器,依選中服務人員的計酬類型顯示不同版面(按件計酬:訂單明細+總計;月薪制:扣款明細+
// 淨額)+ CSV 匯出按鈕。

import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

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
// 模組 14(服務人員端)v2 §10.4.4:摘要卡片的金額顯示格式,沿用既有的跨模組共用格式化函式
// (staff-portal 模組已經有 import booking/dateUtils 的既有先例,這裡是同樣的模式)。
import { formatAmount } from "@/modules/booking/orderAmount";

import { useStaffCommissionSummary, useStaffMonthlyPayrollSummary } from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { formatStaffCommissionItemBreakdown } from "./types";
import { RequireStaffReportAccess } from "./RequireStaffReportAccess";
import { YearMonthPicker, useYearMonthState } from "./YearMonthPicker";

// 模組 14(服務人員端)規格書 4.5:這兩個版面元件直接被 MyPayrollPage.tsx 複用(export 出去),
// 介面設計上 staffId 本來就是外部傳入的 prop,不耦合「怎麼決定 staffId」這件事本身——管理員版本
// (下面 StaffReportPage)呼叫時自己選 staffId,自助版本呼叫時鎖定自己的 staffId,兩者共用同一套
// 渲染邏輯與計算結果,不會日後各自修改產生數字不一致的風險。
export function PieceRateStaffReport({
  staffId,
  staffName,
  year,
  month,
  showCsvExport = true,
  showSummaryCards = false,
}: {
  staffId: string;
  staffName: string;
  year: number;
  month: number;
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面(MyPayrollPage.tsx)傳 false 拿掉 CSV
   * 匯出按鈕;商家管理員視角(StaffReportPage.tsx)不傳,吃預設值 true,維持既有行為不變。 */
  showCsvExport?: boolean;
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面傳 true 顯示三張摘要卡片(完成訂單/
   * 我的抽成/訂單總額);商家管理員視角不傳,吃預設值 false,維持既有版面不變。 */
  showSummaryCards?: boolean;
}) {
  const { data: summary, isLoading, error } = useStaffCommissionSummary(staffId, year, month);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(bookingId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookingId)) {
        next.delete(bookingId);
      } else {
        next.add(bookingId);
      }
      return next;
    });
  }

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["日期", "客戶", "抽成基準", "服務項目明細", "抽成金額", "已被人工重算"];
    const rows = summary.details.map((d) => [
      d.order_date,
      d.customer_name,
      d.commission_base_amount,
      formatStaffCommissionItemBreakdown(d),
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
      {!showSummaryCards ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            以助手身份參與 {summary.assistant_booking_count} 筆訂單(不列入抽成計算,只是參考資訊)
          </p>
          {showCsvExport ? (
            <Button variant="outline" size="sm" onClick={handleExportCsv}>
              匯出這份報表為 CSV
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面新增三張摘要卡片(完成訂單/我的抽成/
          訂單總額),取代下面 Card 標題底下原本的 CardDescription 文字(避免同一個數字在畫面上
          出現兩次)。「以助手身份參與...」這行參考文字保留,移到摘要卡片下方,不刪除。 */}
      {showSummaryCards ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>完成訂單</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-foreground">{summary.total_orders} 筆</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>我的抽成</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-foreground">
                  {formatAmount(summary.total_commission_amount)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>訂單總額</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-foreground">{formatAmount(summary.total_amount)}</p>
              </CardContent>
            </Card>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              以助手身份參與 {summary.assistant_booking_count} 筆訂單(不列入抽成計算,只是參考資訊)
            </p>
            {showCsvExport ? (
              <Button variant="outline" size="sm" onClick={handleExportCsv}>
                匯出這份報表為 CSV
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>訂單明細</CardTitle>
          {!showSummaryCards ? (
            <CardDescription>
              總計 {summary.total_orders} 筆訂單,抽成合計 {summary.total_commission_amount} 元
            </CardDescription>
          ) : null}
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
                  <TableHead className="text-right">抽成金額</TableHead>
                  <TableHead className="text-right">明細</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.details.map((d) => {
                  const expanded = expandedIds.has(d.booking_id);
                  return (
                    <Fragment key={d.booking_id}>
                      <TableRow>
                        <TableCell>{new Date(d.order_date).toLocaleDateString("zh-TW")}</TableCell>
                        <TableCell>{d.customer_name}</TableCell>
                        <TableCell className="text-right">{d.commission_base_amount}</TableCell>
                        <TableCell className="text-right">
                          {d.commission_amount}
                          {d.recalculated ? <span className="ml-1 text-xs text-warn">(已重算)</span> : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => toggleExpanded(d.booking_id)}>
                            {expanded ? "收合" : "展開"}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/30">
                            {d.item_breakdown.length === 0 && d.legacy_rate_percentage !== null ? (
                              <p className="text-sm text-muted-foreground">
                                這筆是改版前的舊制紀錄,抽成比例 {d.legacy_rate_percentage}%
                              </p>
                            ) : d.item_breakdown.length === 0 ? (
                              <p className="text-sm text-muted-foreground">沒有抽成明細</p>
                            ) : (
                              <ul className="space-y-1 text-sm text-foreground">
                                {d.item_breakdown.map((item, idx) => (
                                  <li key={idx} className="flex flex-wrap items-center justify-between gap-2">
                                    <span>
                                      {item.service_item_name} × {item.quantity}(
                                      {item.commission_mode === "percentage"
                                        ? `${item.commission_value}%`
                                        : `${item.commission_value} 元/件`}
                                      )
                                    </span>
                                    <span className="font-medium">{item.commission_amount} 元</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function MonthlySalaryStaffReport({
  staffId,
  staffName,
  year,
  month,
  showCsvExport = true,
}: {
  staffId: string;
  staffName: string;
  year: number;
  month: number;
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面傳 false 拿掉 CSV 匯出按鈕;商家管理員
   * 視角不傳,吃預設值 true,維持既有行為不變。這次需求 4 沒有提到要調整月薪制服務人員報表
   * 的摘要卡片(本來就已經有三張卡片),不新增 showSummaryCards 這個 prop。 */
  showCsvExport?: boolean;
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
        {showCsvExport ? (
          <Button variant="outline" size="sm" onClick={handleExportCsv}>
            匯出這份報表為 CSV
          </Button>
        ) : null}
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

  // SPECS-INDEX 編號 567(規格書「商家端三項調整.md」§三 3.3 折衷方案):從「服務人員明細」
  // 表格點「查看明細」連結過來時,網址帶 ?staffId=...&year=...&month=...,這裡讀出來當作
  // 初始選取值,讓使用者不用再手動選一次服務人員跟年月。直接手動進這個頁面(沒帶參數)時,
  // 這幾個值都是 null,行為跟改版前完全一樣。
  const [searchParams] = useSearchParams();
  const initialStaffId = searchParams.get("staffId") ?? "";
  const initialYearParam = Number(searchParams.get("year"));
  const initialMonthParam = Number(searchParams.get("month"));

  const { year, month, setYear, setMonth } = useYearMonthState({
    year: Number.isInteger(initialYearParam) && initialYearParam > 0 ? initialYearParam : undefined,
    month:
      Number.isInteger(initialMonthParam) && initialMonthParam >= 1 && initialMonthParam <= 12
        ? initialMonthParam
        : undefined,
  });
  const [selectedStaffId, setSelectedStaffId] = useState(initialStaffId);

  useEffect(() => {
    // 如果目前選取的服務人員 id 是空的,或(從網址帶來的)id 根本不在名單裡(例如該服務人員
    // 後來被停用),就退回選名單第一位,避免畫面卡在「請選擇服務人員」的空狀態。
    if (selectedStaffId && (staffList ?? []).some((s) => s.id === selectedStaffId)) return;
    const firstStaff = staffList?.[0];
    if (firstStaff) {
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
