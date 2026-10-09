// 對應規格書 4.5:我的薪資報表頁(新路由 /app/my-payroll)。依自己的 compensation_type 顯示
// 對應版面,版面邏輯直接複用模組 8 StaffReportPage.tsx 已經寫好的「依計酬類型切版」邏輯
// (PieceRateStaffReport/MonthlySalaryStaffReport,兩者的 staffId 都是外部傳入的 prop,這裡鎖定
// 自己的 staffId,不耦合「怎麼決定 staffId」這件事本身)。
//
// 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:時間篩選這次從原本(模組 14 v2 §10.4.5/
// §10.4.6)的月份箭頭切換樣式,改成區間篩選(起訖日期或起訖月份,最長一年),比照店家帳務報表
// 同一套 DateRangePicker 元件跟同一套一年上限規則——原本的 MyYearMonthSwitcher.tsx 已經被這次
// 的區間篩選取代並移除,不留下死掉的舊元件。

//
// #1035 追加(使用者 2026-10-09 選 B、主腦裁決):目前月薪制、而且上個月(月底當時)有獎金方案的人,
// 預設區間改成「上個月整月」(按月份),一進來就看得到獎金;其他人照舊(本月 1 號到今天、按日期)。判斷邏輯見 myPayrollDefaultRange.ts。
// 先等「有沒有方案」查完才掛上區間篩選與報表(避免先顯示本月、再跳到上個月,也避免多打一輪報表查詢)。

import { useState } from "react";

import { LoadingSkeleton } from "@/components/patterns";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useStaffBonusByRange } from "@/modules/payroll/api";
import { MonthlySalaryStaffReport, PieceRateStaffReport } from "@/modules/payroll/StaffReportPage";
import { DateRangePicker, useDateRangeState } from "@/modules/payroll/DateRangePicker";
import { WageStaffReport } from "@/modules/payroll/WageStaffReport";
import { isWageCompensationType } from "@/modules/staff-agent/types";

import { useActiveMyStaffRecord } from "./context";
import {
  bonusPlanProbeRange,
  myPayrollInitialRange,
  shouldProbeBonusPlan,
  type MyPayrollInitialRange,
} from "./myPayrollDefaultRange";
import { RequireStaffPayrollAccess } from "./RequireStaffPayrollAccess";

type ActiveStaffRow = NonNullable<ReturnType<typeof useActiveMyStaffRecord>["data"]>;

function MyPayrollPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const needsProbe = shouldProbeBonusPlan(staffRow?.compensation_type);
  // 只在第一次進頁面時算一次(之後切換日期不會再改預設)。查的是上個月整月。
  const [probeRange] = useState(() => bonusPlanProbeRange());
  const probe = useStaffBonusByRange(
    needsProbe ? staffRow?.id : null,
    probeRange.startDate,
    probeRange.endDate,
    { retry: false },
  );
  // 查詢失敗就當沒有方案(維持原本預設),不擋住整頁;不重試,免得骨架卡好幾秒。
  const probeSettled = !needsProbe || probe.isSuccess || probe.isError;
  const initialRange =
    staffRow && probeSettled
      ? myPayrollInitialRange({
          compensationType: staffRow.compensation_type,
          hasBonusPlan: probe.data?.has_any_plan === true,
        })
      : null;

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      {/* 商家端調整批次(2026-09-22,#609):這個頁面現在是底部「薪資報表」分頁籤直接可達的
          目的地,不再是「功能」卡片底下的子頁面,不需要「← 返回功能」連結
          (/app/manage 對服務人員角色而言已經沒有對應入口)。 */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">薪資報表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          查看自己的抽成明細或薪資扣款明細，可選起訖日期或起訖月份，最長查詢一年範圍
        </p>
      </div>

      {!staffRow || !initialRange ? (
        /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
        <LoadingSkeleton variant="lines" rows={3} />
      ) : (
        <MyPayrollReportSection staffRow={staffRow} initialRange={initialRange} />
      )}
    </main>
  );
}

function MyPayrollReportSection({
  staffRow,
  initialRange,
}: {
  staffRow: ActiveStaffRow;
  initialRange: MyPayrollInitialRange;
}) {
  const { startDate, endDate, setStartDate, setEndDate } = useDateRangeState({
    startDate: initialRange.startDate,
    endDate: initialRange.endDate,
  });
  const dateRange = { startDate, endDate };

  return (
    <>
      <DateRangePicker
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        initialGranularity={initialRange.granularity}
      />

      {staffRow.compensation_type === "monthly_salary" ? (
        <MonthlySalaryStaffReport
          staffId={staffRow.id}
          staffName={staffRow.name}
          dateRange={dateRange}
          showCsvExport={false}
        />
      ) : isWageCompensationType(staffRow.compensation_type) ? (
        // #1035 B 批 PB-B02:日薪／時薪制看自己的上工天數、時數與工資。
        <WageStaffReport
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
    </>
  );
}

export default function MyPayrollPage() {
  return (
    <RequireStaffPayrollAccess>
      <MyPayrollPageInner />
    </RequireStaffPayrollAccess>
  );
}
