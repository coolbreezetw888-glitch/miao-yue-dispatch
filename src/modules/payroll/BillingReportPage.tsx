// 對應模組 8(薪資與帳務)規格書 §4.3:店家端帳務報表頁(新路由 /app/billing-report)。
// 年月選擇器(預設當月)+ 頂部摘要卡片 + 服務人員明細表格 + CSV 匯出按鈕(判斷 10,前端直接把
// 畫面上已經抓到的資料轉成 CSV,不呼叫額外的匯出 API)。

import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useCurrentMerchant } from "@/modules/merchant/context";

import { useMerchantBillingSummary } from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { RequireBillingAccess } from "./RequireBillingAccess";
import { YearMonthPicker, useYearMonthState } from "./YearMonthPicker";

function BillingReportPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { year, month, setYear, setMonth } = useYearMonthState();

  const { data: summary, isLoading, error } = useMerchantBillingSummary(merchantId, year, month);

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["姓名", "計酬類型", "本月訂單筆數", "抽成金額", "月薪淨額"];
    const rows = summary.per_staff_breakdown.map((row) => [
      row.staff_name,
      row.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬",
      row.order_count,
      row.commission_amount ?? "",
      row.net_pay ?? "",
    ]);
    downloadCsv(`帳務報表_${year}-${String(month).padStart(2, "0")}.csv`, buildCsvContent(headers, rows));
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">店家帳務報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的月度營收與成本彙整</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <YearMonthPicker year={year} month={month} onYearChange={setYear} onMonthChange={setMonth} />
        <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={!summary}>
          匯出這份報表為 CSV
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : error ? (
        <p className="text-sm text-destructive">載入失敗,請確認你有查看帳務報表的權限。</p>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <SummaryCard label="總營收(未稅)" value={summary.total_revenue_excl_tax} />
            <SummaryCard label="稅金小計" value={summary.total_tax_amount} />
            <SummaryCard label="總料錢成本" value={summary.total_material_cost} />
            <SummaryCard label="總抽成支出" value={summary.total_commission_payout} />
            <SummaryCard label="月薪基本額合計" value={summary.total_monthly_salary_base} />
            <SummaryCard label="月薪扣款合計" value={summary.total_monthly_salary_deduction} />
            <SummaryCard
              label="月薪實發合計"
              value={summary.total_monthly_salary_base - summary.total_monthly_salary_deduction}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>商家總淨利</CardTitle>
              <CardDescription>
                總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)。只是
                概估,不含房租/水電等其他營運成本,不是完整的財務損益表。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold text-foreground">
                {summary.estimated_net_margin.toLocaleString()} 元
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>服務人員明細</CardTitle>
              <CardDescription>目前在職(active)的服務人員,依姓名排序</CardDescription>
            </CardHeader>
            <CardContent>
              {summary.per_staff_breakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground">目前沒有在職的服務人員。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>姓名</TableHead>
                      <TableHead>計酬類型</TableHead>
                      <TableHead className="text-right">本月訂單筆數</TableHead>
                      <TableHead className="text-right">抽成金額 / 月薪淨額</TableHead>
                      <TableHead className="text-right">明細</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.per_staff_breakdown.map((row) => (
                      <TableRow key={row.staff_id}>
                        <TableCell>{row.staff_name}</TableCell>
                        <TableCell>
                          {row.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬"}
                        </TableCell>
                        <TableCell className="text-right">{row.order_count}</TableCell>
                        <TableCell className="text-right">
                          {row.compensation_type === "monthly_salary"
                            ? `${row.net_pay ?? 0} 元(淨額)`
                            : `${row.commission_amount ?? 0} 元(抽成)`}
                        </TableCell>
                        <TableCell className="text-right">
                          {/* SPECS-INDEX 編號 567(規格書「商家端三項調整.md」§三 3.3 折衷方案):
                              兩個報表維持分開頁面,但這裡加一個捷徑連結,點下去直接帶著這位服務
                              人員 + 目前這個年月導到「師傅報表」頁面,不用使用者自己再選一次。 */}
                          <Link
                            to={`/app/staff-report?staffId=${encodeURIComponent(row.staff_id)}&year=${year}&month=${month}`}
                            className="text-sm text-primary hover:underline"
                          >
                            查看明細 →
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-lg font-semibold text-foreground">{value.toLocaleString()} 元</p>
      </CardContent>
    </Card>
  );
}

export default function BillingReportPage() {
  return (
    <RequireBillingAccess>
      <BillingReportPageInner />
    </RequireBillingAccess>
  );
}
