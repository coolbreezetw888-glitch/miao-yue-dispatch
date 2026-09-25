// 對應模組 8(薪資與帳務)規格書 §4.4:服務人員報表頁(原名「師傅報表」,2026-09-24 改名;路由 /app/staff-report 不變)。服務人員選擇 +
// 年月選擇器,依選中服務人員的計酬類型顯示不同版面(抽成制:訂單明細+總計;月薪制:扣款明細+
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
  const { data: summary, isLoading, error } = dateRange ? rangeQuery : monthQuery;
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

  if (isLoading) return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  if (error || !summary)
    return <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>;

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
                <p className="text-lg font-semibold text-foreground">
                  {formatAmount(summary.total_amount)}
                </p>
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
            <p className="text-sm text-muted-foreground">
              {dateRange ? "這段期間沒有已完成的訂單。" : "這個月沒有已完成的訂單。"}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {/* #781:見上面 CSV headers 的說明,畫面與 CSV 兩邊標題要一致。 */}
                  <TableHead>完成日期</TableHead>
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
                        <TableCell>
                          {new Date(d.completion_date).toLocaleDateString("zh-TW")}
                        </TableCell>
                        <TableCell>{d.customer_name}</TableCell>
                        {/* 2026-09-24 稽核修正(問題 4):明細列原本直接印原始值(例如 99.5),
                            摘要卡片卻走 formatAmount(四捨五入成 $100),同一頁兩種格式,
                            服務人員拿計算機加明細會跟卡片對不上,產生「是不是被扣了」的信任問題。
                            這裡改成一律走同一支 formatAmount,格式統一。 */}
                        <TableCell className="text-right">
                          {formatAmount(d.commission_base_amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatAmount(d.commission_amount)}
                          {d.recalculated ? (
                            <span className="ml-1 text-xs text-warn">(已重算)</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleExpanded(d.booking_id)}
                          >
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
                                  <li
                                    key={idx}
                                    className="flex flex-wrap items-center justify-between gap-2"
                                  >
                                    <span>
                                      {item.service_item_name} × {item.quantity}(
                                      {item.commission_mode === "percentage"
                                        ? `${item.commission_value}%`
                                        : `${item.commission_value} 元/件`}
                                      )
                                    </span>
                                    {/* 問題 4:展開後的逐項抽成明細一樣統一走 formatAmount。 */}
                                    <span className="font-medium">
                                      {formatAmount(item.commission_amount)}
                                    </span>
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
  const { data: summary, isLoading, error } = dateRange ? rangeQuery : monthQuery;

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

  if (isLoading) return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  if (error || !summary)
    return <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {dateRange ? "月休假額度" : "本月休假額度"} {summary.monthly_leave_quota_days ?? "未設定"}{" "}
          天(僅供參考,不影響薪資計算),這段期間實際請假 {summary.total_leave_days} 天
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
            <p className="text-lg font-semibold text-foreground">
              {summary.monthly_base_salary} 元
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>總扣款</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold text-foreground">
              {summary.total_deduction_amount} 元
            </p>
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

      {/* 模組 8 §11.10:這個月(或查詢區間內有部分月份)早於系統開始記錄薪資歷史的時間,「月薪
          基本額」是用最早的已知薪資回推估算,提醒使用者僅供參考。這個元件同時被 StaffReportPage.tsx
          (商家管理員視角)跟 MyPayrollPage.tsx(服務人員自助視角)共用,兩邊都會自動套用這個提示,
          不需要各自重複實作。 */}
      {summary.salary_history_estimated ? (
        <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
          ⚠️ 這段期間早於系統開始記錄薪資歷史的時間,月薪基本額是用最早的已知薪資回推估算,僅供參考。
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>假別扣款明細</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.details.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {dateRange ? "這段期間沒有需要扣款的請假紀錄。" : "這個月沒有需要扣款的請假紀錄。"}
            </p>
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">服務人員報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」個別服務人員的抽成/薪資報表
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="staff-select">
            服務人員
          </label>
          {/* 2026-09-24 稽核修正(問題 3):稽核清單沒有列到這一站,但它其實是全專案最典型的
              受害情境——selectedStaffId 是在上面的 useEffect 裡「等 staffList 載入完才退回
              選名單第一位」灌進去的,而且從「服務人員明細」點「查看明細」過來時還會再帶一次
              網址參數,兩種都是掛載之後才改 value 的時序。被洗成空字串的話,畫面會卡在
              「請選擇服務人員」,使用者明明是從連結點過來的卻看不到任何報表。
              合法值是資料庫來的動態清單(服務人員 id),判斷條件是「不是空字串」。 */}
          <Select
            value={selectedStaffId}
            onValueChange={guardPhantomEmptyChange(setSelectedStaffId)}
          >
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
        <YearMonthPicker
          year={year}
          month={month}
          onYearChange={setYear}
          onMonthChange={setMonth}
        />
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
