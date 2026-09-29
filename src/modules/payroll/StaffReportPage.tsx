// 對應模組 8(薪資與帳務)規格書 §4.4:服務人員報表頁(原名「師傅報表」,2026-09-24 改名;路由 /app/staff-report 不變)。服務人員選擇 +
// 年月選擇器,依選中服務人員的計酬類型顯示不同版面(抽成制:訂單明細+總計;月薪制:扣款明細+
// 淨額)+ CSV 匯出按鈕。
//
// ui-v1-full 第二階段第 2 批(2026-09-29):這一頁沒有彈窗,套用頁面層級規範。
//   - 抽成制訂單明細從多欄表格改成 ListCard(skill 一:列表一律卡片式):客戶名 + 完成日期,金額用明細列
//     (DetailRow)放在卡片裡,「展開 / 收合」維持原本的切換邏輯、展開後的逐項抽成明細也用 DetailRow。
//   - 月薪制假別扣款明細改成明細列(DetailSection + DetailRow,標籤 = 假別(天數)、值 = 扣款金額)。
//   - 「扣款超過月薪」「回推估算」兩段提醒改 `!` 常駐;載入中改骨架、出錯改 ErrorState、空狀態改 EmptyState。
//   - 服務人員下拉改 FieldSelect(保留 guardPhantomEmptyChange)、頁首改 PageHeader、匯出按鈕改次要樣式。
// PieceRateStaffReport / MonthlySalaryStaffReport 同時被服務人員端 MyPayrollPage.tsx 複用,兩邊會一起換新外觀。
// **只動外觀與版面,不動任何行為**:查詢、CSV 匯出內容、金額格式化(formatAmount)照舊。

import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  AlertNote,
  AttributeTag,
  DetailDivider,
  DetailRow,
  DetailSection,
  EmptyState,
  ErrorState,
  FieldSelect,
  FormField,
  ListCard,
  LoadingSkeleton,
  PageHeader,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// 2026-09-24 稽核修正(問題 3):Radix Select 幽靈空值事件的共用防護,見該檔案開頭的完整說明。
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
// 模組 14(服務人員端)v2 §10.4.4:摘要卡片的金額顯示格式,沿用既有的跨模組共用格式化函式
// (staff-portal 模組已經有 import booking/dateUtils 的既有先例,這裡是同樣的模式)。
import { formatAmount } from "@/modules/booking/orderAmount";

import {
  useStaffCommissionSummary,
  useStaffCommissionSummaryByRange,
  useStaffMonthlyPayrollSummary,
  useStaffMonthlyPayrollSummaryByRange,
} from "./api";
import { buildCsvContent, downloadCsv } from "./csvExport";
import { formatStaffCommissionItemBreakdown } from "./types";
import { RequireStaffReportAccess } from "./RequireStaffReportAccess";
import { YearMonthPicker, useYearMonthState } from "./YearMonthPicker";

/** 摘要統計卡(完成訂單 / 我的抽成 / 月薪基本額 …)。 */
function StatCard({ label, value }: { label: string; value: string }) {
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

// 模組 14(服務人員端)規格書 4.5:這兩個版面元件直接被 MyPayrollPage.tsx 複用(export 出去),
// 介面設計上 staffId 本來就是外部傳入的 prop,不耦合「怎麼決定 staffId」這件事本身——管理員版本
// (下面 StaffReportPage)呼叫時自己選 staffId,自助版本呼叫時鎖定自己的 staffId,兩者共用同一套
// 渲染邏輯與計算結果,不會日後各自修改產生數字不一致的風險。
export function PieceRateStaffReport({
  staffId,
  staffName,
  year,
  month,
  dateRange,
  showCsvExport = true,
  showSummaryCards = false,
}: {
  staffId: string;
  staffName: string;
  /** 商家管理員視角(StaffReportPage.tsx)一定會傳,服務人員自助視角改傳 dateRange 時可以不傳。 */
  year?: number;
  month?: number;
  /** 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:服務人員自助頁面(MyPayrollPage.tsx)改
   * 傳這個區間物件,取代 year/month,改用 get_staff_commission_summary_by_range 查詢;商家管理員
   * 視角(StaffReportPage.tsx)不傳,繼續吃 year/month,維持既有行為不變。 */
  dateRange?: { startDate: string; endDate: string };
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面(MyPayrollPage.tsx)傳 false 拿掉 CSV
   * 匯出按鈕;商家管理員視角(StaffReportPage.tsx)不傳,吃預設值 true,維持既有行為不變。 */
  showCsvExport?: boolean;
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面傳 true 顯示三張摘要卡片(完成訂單/
   * 我的抽成/訂單總額);商家管理員視角不傳,吃預設值 false,維持既有版面不變。 */
  showSummaryCards?: boolean;
}) {
  // 兩個 hook 都無條件呼叫(react hooks 規則),各自的 enabled 條件會確保只有其中一個真的送出
  // 請求——沒有 dateRange 時走原本的年/月查詢(商家管理員視角),有 dateRange 時走區間查詢
  // (服務人員自助視角)。
  const monthQuery = useStaffCommissionSummary(
    staffId,
    dateRange ? null : year,
    dateRange ? null : month,
  );
  const rangeQuery = useStaffCommissionSummaryByRange(
    staffId,
    dateRange ? dateRange.startDate : null,
    dateRange ? dateRange.endDate : null,
  );
  const { data: summary, isLoading, error, refetch } = dateRange ? rangeQuery : monthQuery;
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
    // #781:欄位標題寫「完成日期」而不是只寫「日期」——#767 之後這一欄裝的是「按下完成的
    // 那一刻」,報表讀者(服務人員/商家)自己就看得懂這份報表的認列口徑是什麼,
    // 這比在畫面上掛一個會被關掉、會過時的說明橫幅有效得多(#782 刻意不加橫幅的理由)。
    const headers = ["完成日期", "客戶", "抽成基準", "服務項目明細", "抽成金額", "已被人工重算"];
    const rows = summary.details.map((d) => [
      d.completion_date,
      d.customer_name,
      d.commission_base_amount,
      formatStaffCommissionItemBreakdown(d),
      d.commission_amount,
      d.recalculated ? "是" : "否",
    ]);
    const periodLabel = dateRange
      ? `${dateRange.startDate}_${dateRange.endDate}`
      : `${year}-${String(month).padStart(2, "0")}`;
    downloadCsv(`服務人員報表_${staffName}_${periodLabel}.csv`, buildCsvContent(headers, rows));
  }

  if (isLoading) return <LoadingSkeleton variant="cards" rows={3} />;
  if (error || !summary)
    return (
      <ErrorState
        title="讀不到這份報表"
        reason={getErrorMessage(error)}
        onRetry={() => void refetch()}
      />
    );

  const assistantLine = (
    <p className="text-sm text-muted-foreground">
      以助手身份參與 {summary.assistant_booking_count} 筆訂單(不列入抽成計算,只是參考資訊)
    </p>
  );
  const csvButton = showCsvExport ? (
    <Button
      type="button"
      variant="neutral"
      size="card"
      className="shrink-0"
      onClick={handleExportCsv}
    >
      匯出這份報表為 CSV
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面新增三張摘要卡片(完成訂單/我的抽成/
          訂單總額),取代下面 Card 標題底下原本的 CardDescription 文字(避免同一個數字在畫面上
          出現兩次)。「以助手身份參與...」這行參考文字保留,移到摘要卡片下方,不刪除。 */}
      {showSummaryCards ? (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="完成訂單" value={`${summary.total_orders} 筆`} />
          <StatCard label="我的抽成" value={formatAmount(summary.total_commission_amount)} />
          <StatCard label="訂單總額" value={formatAmount(summary.total_amount)} />
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {assistantLine}
        {csvButton}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>訂單明細</CardTitle>
          {!showSummaryCards ? (
            /* 2026-09-24 稽核修正(問題 4):金額顯示統一走 formatAmount,不要一邊用
               formatAmount(摘要卡片)一邊直接印原始值(這裡跟下面的明細列),
               否則同一個數字在同一頁會長得不一樣,服務人員會懷疑是不是被扣了錢。 */
            <CardDescription>
              總計 {summary.total_orders} 筆訂單,抽成合計{" "}
              {formatAmount(summary.total_commission_amount)}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          {summary.details.length === 0 ? (
            <EmptyState
              title={dateRange ? "這段期間沒有已完成的訂單" : "這個月沒有已完成的訂單"}
              description="訂單要按下「標記完成」之後才會列進抽成報表,可以換一個期間再查。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {summary.details.map((d) => {
                const expanded = expandedIds.has(d.booking_id);
                return (
                  <li key={d.booking_id}>
                    {/* skill 二之五 列表卡片(取代多欄表格):客戶名 + 完成日期,金額用明細列放在卡片裡
                        (skill 二之六:標籤淡、值粗、tabular-nums),右側「展開 / 收合」切換逐項抽成明細。
                        #781:「完成日期」跟 CSV 標題一致。 */}
                    <ListCard
                      title={d.customer_name}
                      tags={d.recalculated ? <AttributeTag>已人工重算</AttributeTag> : undefined}
                      meta={<>完成日期 {new Date(d.completion_date).toLocaleDateString("zh-TW")}</>}
                      primaryAction={
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          aria-expanded={expanded}
                          onClick={() => toggleExpanded(d.booking_id)}
                        >
                          {expanded ? "收合" : "展開"}
                        </Button>
                      }
                    >
                      <div className="mt-2 flex flex-col gap-1">
                        {/* 2026-09-24 稽核修正(問題 4):明細一律走同一支 formatAmount,格式統一。 */}
                        <DetailRow label="抽成基準" size="sm">
                          {formatAmount(d.commission_base_amount)}
                        </DetailRow>
                        <DetailRow label="抽成金額">{formatAmount(d.commission_amount)}</DetailRow>
                        {expanded ? (
                          <Fragment>
                            <DetailDivider className="my-1" />
                            {d.item_breakdown.length === 0 && d.legacy_rate_percentage !== null ? (
                              <p className="text-[13px] text-muted-foreground">
                                這筆是改版前的舊制紀錄,抽成比例 {d.legacy_rate_percentage}%
                              </p>
                            ) : d.item_breakdown.length === 0 ? (
                              <p className="text-[13px] text-muted-foreground">沒有抽成明細</p>
                            ) : (
                              d.item_breakdown.map((item, idx) => (
                                // 標籤是「服務項目名稱 × 數量(抽成規則)」,名稱是商家自填的動態文字;
                                // DetailRow 兩側都不 shrink-0,長名稱會折行、金額不會被壓成直排。
                                <DetailRow
                                  key={idx}
                                  size="sm"
                                  label={`${item.service_item_name} × ${item.quantity}(${
                                    item.commission_mode === "percentage"
                                      ? `${item.commission_value}%`
                                      : `${item.commission_value} 元/件`
                                  })`}
                                >
                                  {formatAmount(item.commission_amount)}
                                </DetailRow>
                              ))
                            )}
                          </Fragment>
                        ) : null}
                      </div>
                    </ListCard>
                  </li>
                );
              })}
            </ul>
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
  dateRange,
  showCsvExport = true,
}: {
  staffId: string;
  staffName: string;
  year?: number;
  month?: number;
  /** 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:服務人員自助頁面改傳這個區間物件,取代
   * year/month,改用 get_staff_monthly_payroll_summary_by_range 查詢;商家管理員視角不傳,繼續
   * 吃 year/month。 */
  dateRange?: { startDate: string; endDate: string };
  /** 模組 14(服務人員端)v2 §10.4.4:服務人員自助頁面傳 false 拿掉 CSV 匯出按鈕;商家管理員
   * 視角不傳,吃預設值 true,維持既有行為不變。這次需求 4 沒有提到要調整月薪制服務人員報表
   * 的摘要卡片(本來就已經有三張卡片),不新增 showSummaryCards 這個 prop。 */
  showCsvExport?: boolean;
}) {
  const monthQuery = useStaffMonthlyPayrollSummary(
    staffId,
    dateRange ? null : year,
    dateRange ? null : month,
  );
  const rangeQuery = useStaffMonthlyPayrollSummaryByRange(
    staffId,
    dateRange ? dateRange.startDate : null,
    dateRange ? dateRange.endDate : null,
  );
  const { data: summary, isLoading, error, refetch } = dateRange ? rangeQuery : monthQuery;

  function handleExportCsv() {
    if (!summary) return;
    const headers = ["假別", "天數", "扣款模式", "扣款金額"];
    const rows = summary.details.map((d) => [
      d.leave_type_name,
      d.days,
      d.deduction_mode,
      d.deduction_amount,
    ]);
    const periodLabel = dateRange
      ? `${dateRange.startDate}_${dateRange.endDate}`
      : `${year}-${String(month).padStart(2, "0")}`;
    downloadCsv(`服務人員報表_${staffName}_${periodLabel}.csv`, buildCsvContent(headers, rows));
  }

  if (isLoading) return <LoadingSkeleton variant="cards" rows={3} />;
  if (error || !summary)
    return (
      <ErrorState
        title="讀不到這份報表"
        reason={getErrorMessage(error)}
        onRetry={() => void refetch()}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm tabular-nums text-muted-foreground">
          {dateRange ? "月休假額度" : "本月休假額度"} {summary.monthly_leave_quota_days ?? "未設定"}{" "}
          天(僅供參考,不影響薪資計算),這段期間實際請假 {summary.total_leave_days} 天
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
        <StatCard label="月薪基本額" value={`${summary.monthly_base_salary} 元`} />
        <StatCard label="總扣款" value={`${summary.total_deduction_amount} 元`} />
        <StatCard label="實發淨額" value={`${summary.net_pay} 元`} />
      </div>

      {/* skill 二:「現在的狀態跟使用者以為的不一樣」⇒ `!` 常駐。 */}
      {summary.over_deduction_warning ? (
        <AlertNote>扣款金額已超過月薪基本額,請留意這個月的請假紀錄或薪資設定是否正確。</AlertNote>
      ) : null}

      {/* 模組 8 §11.10:這個月(或查詢區間內有部分月份)早於系統開始記錄薪資歷史的時間,「月薪
          基本額」是用最早的已知薪資回推估算,提醒使用者僅供參考。這個元件同時被 StaffReportPage.tsx
          (商家管理員視角)跟 MyPayrollPage.tsx(服務人員自助視角)共用,兩邊都會自動套用這個提示,
          不需要各自重複實作。 */}
      {summary.salary_history_estimated ? (
        <AlertNote>
          這段期間早於系統開始記錄薪資歷史的時間,月薪基本額是用最早的已知薪資回推估算,僅供參考。
        </AlertNote>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>假別扣款明細</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.details.length === 0 ? (
            <EmptyState
              title={dateRange ? "這段期間沒有需要扣款的請假紀錄" : "這個月沒有需要扣款的請假紀錄"}
              description="只有扣款規則不是「不扣款」的假別會列在這裡。"
            />
          ) : (
            // skill 二之六 明細列:標籤 = 假別(天數)、值 = 扣款金額;假別名稱是商家自填的動態文字,
            // DetailRow 兩側都能折行。
            <DetailSection>
              {summary.details.map((d) => (
                <DetailRow key={d.leave_type_id} label={`${d.leave_type_name}(${d.days} 天)`}>
                  {d.deduction_amount} 元
                </DetailRow>
              ))}
            </DetailSection>
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
      <PageHeader
        backTo="/app/manage"
        title="服務人員報表"
        description={`「${merchant!.name}」個別服務人員的抽成/薪資報表`}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField label="服務人員" htmlFor="staff-select" className="sm:w-64">
          {/* 2026-09-24 稽核修正(問題 3):稽核清單沒有列到這一站,但它其實是全專案最典型的
              受害情境——selectedStaffId 是在上面的 useEffect 裡「等 staffList 載入完才退回
              選名單第一位」灌進去的,而且從「服務人員明細」點「查看明細」過來時還會再帶一次
              網址參數,兩種都是掛載之後才改 value 的時序。被洗成空字串的話,畫面會卡在
              「請選擇服務人員」,使用者明明是從連結點過來的卻看不到任何報表。
              合法值是資料庫來的動態清單(服務人員 id),判斷條件是「不是空字串」。 */}
          <FieldSelect
            id="staff-select"
            value={selectedStaffId}
            onValueChange={guardPhantomEmptyChange(setSelectedStaffId)}
            placeholder="選擇服務人員"
            options={(staffList ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        </FormField>
        <YearMonthPicker
          year={year}
          month={month}
          onYearChange={setYear}
          onMonthChange={setMonth}
        />
      </div>

      {!staffList || staffList.length === 0 ? (
        <EmptyState
          title="目前沒有在職的服務人員"
          description="新增服務人員並完成訂單之後,這裡才會有報表可以看。"
        />
      ) : !selectedStaff ? (
        <EmptyState title="請選擇服務人員" description="從上方的下拉選單挑一位服務人員。" />
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
