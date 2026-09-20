// 對應規格書 4.5:我的薪資報表頁(新路由 /app/my-payroll)。年月選擇器 + 依自己的
// compensation_type 顯示對應版面,版面邏輯直接複用模組 8 StaffReportPage.tsx 已經寫好的
// 「依計酬類型切版」邏輯(PieceRateStaffReport/MonthlySalaryStaffReport,兩者的 staffId 都是
// 外部傳入的 prop,這裡鎖定自己的 staffId,不耦合「怎麼決定 staffId」這件事本身)。

import { Link } from "react-router-dom";

import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  MonthlySalaryStaffReport,
  PieceRateStaffReport,
} from "@/modules/payroll/StaffReportPage";
import { useYearMonthState, YearMonthPicker } from "@/modules/payroll/YearMonthPicker";

import { useActiveMyStaffRecord } from "./context";
import { RequireStaffPayrollAccess } from "./RequireStaffPayrollAccess";

function MyPayrollPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const { year, month, setYear, setMonth } = useYearMonthState();

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">我的薪資報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">查看自己的抽成明細或薪資扣款明細</p>
      </div>

      <YearMonthPicker year={year} month={month} onYearChange={setYear} onMonthChange={setMonth} />

      {!staffRow ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : staffRow.compensation_type === "monthly_salary" ? (
        <MonthlySalaryStaffReport
          staffId={staffRow.id}
          staffName={staffRow.name}
          year={year}
          month={month}
        />
      ) : (
        <PieceRateStaffReport
          staffId={staffRow.id}
          staffName={staffRow.name}
          year={year}
          month={month}
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
