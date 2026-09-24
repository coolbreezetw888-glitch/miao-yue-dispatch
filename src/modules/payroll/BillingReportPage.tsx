// 對應模組 8(薪資與帳務)規格書 §4.3:店家端帳務報表頁(新路由 /app/billing-report)。
// 頂部摘要卡片 + 服務人員明細表格 + CSV 匯出按鈕(判斷 10,前端直接把畫面上已經抓到的資料轉成
// CSV,不呼叫額外的匯出 API)。
//
// 商家端三項調整規格書 §3.6:時間篩選這次從單一年/月改成可選區間(起訖日期或起訖月份,最長一年),
// 取代原本的 YearMonthPicker,改用 DateRangePicker + get_merchant_billing_summary_by_range。
//
// 2026-09-24 使用者裁決(月薪只在「選了完整月份」時才計算):
//   1. 期間選擇器預設改成「月份」顆粒度(本月 / 上個月 / 指定月份),切到「自訂區間」才出現原本的
//      起訖日期選擇器 —— 見 ReportPeriodPicker.tsx。
//   2. 資料庫端新增 salary_applicable:區間不是完整月份時,月薪基本額/月薪扣款/月薪實發/
//      商家總淨利一律回傳 null,這裡改顯示「需選擇完整月份才能計算」。
//      **刻意不顯示 0**——顯示 0 會讓商家誤以為這段期間真的沒有月薪成本,把淨利看得比實際高。
//      營收/稅金/料錢/抽成/訂單數不受影響,照常顯示。
//      順帶修掉一個真 bug:查 2/15~3/15(29 天)原本會收到**兩個月的整月月薪**,而扣款那一邊卻
//      有按區間裁切,兩邊算法不一致;現在這種區間直接不給月薪數字,不再編一個算不準的數字出來。

import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
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
// 2026-09-24:「該顯示數字還是該顯示說明文字」的判斷全部抽到 billingReportDisplay.ts 並加上單元
// 測試。抽出來的理由寫在那支檔案的檔頭:這一頁的失敗模式是「畫面完全正常、數字是假的」,靠人工
// 點畫面幾乎不可能發現,必須有測試釘住。
import {
  RESIGNED_LABEL,
  SALARY_UNAVAILABLE_TEXT,
  commissionCellText,
  commissionCsvValue,
  employmentStatusCsvText,
  monthlySalaryCellText,
  monthlySalaryCsvCell,
  resolveNetMonthlySalary,
  resolveSalaryDisplay,
  salaryCardValue,
  salaryDisplayValue,
  shouldShowResignedBadge,
  shouldShowSalaryUnavailableNotice,
} from "./billingReportDisplay";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { RequireBillingAccess } from "./RequireBillingAccess";
import { ReportPeriodPicker, useReportPeriodState } from "./ReportPeriodPicker";

function BillingReportPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { mode, setMode, month, setMonth, startDate, endDate, setStartDate, setEndDate } =
    useReportPeriodState();

  const {
    data: summary,
    isLoading,
    error,
  } = useMerchantBillingSummaryByRange(merchantId, startDate, endDate);

  // ✅ 2026-09-24:資料庫端的 salary_applicable 已經上線,summary 一旦拿到就一定有這個欄位,
  // 所以這裡直接讀欄位值(開發期間曾寫成 `?? true` 當過渡防禦,已收掉)。
  // ⚠️ `summary?.` 這個 optional chaining 要留著,而且是真的需要:summary 在載入中/載入失敗時
  // 就是 undefined。此時 salaryApplicable 也是 undefined,但下面每一個會真的渲染出來的地方都在
  // 「summary 已經存在」的分支裡(JSX 的 `: summary ? (…)`、handleExportCsv 的 `if (!summary) return`),
  // 所以載入中的畫面完全不受影響。billingReportDisplay.ts 的純函式也把 `boolean | undefined`
  // 如實寫進型別、並把 undefined 當成「不能算」(fail-closed),不假裝 summary 一定存在。
  const salaryApplicable = summary?.salary_applicable;

  // 月薪實發 = 月薪基本額 − 月薪扣款。任一邊算不出來(null)整個就算不出來——刻意不用 `?? 0`
  // 補其中一邊,那會算出一個看起來合理、實際上錯的數字(例如基本額 null 當 0、扣款有值,
  // 實發就變成負數)。判斷本體在 billingReportDisplay.ts(有單元測試)。
  const netMonthlySalary = salaryDisplayValue(resolveNetMonthlySalary(summary));

  // 商家總淨利那張卡:先在這裡算好顯示結果(summary 可能是 undefined,純函式會如實處理),
  // 下面的 JSX 只負責挑要印哪一個 <p>。
  const netMarginDisplay = resolveSalaryDisplay(salaryApplicable, summary?.estimated_net_margin);

  // §一 §3.3 折衷方案的「查看明細 →」連結需要帶一個具體的年/月給師傅報表頁(那個頁面這次不在
  // §3.6 範圍內,繼續用單一年月),這裡用區間結束日期所在的年月當作連結目標,是最貼近「使用者
  // 目前在看哪一段期間」的合理落點。
  const linkYear = Number(endDate.slice(0, 4));
  const linkMonth = Number(endDate.slice(5, 7));

  function handleExportCsv() {
    if (!summary) return;
    // 「在職狀態」欄:CSV 一樣要帶這個資訊。理由——匯出的用途正是「把報表帶離系統」(丟給會計、
    // 自己在 Excel 對帳),那個情境下使用者看不到畫面上的「已離職」標籤,離職人員的數字就跟現職
    // 人員混在一起,完全無法分辨,等於把「以為系統出錯」這個困惑原封不動搬到一個更難查證的地方
    // (在 Excel 裡沒辦法點回來看)。而且 CSV 沒有版面寬度的限制,多一欄的成本是 0。
    const headers = ["姓名", "計酬類型", "在職狀態", "訂單筆數", "抽成金額", "月薪淨額"];
    const rows = summary.per_staff_breakdown.map((row) => [
      row.staff_name,
      row.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬",
      employmentStatusCsvText(row),
      row.order_count,
      // 2026-09-24 使用者裁決(選項 A):抽成是 null 時這裡原本寫 `?? ""`(空白格),而畫面明細表
      // 那一格寫 `?? 0`(顯示「0 元(抽成)」)——同一個欄位、同一位服務人員,畫面跟匯出檔說法不一樣。
      // 裁決是兩邊統一成 0(沒接單的抽成確實就是 0,是真實數字)。現在 fallback 只存在
      // billingReportDisplay.ts 的 COMMISSION_FALLBACK 一處,畫面那支函式也是呼叫這支拿數字的,
      // 結構上不可能只改一邊。
      commissionCsvValue(row),
      // 月薪算不出來時寫進說明文字,不留空白格——CSV 的空白格在 Excel 裡看起來跟 0 很像,
      // 會重演「商家以為這段期間沒有月薪成本」這個誤會。判斷條件跟下面表格那一欄走同一支純函式,
      // 讓畫面跟匯出檔永遠一致。
      monthlySalaryCsvCell(salaryApplicable, row),
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">店家報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的營收與成本彙整。預設依月份查詢(月薪要有完整月份才算得出來),
          需要任意天數的區間時可切到「自訂區間」,最長查詢一年範圍。
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <ReportPeriodPicker
          mode={mode}
          onModeChange={setMode}
          month={month}
          onMonthChange={setMonth}
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
            {/* 2026-09-24 使用者裁決:月薪這三張卡在「區間不是完整月份」時顯示說明文字,不顯示
                0(顯示 0 會讓商家以為真的沒有月薪成本)。判斷一律以 salaryApplicable 為準,
                同時把值本身當成 null 傳下去,避免「旗標說不能算、卡片卻還印著一個數字」的不一致。 */}
            <SummaryCard
              label="月薪基本額合計"
              value={salaryCardValue(salaryApplicable, summary.total_monthly_salary_base)}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
            <SummaryCard
              label="月薪扣款合計"
              value={salaryCardValue(salaryApplicable, summary.total_monthly_salary_deduction)}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
            <SummaryCard
              label="月薪實發合計"
              value={netMonthlySalary}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
          </div>

          {/* 月薪算不出來時,額外解釋「為什麼」跟「怎麼做才看得到」——只顯示「需選擇完整月份才能
              計算」這幾個字,使用者不一定知道要去點哪裡才算完整月份。 */}
          {shouldShowSalaryUnavailableNotice(salaryApplicable) ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              月薪是以「一整個月」為單位計算的,目前選的期間不是完整的月份(月初到月底),所以月薪
              基本額、月薪扣款、月薪實發與商家總淨利這幾個數字沒辦法算。營收、料錢、抽成、訂單筆數
              不受影響,照常顯示。想看月薪與商家總淨利,請改點上面的「本月」「上個月」或「指定月份」。
            </p>
          ) : null}

          {/* 模組 8 §11.10:查詢區間涵蓋機制上線前的月份時,「月薪基本額合計」是用最早的已知薪資
              回推估算,提醒使用者僅供參考。只在 salary_estimation_applied=true 時顯示,不是每次
              查詢都出現(避免嚇到使用者)。樣式比照既有 over_deduction_warning 警示區塊的既有寫法。 */}
          {summary.salary_estimation_applied ? (
            <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
              ⚠️
              查詢區間內有部分月份早於系統開始記錄薪資歷史的時間,這些月份的金額是用最早的已知薪資回推估算,僅供參考。
            </p>
          ) : null}

          {/* 商家端調整批次(2026-09-22)§3.5:「稅金小計」搬到「商家總淨利」正上方,尺寸比照
              「商家總淨利」卡片(兩者這次形成視覺上的一組,方便使用者把「稅金是從含稅營收裡先拆
              出來、不計入淨利」這個關係連在一起看),其餘統計卡維持原本的 grid 排列不變。 */}
          <Card>
            <CardHeader>
              <CardTitle>稅金小計</CardTitle>
              <CardDescription>
                這段期間完成訂單的稅金加總,已經從「商家總淨利」的計算中排除。
              </CardDescription>
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
              {/* 這個數字的計算式含月薪成本,所以月薪算不出來時它也算不出來。刻意不退化成
                  「不扣月薪的淨利」——那個數字會比真實淨利高很多,比顯示不出來更危險。 */}
              {netMarginDisplay.kind === "value" ? (
                <p className="text-2xl font-semibold text-foreground">
                  {netMarginDisplay.value.toLocaleString()} 元
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{netMarginDisplay.text}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>服務人員明細</CardTitle>
              {/* 2026-09-24 使用者裁決:這行原本寫「目前在職(active)的服務人員」,在資料庫把判斷
                  基準改成「那個時間點誰在職」之後就不再正確了,一起更新。 */}
              <CardDescription>
                查詢期間內在職的服務人員,依姓名排序。期間內在職、現在已離職的人也會列出來(標示
                「已離職」),這樣明細加總才跟上方的統計卡對得起來。
              </CardDescription>
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
                        {/* 2026-09-24 使用者裁決:查過去月份時,「當時在職、現在已離職」的人會出現
                            在這張表裡(留歷史紀錄,明細加總才跟上方卡片對得起來),所以要標「已離職」。
                            樣式沿用專案既有慣例:非啟用狀態一律用 variant="secondary"(比照
                            MaterialCostsPage 的「已下架」、MembersListPage 的會員停用狀態),
                            不自創顏色。
                            手機版:用 flex-wrap + 名字 min-w-0,窄畫面時標籤自己換到名字下一行,
                            不會把這一欄撐寬、也不會溢出(明細表本來就窄)。 */}
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="min-w-0">{row.staff_name}</span>
                            {shouldShowResignedBadge(row) ? (
                              <Badge variant="secondary" className="shrink-0">
                                {RESIGNED_LABEL}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          {row.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬"}
                        </TableCell>
                        <TableCell className="text-right">{row.order_count}</TableCell>
                        {/* 2026-09-24 使用者裁決:月薪制那一欄原本寫 `row.net_pay ?? 0`,
                            區間不是完整月份時會顯示「0 元(淨額)」——這正是要避免的誤導。
                            改成顯示說明文字。按件計酬的抽成裁決是「null 一律當 0」(沒接單的抽成
                            確實就是 0),顯示格式跟以前完全一樣,只是把「怎麼算出那個數字」搬進
                            commissionCellText() —— CSV 那一欄也是呼叫同一條路徑,不會再漂移。 */}
                        <TableCell className="text-right">
                          {row.compensation_type === "monthly_salary"
                            ? monthlySalaryCellText(salaryApplicable, row.net_pay)
                            : commissionCellText(row)}
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

/** 統計卡。value 是 null/undefined 代表「這個數字這次算不出來」,顯示 unavailableText 而不是 0
 * ——顯示 0 會被讀成「真的是零」,對月薪成本這種數字是會誤導經營判斷的。 */
function SummaryCard({
  label,
  value,
  unavailableText = "—",
}: {
  label: string;
  value: number | null | undefined;
  unavailableText?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        {value === null || value === undefined ? (
          <p className="text-sm text-muted-foreground">{unavailableText}</p>
        ) : (
          <p className="text-lg font-semibold text-foreground">{value.toLocaleString()} 元</p>
        )}
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
