// 模組 12 §4.3:報表匯出中心(新路由 /app/reports)。
// 統一畫面選擇訂單/會員/抽成/請假四種報表類型跟篩選期間，一次操作完成 CSV 下載。這裡完全呼叫
// 各自來源模組已經暴露的對外介面，不新建任何查詢函式(模組獨立性，見規格書第一節判斷 13)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader(`‹ 返回功能` 一行小字)。
//   - 四種報表的切換改底線式切換列,variant="pages"(這是**內容分頁列**:每個分頁是一塊不同的
//     內容、有自己的篩選欄位,不是「同一份名單的不同批」。二之四末段的兩種列規則)。
//   - 所有欄位改 FormField + 共用欄位元件:日期用 FieldDate、服務人員下拉用 FieldSelect。
//   - 🔴「年 / 月」兩個 type=number 輸入框合併成一個 FieldMonth(`<input type="month">`)——
//     第 2 批補這個元件就是給「報表的指定月份」用的(見 FormField.tsx 的 FieldMonth 說明)。
//     手機上原生月份選擇器比兩個小數字框好按太多,也不會出現「月份打成 13」這種輸入。
//     送進 API 的仍然是原本的 year / month 兩個數字,行為沒變。
//   - 🔴 服務人員下拉的選項來自資料庫(動態清單)⇒ 一律套 guardPhantomEmptyChange
//     (src/lib/radixSelectGuard.ts 自己就寫「新加 Select 時建議直接套,一律套上沒有副作用」)。
//     訂單狀態是固定白名單,套的時候一併給白名單判斷函式(最嚴格的那一種用法)。
//   - 「匯出 CSV」是每個分頁唯一的 ① 主要按鈕(一次只會顯示一張卡,畫面上只有一顆,二之三)。
//
// **只動外觀,不動行為**:四份 CSV 的欄位、篩選條件怎麼組、檔名、toast 文案、抽成匯出逐位
// 服務人員容錯跳過的做法全部照舊。
//
// SPECS-INDEX #919(2026-09-30):會員報表 CSV **多一欄「會員類型」**(已完成驗證 / 尚未驗證),
// 見 handleExportMembers 裡的說明。其餘三份報表的欄位完全沒動。

import { useState } from "react";
import {
  FieldDate,
  FieldMonth,
  FieldSelect,
  FormField,
  PageHeader,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { toast } from "sonner";

import { buildCsvContent, downloadCsv } from "@/lib/csv";
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { fetchMerchantBookings } from "@/modules/booking/api";
import { fetchMerchantMembersList } from "@/modules/members/api";
// #919:會員類型的中文對應由會員模組自己提供(模組獨立性:文案與判斷的家在 members,
// 這裡只是使用者,不自己複製一份 if)。
import { memberIdentityStatusLabel } from "@/modules/members/memberIdentityStatus";
import { fetchStaffLeaveRecords, fetchMerchantLeaveTypesAll } from "@/modules/scheduling/api";
import { fetchStaffCommissionSummary } from "@/modules/payroll/api";
import { formatStaffCommissionItemBreakdown } from "@/modules/payroll/types";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { RequireReportExportAccess } from "./RequireReportExportAccess";

type ReportType = "orders" | "members" | "commission" | "leave";

const REPORT_TABS: Array<{ key: ReportType; label: string }> = [
  { key: "orders", label: "訂單" },
  { key: "members", label: "會員" },
  { key: "commission", label: "抽成" },
  { key: "leave", label: "請假" },
];

/** 訂單狀態篩選的固定白名單(給 guardPhantomEmptyChange 的最嚴格用法用)。 */
const ORDER_STATUS_OPTIONS = [
  { value: "__all__", label: "全部狀態" },
  { value: "accepted", label: "已接受" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" },
] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 年 + 月兩個數字 → `<input type="month">` 吃的 `YYYY-MM`。 */
function toMonthValue(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function ReportExportCenterPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffList } = useMerchantStaffList(merchantId);

  const [activeTab, setActiveTab] = useState<ReportType>("orders");
  const [exporting, setExporting] = useState(false);

  // 訂單篩選
  const [orderStartDate, setOrderStartDate] = useState("");
  const [orderEndDate, setOrderEndDate] = useState("");
  const [orderStatus, setOrderStatus] = useState<string>("__all__");

  // 抽成篩選
  const now = new Date();
  const [commissionYear, setCommissionYear] = useState(now.getFullYear());
  const [commissionMonth, setCommissionMonth] = useState(now.getMonth() + 1);
  const [commissionStaffId, setCommissionStaffId] = useState<string>("__all__");

  // 請假篩選
  const [leaveStartDate, setLeaveStartDate] = useState("");
  const [leaveEndDate, setLeaveEndDate] = useState("");
  const [leaveStaffId, setLeaveStaffId] = useState<string>("__all__");

  /** FieldMonth 的 `YYYY-MM` 拆回原本的 year / month 兩個 state(送進 API 的值完全沒變)。
   *  清空欄位或打到一半解析不出來時**不動 state** —— 寧可留著上一個有效月份,也不要讓匯出
   *  拿到 NaN(原本兩個 type=number 欄位清空時就會送出 NaN,這裡順手不再發生)。 */
  function handleCommissionMonthChange(value: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) return;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(year) || month < 1 || month > 12) return;
    setCommissionYear(year);
    setCommissionMonth(month);
  }

  async function handleExportOrders() {
    setExporting(true);
    try {
      const rows = await fetchMerchantBookings(merchantId, {
        ...(orderStartDate ? { startAt: `${orderStartDate}T00:00:00` } : {}),
        ...(orderEndDate ? { endAt: `${orderEndDate}T23:59:59` } : {}),
        ...(orderStatus === "__all__" ? {} : { status: [orderStatus] }),
        unpaged: true,
      });
      const csv = buildCsvContent(
        ["訂單編號", "客戶姓名", "客戶電話", "預約時間", "狀態", "訂單金額", "來源"],
        rows.map((b) => [
          b.id,
          b.customer_name,
          b.customer_phone,
          b.start_at,
          b.status,
          b.final_amount_snapshot,
          b.source,
        ]),
      );
      downloadCsv(`訂單報表_${todayIso()}.csv`, csv);
      toast.success(`已匯出 ${rows.length} 筆訂單`);
    } catch (err) {
      toast.error("匯出失敗", { description: getErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  async function handleExportMembers() {
    setExporting(true);
    try {
      const rows = await fetchMerchantMembersList(merchantId, "", true);
      // #919(SPECS-INDEX):多一欄「會員類型」,讓商家在 Excel 裡也分得出兩層狀態。
      // 🔴 CSV 裡寫**中文白話**(「已完成驗證」/「尚未驗證」),不寫時間戳、也不寫 true/false
      //    —— 這份檔案是給商家在 Excel 裡看的,不是給程式讀的。
      // 🔴 中文對應**不在這裡 inline 寫**,一律用會員模組匯出的 memberIdentityStatusLabel:
      //    名單頁(#918)、詳情頁(#920)、這份 CSV 三個地方的文案必須一致,分三份寫早晚會對不上
      //    (規格書 §三 #923.3 第 6 條也要求這段要能被 vitest 測到)。
      // 📌 資料來源沒變,還是同一支 fetchMerchantMembersList(…, unpaged=true);#918 在那支的
      //    select 裡多帶了 identity_verified_at,所以這裡直接就有值。
      const csv = buildCsvContent(
        ["姓名", "電話", "推薦碼", "點數餘額", "狀態", "會員類型"],
        rows.map((m) => [
          m.name,
          m.phone,
          m.referralCode,
          m.pointsBalance,
          m.status,
          memberIdentityStatusLabel(m.identityVerifiedAt),
        ]),
      );
      downloadCsv(`會員報表_${todayIso()}.csv`, csv);
      toast.success(`已匯出 ${rows.length} 筆會員`);
    } catch (err) {
      toast.error("匯出失敗", { description: getErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  async function handleExportCommission() {
    setExporting(true);
    try {
      const targets = (staffList ?? []).filter(
        (s) => commissionStaffId === "__all__" || s.id === commissionStaffId,
      );
      const allRows: Array<[string, string, string, string, number, string, number]> = [];
      for (const staff of targets) {
        try {
          const summary = await fetchStaffCommissionSummary(
            staff.id,
            commissionYear,
            commissionMonth,
          );
          for (const d of summary.details) {
            allRows.push([
              staff.name,
              d.booking_id,
              d.completion_date,
              d.customer_name,
              d.commission_base_amount,
              formatStaffCommissionItemBreakdown(d),
              d.commission_amount,
            ]);
          }
        } catch {
          // 沒有權限查詢某一位服務人員(理論上不會發生，同一個商家管理員/客服權限一致)或該服務
          // 人員本月無資料時跳過，不中斷整批匯出。
        }
      }
      const csv = buildCsvContent(
        [
          "服務人員",
          "訂單編號",
          // #781:#767 之後這一欄裝的是「按下完成的那一刻」,不是預約日期,標題要誠實。
          "完成日期",
          "客戶姓名",
          "抽成基準金額",
          "服務項目明細",
          "抽成金額",
        ],
        allRows,
      );
      downloadCsv(
        `抽成報表_${commissionYear}-${String(commissionMonth).padStart(2, "0")}.csv`,
        csv,
      );
      toast.success(`已匯出 ${allRows.length} 筆抽成明細`);
    } catch (err) {
      toast.error("匯出失敗", { description: getErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  async function handleExportLeave() {
    setExporting(true);
    try {
      const [rows, leaveTypes] = await Promise.all([
        fetchStaffLeaveRecords({
          staffId: leaveStaffId === "__all__" ? null : leaveStaffId,
          startDateFrom: leaveStartDate || null,
          startDateTo: leaveEndDate || null,
        }),
        fetchMerchantLeaveTypesAll(merchantId),
      ]);
      const staffNameById = new Map((staffList ?? []).map((s) => [s.id, s.name]));
      const leaveTypeNameById = new Map(leaveTypes.map((t) => [t.id, t.name]));
      const csv = buildCsvContent(
        ["服務人員", "假別", "開始日期", "結束日期", "狀態", "備註"],
        rows.map((r) => [
          staffNameById.get(r.staff_id) ?? r.staff_id,
          leaveTypeNameById.get(r.leave_type_id) ?? r.leave_type_id,
          r.start_date,
          r.end_date,
          r.status,
          r.notes,
        ]),
      );
      downloadCsv(`請假報表_${todayIso()}.csv`, csv);
      toast.success(`已匯出 ${rows.length} 筆請假紀錄`);
    } catch (err) {
      toast.error("匯出失敗", { description: getErrorMessage(err) });
    } finally {
      setExporting(false);
    }
  }

  /** 服務人員下拉的選項(全部 + 資料庫裡的每一位)。 */
  const staffOptions = [
    { value: "__all__", label: "全部服務人員" },
    ...(staffList ?? []).map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      {/* SPECS-INDEX #600(§10.1):固定導回「功能」主頁，跟資料匯入精靈/產業轉移精靈的
          「← 返回功能」行為一致。這個頁面不是多步驟精靈，沒有「上一步」按鈕需要區分。 */}
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="報表匯出中心"
        description="這裡是彙整入口，店家報表、服務人員報表頁面上原有的匯出按鈕依然可以使用，兩者資料來源相同。"
      />

      {/* 內容分頁列(每個分頁是一塊不同的內容、有自己的篩選欄位)⇒ variant="pages"。 */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ReportType)}>
        <UnderlineTabsList variant="pages">
          {REPORT_TABS.map((t) => (
            <UnderlineTabsTrigger key={t.key} value={t.key}>
              {t.label}
            </UnderlineTabsTrigger>
          ))}
        </UnderlineTabsList>
      </Tabs>

      {activeTab === "orders" && (
        <Card>
          <CardHeader>
            <CardTitle>訂單報表</CardTitle>
            <CardDescription>依日期區間+狀態篩選，匯出訂單清單。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="開始日期" htmlFor="report-order-start">
                <FieldDate
                  id="report-order-start"
                  value={orderStartDate}
                  onChange={(e) => setOrderStartDate(e.target.value)}
                />
              </FormField>
              <FormField label="結束日期" htmlFor="report-order-end">
                <FieldDate
                  id="report-order-end"
                  value={orderEndDate}
                  onChange={(e) => setOrderEndDate(e.target.value)}
                />
              </FormField>
              <FormField label="狀態" htmlFor="report-order-status">
                <FieldSelect
                  id="report-order-status"
                  value={orderStatus}
                  // 固定白名單 ⇒ 用最嚴格的那一種 guard 用法。
                  onValueChange={guardPhantomEmptyChange(setOrderStatus, (v) =>
                    ORDER_STATUS_OPTIONS.some((o) => o.value === v),
                  )}
                  options={ORDER_STATUS_OPTIONS}
                />
              </FormField>
            </div>
            {/* 這個分頁唯一的 ① 主要按鈕。 */}
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="self-start"
              disabled={exporting}
              onClick={() => void handleExportOrders()}
            >
              匯出 CSV
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === "members" && (
        <Card>
          <CardHeader>
            <CardTitle>會員報表</CardTitle>
            <CardDescription>無篩選，匯出全部會員。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="primary"
              size="touch"
              disabled={exporting}
              onClick={() => void handleExportMembers()}
            >
              匯出 CSV
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === "commission" && (
        <Card>
          <CardHeader>
            <CardTitle>抽成報表</CardTitle>
            <CardDescription>依年月+服務人員(可選全部)篩選。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="月份"
                htmlFor="report-commission-month"
                help="選一個月份,匯出那一個月所有已完成訂單的抽成明細。原本要分開填「年」跟「月」兩格,現在直接選一次就好。"
                helpLabel="說明:抽成報表的月份怎麼選"
              >
                <FieldMonth
                  id="report-commission-month"
                  value={toMonthValue(commissionYear, commissionMonth)}
                  onChange={(e) => handleCommissionMonthChange(e.target.value)}
                />
              </FormField>
              <FormField label="服務人員" htmlFor="report-commission-staff">
                <FieldSelect
                  id="report-commission-staff"
                  value={commissionStaffId}
                  // 選項來自資料庫(動態清單)⇒ 只擋空字串的那一種 guard 用法。
                  onValueChange={guardPhantomEmptyChange(setCommissionStaffId)}
                  options={staffOptions}
                />
              </FormField>
            </div>
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="self-start"
              disabled={exporting}
              onClick={() => void handleExportCommission()}
            >
              匯出 CSV
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === "leave" && (
        <Card>
          <CardHeader>
            <CardTitle>請假報表</CardTitle>
            <CardDescription>依日期區間+服務人員(可選全部)篩選。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="開始日期" htmlFor="report-leave-start">
                <FieldDate
                  id="report-leave-start"
                  value={leaveStartDate}
                  onChange={(e) => setLeaveStartDate(e.target.value)}
                />
              </FormField>
              <FormField label="結束日期" htmlFor="report-leave-end">
                <FieldDate
                  id="report-leave-end"
                  value={leaveEndDate}
                  onChange={(e) => setLeaveEndDate(e.target.value)}
                />
              </FormField>
              <FormField label="服務人員" htmlFor="report-leave-staff">
                <FieldSelect
                  id="report-leave-staff"
                  value={leaveStaffId}
                  onValueChange={guardPhantomEmptyChange(setLeaveStaffId)}
                  options={staffOptions}
                />
              </FormField>
            </div>
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="self-start"
              disabled={exporting}
              onClick={() => void handleExportLeave()}
            >
              匯出 CSV
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ReportExportCenterPage() {
  return (
    <RequireReportExportAccess>
      <ReportExportCenterPageInner />
    </RequireReportExportAccess>
  );
}
