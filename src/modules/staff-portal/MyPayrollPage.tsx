// 對應規格書 4.5:我的薪資報表頁(新路由 /app/my-payroll)。依自己的 compensation_type 顯示
// 對應版面,版面邏輯直接複用模組 8 StaffReportPage.tsx 已經寫好的「依計酬類型切版」邏輯
// (PieceRateStaffReport/MonthlySalaryStaffReport,兩者的 staffId 都是外部傳入的 prop,這裡鎖定
// 自己的 staffId,不耦合「怎麼決定 staffId」這件事本身)。
//
// 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:時間篩選這次從原本(模組 14 v2 §10.4.5/
// §10.4.6)的月份箭頭切換樣式,改成區間篩選(起訖日期或起訖月份,最長一年),比照店家帳務報表
// 同一套 DateRangePicker 元件跟同一套一年上限規則——原本的 MyYearMonthSwitcher.tsx 已經被這次
// 的區間篩選取代並移除,不留下死掉的舊元件。

import { Link } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  MonthlySalaryStaffReport,
  PieceRateStaffReport,
} from "@/modules/payroll/StaffReportPage";
import { DateRangePicker, useDateRangeState } from "@/modules/payroll/DateRangePicker";

import { useActiveMyStaffRecord } from "./context";
import { RequireStaffPayrollAccess } from "./RequireStaffPayrollAccess";

function MyPayrollPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const { startDate, endDate, setStartDate, setEndDate } = useDateRangeState();
  const dateRange = { startDate, endDate };

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">薪資報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          查看自己的抽成明細或薪資扣款明細,可選起訖日期或起訖月份,最長查詢一年範圍
        </p>
      </div>

      <DateRangePicker
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
      />

      {!staffRow ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : staffRow.compensation_type === "monthly_salary" ? (
        <MonthlySalaryStaffReport
          staffId={staffRow.id}
          staffName={staffRow.name}
          dateRange={dateRange}
          showCsvExport={false}
        />
      ) : (
        <PieceRateStaffReport
          staffId={staffRow.id}
          staffName={staffRow.name}
          dateRange={dateRange}
          showCsvExport={false}
          showSummaryCards={true}
        />
      )}
    </main>
  );
}

export default function MyPayrollPage() {
  return (
    <RequireStaffPayrollAccess>
      <MyPayrollPageInner />
    </RequireStaffPayrollAccess>
  );
}
