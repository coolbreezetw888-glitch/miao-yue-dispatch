// 對應模組 8(薪資與帳務)規格書 §4.3:店家端帳務報表頁(新路由 /app/billing-report)。
// 頂部摘要卡片 + 服務人員明細 + CSV 匯出按鈕(判斷 10,前端直接把畫面上已經抓到的資料轉成
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
//
// ui-v1-full 第二階段第 2 批(2026-09-29):這一頁沒有彈窗,套用頁面層級規範。
//   - 服務人員明細從多欄表格改成 ListCard(skill 一:列表一律卡片式,不做多欄表格):姓名 + 計酬類型
//     (屬性標籤)+ 已離職(狀態標籤);訂單筆數與金額放在次要資訊;「查看明細」是真正的 <Link>
//     (可右鍵 / 中鍵開新分頁),放在卡片右側主要動作位置。
//   - 「月薪算不出來」「回推估算」兩段提醒改 `!` 常駐(AlertNote);載入中改骨架、出錯改 ErrorState。
//   - 頁首改 PageHeader、匯出按鈕改次要樣式。
// **只動外觀與版面,不動任何行為**:所有「該顯示數字還是說明文字」的判斷仍走 billingReportDisplay.ts,
// CSV 匯出的內容與格式完全不變。

import { Link } from "react-router-dom";

import {
  AlertNote,
  AttributeTag,
  EmptyState,
  ErrorState,
  HelpToggle,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { useCurrentMerchant } from "@/modules/merchant/context";

import { useMerchantBillingSummaryByRange } from "./api";
// 2026-09-24:「該顯示數字還是該顯示說明文字」的判斷全部抽到 billingReportDisplay.ts 並加上單元
// 測試。抽出來的理由寫在那支檔案的檔頭:這一頁的失敗模式是「畫面完全正常、數字是假的」,靠人工
// 點畫面幾乎不可能發現,必須有測試釘住。
import {
  BILLING_SUMMARY_LABELS,
  NET_MARGIN_MATERIAL_COST_HELP,
  POINTS_REDEEM_AMOUNT_DESCRIPTION,
  RESIGNED_LABEL,
  SALARY_UNAVAILABLE_TEXT,
  buildBillingCsvSummarySection,
  commissionCellText,
  commissionCsvValue,
  commissionMaterialNoteText,
  compensationTypeText,
  employmentStatusCsvText,
  monthlySalaryCellText,
  monthlySalaryCsvCell,
  resolveNetMonthlySalary,
  resolveSalaryDisplay,
  salaryCardValue,
  salaryDisplayValue,
  shouldShowResignedBadge,
  shouldShowPointsRedeemAmount,
  shouldShowSalaryUnavailableNotice,
} from "./billingReportDisplay";
import { buildCsvContentFromRows, downloadCsv } from "./csvExport";
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
    refetch,
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

  // §一 §3.3 折衷方案的「查看明細 →」連結需要帶一個具體的年/月給服務人員報表頁(那個頁面這次不在
  // §3.6 範圍內,繼續用單一年月),這裡用區間結束日期所在的年月當作連結目標,是最貼近「使用者
  // 目前在看哪一段期間」的合理落點。
  const linkYear = Number(endDate.slice(0, 4));
  const linkMonth = Number(endDate.slice(5, 7));

  function handleExportCsv() {
    if (!summary) return;
    // ⚠️ 2026-09-24 使用者裁決 A ——「總計區塊放在同一個 CSV 的最上面」,以及這個決定的已知取捨:
    //
    //   改動前,匯出的 CSV 只有下面那段六欄的人員明細,畫面上方那幾張統計卡(總營收、稅金、料錢、
    //   抽成、月薪三項、商家總淨利)一個都沒進去,商家拿去對帳時得自己重新加總一次 —— 而那正是
    //   這一頁本來就已經幫他算好的東西。
    //
    //   選項 A 的代價說清楚:總計區塊是兩欄、明細是六欄,兩段不同形狀的表格疊在同一個檔案裡,
    //   嚴格來說這份 CSV 不再是乾淨的機器可讀格式(程式要 parse 得先跳過前面幾列)。使用者是在
    //   知道這件事的前提下選 A 的,理由是這份報表的真實用途是「用 Excel 打開來對帳給人看」,
    //   不是餵給程式;拆成兩個檔案反而讓對帳的人要同時開兩個視窗。
    //
    //   ➜ 所以看到這個 CSV「上下兩段長得不一樣」不是壞掉,是裁決。需要機器可讀的輸出時請另外開
    //     一支匯出(模組 12 報表匯出中心),不要把這一份改掉。格式細節與逐列的值怎麼決定,在
    //     billingReportDisplay.ts 的 buildBillingCsvSummarySection()(有單元測試釘住)。
    const summarySection = buildBillingCsvSummarySection(summary, startDate, endDate);
    // 「在職狀態」欄:CSV 一樣要帶這個資訊。理由——匯出的用途正是「把報表帶離系統」(丟給會計、
    // 自己在 Excel 對帳),那個情境下使用者看不到畫面上的「已離職」標籤,離職人員的數字就跟現職
    // 人員混在一起,完全無法分辨,等於把「以為系統出錯」這個困惑原封不動搬到一個更難查證的地方
    // (在 Excel 裡沒辦法點回來看)。而且 CSV 沒有版面寬度的限制,多一欄的成本是 0。
    const headers = ["姓名", "計酬類型", "在職狀態", "訂單筆數", "抽成金額", "月薪淨額"];
    const rows = summary.per_staff_breakdown.map((row) => [
      row.staff_name,
      compensationTypeText(row),
      employmentStatusCsvText(row),
      row.order_count,
      // 2026-09-24 使用者裁決(選項 A):抽成是 null 時這裡原本寫 `?? ""`(空白格),而畫面明細表
      // 那一格寫 `?? 0`(顯示「0 元(抽成)」)——同一個欄位、同一位服務人員,畫面跟匯出檔說法不一樣。
      // 裁決是兩邊統一成 0(沒接單的抽成確實就是 0,是真實數字)。現在 fallback 只存在
      // billingReportDisplay.ts 的 COMMISSION_FALLBACK 一處,畫面那支函式也是呼叫這支拿數字的,
      // 結構上不可能只改一邊。
      commissionCsvValue(row),
      // 月薪算不出來時寫進說明文字,不留空白格——CSV 的空白格在 Excel 裡看起來跟 0 很像,
      // 會重演「商家以為這段期間沒有月薪成本」這個誤會。判斷條件跟下面明細那一欄走同一支純函式,
      // 讓畫面跟匯出檔永遠一致。
      monthlySalaryCsvCell(salaryApplicable, row),
    ]);
    downloadCsv(
      `店家報表_${startDate}_${endDate}.csv`,
      // 總計區塊(自帶結尾的空白分隔列)→ 明細標題列 → 明細資料列。明細那一段完全沒動。
      buildCsvContentFromRows([...summarySection, headers, ...rows]),
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="店家報表"
        description={`「${merchant!.name}」的營收與成本彙整。預設依月份查詢(月薪要有完整月份才算得出來)，需要任意天數的區間時可切到「自訂區間」，最長查詢一年範圍。`}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
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
        </div>
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="shrink-0"
          onClick={handleExportCsv}
          disabled={!summary}
        >
          匯出這份報表為 CSV
        </Button>
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : error ? (
        // skill 二之八 出錯:什麼壞了 / 可能原因 / 下一步(+「你的資料沒有遺失」由元件固定加上)。
        <ErrorState
          title="讀不到店家報表"
          reason="可能是網路斷了，或你沒有查看店家報表的權限"
          onRetry={() => void refetch()}
        />
      ) : summary ? (
        <>
          {/* 2026-09-24:這幾張卡的標題文字改成從 BILLING_SUMMARY_LABELS 取,不再寫死在 JSX ——
              CSV 總計區塊的「項目」欄逐項對應的就是這幾張卡,使用者要求兩邊用同一套文案。兩邊各打
              一次中文字的話,哪天有人只改了畫面,匯出檔會留著舊名稱,商家會以為是兩個不同的東西。 */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.revenueExclTax}
              value={summary.total_revenue_excl_tax}
            />
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.materialCost}
              value={summary.total_material_cost}
            />
            {/* #985 第 8 批 8-9:卡片下方一行小字,說明這段期間的抽成有沒有先扣料錢
                (只在有抽成紀錄、而且資料庫有回傳計數時出現)。 */}
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.commissionPayout}
              value={summary.total_commission_payout}
              note={commissionMaterialNoteText(summary)}
            />
            {/* 2026-09-24 使用者裁決:月薪這三張卡在「區間不是完整月份」時顯示說明文字,不顯示
                0(顯示 0 會讓商家以為真的沒有月薪成本)。判斷一律以 salaryApplicable 為準,
                同時把值本身當成 null 傳下去,避免「旗標說不能算、卡片卻還印著一個數字」的不一致。 */}
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.monthlySalaryBase}
              value={salaryCardValue(salaryApplicable, summary.total_monthly_salary_base)}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.monthlySalaryDeduction}
              value={salaryCardValue(salaryApplicable, summary.total_monthly_salary_deduction)}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
            <SummaryCard
              label={BILLING_SUMMARY_LABELS.monthlySalaryNet}
              value={netMonthlySalary}
              unavailableText={SALARY_UNAVAILABLE_TEXT}
            />
            {/* 紅利系統重構 §4.10(#848):統計卡 grid 的最後一格,刻意不插進下面「稅金小計 + 商家總淨利」
                那一組(2026-09-22 §3.5 刻意成組)。顯示條件只看報表函式回傳的 points_feature_enabled
                (判斷 13:只有 billing 鑰匙的客服讀不到設定表);關閉時整張不渲染,不是顯示 0。
                區間模式同樣顯示(單純加總,不需要完整月份)。 */}
            {shouldShowPointsRedeemAmount(summary) ? (
              <SummaryCard
                label={BILLING_SUMMARY_LABELS.pointsRedeemAmount}
                value={Number(summary.total_points_redeem_amount)}
                help={POINTS_REDEEM_AMOUNT_DESCRIPTION}
              />
            ) : null}
          </div>

          {/* 月薪算不出來時,額外解釋「為什麼」跟「怎麼做才看得到」——只顯示「需選擇完整月份才能
              計算」這幾個字,使用者不一定知道要去點哪裡才算完整月份。
              skill 二:「現在的狀態跟使用者以為的不一樣」⇒ `!` 常駐。 */}
          {shouldShowSalaryUnavailableNotice(salaryApplicable) ? (
            <AlertNote>
              月薪是以「一整個月」為單位計算的，目前選的期間不是完整的月份(月初到月底)，所以月薪
              基本額、月薪扣款、月薪實發與商家總淨利這幾個數字沒辦法算。營收、料錢、抽成、訂單筆數
              不受影響，照常顯示。想看月薪與商家總淨利，請改點上面的「本月」「上個月」或「指定月份」。
            </AlertNote>
          ) : null}

          {/* 模組 8 §11.10:查詢區間涵蓋機制上線前的月份時,「月薪基本額合計」是用最早的已知薪資
              回推估算,提醒使用者僅供參考。只在 salary_estimation_applied=true 時顯示,不是每次
              查詢都出現(避免嚇到使用者)。 */}
          {summary.salary_estimation_applied ? (
            <AlertNote>
              查詢區間內有部分月份早於系統開始記錄薪資歷史的時間，這些月份的金額是用最早的已知薪資回推估算，僅供參考。
            </AlertNote>
          ) : null}

          {/* 商家端調整批次(2026-09-22)§3.5:「稅金小計」搬到「商家總淨利」正上方,尺寸比照
              「商家總淨利」卡片(兩者這次形成視覺上的一組,方便使用者把「稅金是從含稅營收裡先拆
              出來、不計入淨利」這個關係連在一起看),其餘統計卡維持原本的 grid 排列不變。 */}
          <Card>
            <CardHeader>
              <CardTitle>{BILLING_SUMMARY_LABELS.taxAmount}</CardTitle>
              <CardDescription>
                這段期間完成訂單的稅金加總，已經從「商家總淨利」的計算中排除。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums text-foreground">
                {summary.total_tax_amount.toLocaleString()} 元
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              {/* #985 第 8 批 8-9:`?` 補充料錢與抽成的關係。HelpToggle 的說明區塊是 basis-full,
                  標題列要是 flex flex-wrap。 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <CardTitle>{BILLING_SUMMARY_LABELS.netMargin}</CardTitle>
                <HelpToggle label="說明：料錢跟抽成怎麼算進商家總淨利">
                  {NET_MARGIN_MATERIAL_COST_HELP}
                </HelpToggle>
              </div>
              <CardDescription>
                總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)。只是
                概估，不含房租/水電等其他營運成本，不是完整的財務損益表。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* 這個數字的計算式含月薪成本,所以月薪算不出來時它也算不出來。刻意不退化成
                  「不扣月薪的淨利」——那個數字會比真實淨利高很多,比顯示不出來更危險。 */}
              {netMarginDisplay.kind === "value" ? (
                <p className="text-2xl font-semibold tabular-nums text-foreground">
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
                查詢期間內在職的服務人員，依姓名排序。期間內在職、現在已離職的人也會列出來(標示
                「已離職」)，這樣明細加總才跟上方的統計卡對得起來。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {summary.per_staff_breakdown.length === 0 ? (
                <EmptyState
                  title="這段期間沒有在職的服務人員"
                  description="換一個查詢期間，或先到服務人員管理新增服務人員。"
                  action={
                    <Button asChild variant="neutral" size="touch">
                      <Link to="/app/staff">前往服務人員管理</Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {summary.per_staff_breakdown.map((row) => (
                    <li key={row.staff_id}>
                      {/* skill 二之五 列表卡片(取代多欄表格):姓名 + 屬性標籤(計酬類型)+ 狀態標籤
                          (已離職)→ 次要資訊(訂單筆數・抽成金額 / 月薪淨額)→ 右側「查看明細」。
                          2026-09-24 使用者裁決:查過去月份時,「當時在職、現在已離職」的人會出現在這裡
                          (留歷史紀錄,明細加總才跟上方卡片對得起來),所以要標「已離職」,整張變灰。
                          月薪制那一格的文字仍走 monthlySalaryCellText(區間不是完整月份時顯示說明文字,
                          不顯示 0);抽成制走 commissionCellText(null 一律當 0)——跟 CSV 同一條路徑。 */}
                      <ListCard
                        title={row.staff_name}
                        state={shouldShowResignedBadge(row) ? "inactive" : "default"}
                        tags={
                          <>
                            <AttributeTag>{compensationTypeText(row)}</AttributeTag>
                            {shouldShowResignedBadge(row) ? (
                              <StatusTag tone="neutral">{RESIGNED_LABEL}</StatusTag>
                            ) : null}
                          </>
                        }
                        meta={
                          <>
                            訂單 {row.order_count} 筆 ・{" "}
                            {row.compensation_type === "monthly_salary"
                              ? monthlySalaryCellText(salaryApplicable, row.net_pay)
                              : commissionCellText(row)}
                          </>
                        }
                        primaryAction={
                          /* SPECS-INDEX 編號 567(規格書「商家端三項調整.md」§三 3.3 折衷方案):
                             兩個報表維持分開頁面,但這裡加一個捷徑連結,點下去直接帶著這位服務
                             人員導到「服務人員報表」頁面(該頁面 §3.6 不在區間篩選範圍內,繼續用
                             單一年月,這裡用區間結束日期所在的年月當作連結目標)。
                             2026-09-29 裁決:會跳頁的動作要是真正的 <Link>,才能右鍵 / 中鍵開新分頁。 */
                          <Button asChild variant="neutral" size="card">
                            <Link
                              to={`/app/staff-report?staffId=${encodeURIComponent(row.staff_id)}&year=${linkYear}&month=${linkMonth}`}
                            >
                              查看明細
                            </Link>
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
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
  help,
  note,
}: {
  label: string;
  value: number | null | undefined;
  unavailableText?: string;
  /** skill 二 `?`:「這是什麼」的說明,要點才展開(目前只有紅利折抵金額卡用)。 */
  help?: string;
  /** #985 第 8 批 8-9:數字下方的一行小字(目前只有總抽成支出卡用);null / 未給 ⇒ 不顯示。 */
  note?: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        {help ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <CardDescription>{label}</CardDescription>
            <HelpToggle label={`說明：${label}是什麼`}>{help}</HelpToggle>
          </div>
        ) : (
          <CardDescription>{label}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {value === null || value === undefined ? (
          <p className="text-sm text-muted-foreground">{unavailableText}</p>
        ) : (
          <p className="text-lg font-semibold tabular-nums text-foreground">
            {value.toLocaleString()} 元
          </p>
        )}
        {note ? (
          <p
            className="mt-1 text-xs leading-snug text-muted-foreground"
            data-testid="summary-card-note"
          >
            {note}
          </p>
        ) : null}
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
