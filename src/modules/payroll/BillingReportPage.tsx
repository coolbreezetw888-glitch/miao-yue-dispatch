// 對應模組 8(薪資與帳務)規格書 §4.3:店家端帳務報表頁(新路由 /app/billing-report)。
// 頂部摘要卡片 + 服務人員明細表格 + CSV 匯出按鈕(判斷 10,前端直接把畫面上已經抓到的資料轉成
// CSV,不呼叫額外的匯出 API)。
//
// 商家端三項調整規格書 §3.6:時間篩選這次從單一年/月改成可選區間(起訖日期或起訖月份,最長一年),
// 取代原本的 YearMonthPicker,改用 DateRangePicker + get_merchant_billing_summary_by_range。

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

import { useMerchantBillingSummaryByRange } from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { DateRangePicker, useDateRangeState } from "./DateRangePicker";
import { RequireBillingAccess } from "./RequireBillingAccess";

function BillingReportPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { startDate, endDate, setStartDate, setEndDate } = useDateRangeState();

  const {
    data: summary,
    isLoading,
    error,
  } = useMerchantBillingSummaryByRange(merchantId, startDate, endDate);

  // §一 §3.3 折衷方案的「查看明細 →」連結需要帶一個具體的年/月給師傅報表頁(那個頁面這次不在
  // §3.6 範圍內,繼續用單一年月),這裡用區間結束日期所在的年月當作連結目標,是最貼近「使用者
  // 目前在看哪一段期間」的合理落點。
  const linkYear = Number(endDate.slice(0, 4));
  const linkMonth = Number(endDate.slice(5, 7));

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["姓名", "計酬類型", "訂單筆數", "抽成金額", "月薪淨額"];
    const rows = summary.per_staff_breakdown.map((row) => [
      row.staff_name,
      row.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬",
      row.order_count,
      row.commission_amount ?? "",
      row.net_pay ?? "",
    ]);
    downloadCsv(`帳務報表_${startDate}_${endDate}.csv`, buildCsvContent(headers, rows));
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
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的營收與成本彙整,可選起訖日期或起訖月份,最長查詢一年範圍
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
        />
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
            <SummaryCard label="總料錢成本" value={summary.total_material_cost} />
            <SummaryCard label="總抽成支出" value={summary.total_commission_payout} />
            <SummaryCard label="月薪基本額合計" value={summary.total_monthly_salary_base} />
            <SummaryCard label="月薪扣款合計" value={summary.total_monthly_salary_deduction} />
            <SummaryCard
              label="月薪實發合計"
              value={summary.total_monthly_salary_base - summary.total_monthly_salary_deduction}
            />
          </div>

          {/* 模組 8 §11.10:查詢區間涵蓋機制上線前的月份時,「月薪基本額合計」是用最早的已知薪資
              回推估算,提醒使用者僅供參考。只在 salary_estimation_applied=true 時顯示,不是每次
              查詢都出現(避免嚇到使用者)。樣式比照既有 over_deduction_warning 警示區塊的既有寫法。 */}
          {summary.salary_estimation_applied ? (
            <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
              ⚠️ 查詢區間內有部分月份早於系統開始記錄薪資歷史的時間,這些月份的金額是用最早的已知薪資回推估算,僅供參考。
            </p>
          ) : null}

          {/* 商家端調整批次(2026-09-22)§3.5:「稅金小計」搬到「商家總淨利」正上方,尺寸比照
              「商家總淨利」卡片(兩者這次形成視覺上的一組,方便使用者把「稅金是從含稅營收裡先拆
              出來、不計入淨利」這個關係連在一起看),其餘統計卡維持原本的 grid 排列不變。 */}
          <Card>
            <CardHeader>
              <CardTitle>稅金小計</CardTitle>
              <CardDescription>這段期間完成訂單的稅金加總,已經從「商家總淨利」的計算中排除。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold text-foreground">
                {summary.total_tax_amount.toLocaleString()} 元
              </p>
            </CardContent>
          </Card>

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
                      <TableHead className="text-right">訂單筆數</TableHead>
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
                              人員導到「師傅報表」頁面(該頁面 §3.6 不在區間篩選範圍內,繼續用
                              單一年月,這裡用區間結束日期所在的年月當作連結目標)。 */}
                          <Link
                            to={`/app/staff-report?staffId=${encodeURIComponent(row.staff_id)}&year=${linkYear}&month=${linkMonth}`}
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
