// 模組 12 §4.3:報表匯出中心(新路由 /app/reports)。
// 統一畫面選擇訂單/會員/抽成/請假四種報表類型跟篩選期間，一次操作完成 CSV 下載。這裡完全呼叫
// 各自來源模組已經暴露的對外介面，不新建任何查詢函式(模組獨立性，見規格書第一節判斷 13)。

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { buildCsvContent, downloadCsv } from "@/lib/csv";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { fetchMerchantBookings } from "@/modules/booking/api";
import { fetchMerchantMembersList } from "@/modules/members/api";
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
      const csv = buildCsvContent(
        ["姓名", "電話", "推薦碼", "點數餘額", "狀態"],
        rows.map((m) => [m.name, m.phone, m.referralCode, m.pointsBalance, m.status]),
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div>
        {/* SPECS-INDEX #600(§10.1):固定導回「功能」主頁，跟資料匯入精靈/產業轉移精靈的
            「← 返回功能」行為一致。這個頁面不是多步驟精靈，沒有「上一步」按鈕需要區分。 */}
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">報表匯出中心</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          這裡是彙整入口，模組本身(帳務報表、會員管理)頁面上原有的匯出按鈕依然可以使用，兩者資料
          來源相同。
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ReportType)}>
        <TabsList>
          {REPORT_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {activeTab === "orders" && (
        <Card>
          <CardHeader>
            <CardTitle>訂單報表</CardTitle>
            <CardDescription>依日期區間+狀態篩選，匯出訂單清單。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div>
                <Label className="text-xs">開始日期</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={orderStartDate}
                  onChange={(e) => setOrderStartDate(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">結束日期</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={orderEndDate}
                  onChange={(e) => setOrderEndDate(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">狀態</Label>
                <Select value={orderStatus} onValueChange={setOrderStatus}>
                  <SelectTrigger className="mt-1 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">全部狀態</SelectItem>
                    <SelectItem value="accepted">已接受</SelectItem>
                    <SelectItem value="completed">已完成</SelectItem>
                    <SelectItem value="cancelled">已取消</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button disabled={exporting} onClick={() => void handleExportOrders()}>
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
            <Button disabled={exporting} onClick={() => void handleExportMembers()}>
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
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div>
                <Label className="text-xs">年</Label>
                <Input
                  type="number"
                  className="mt-1 w-24"
                  value={commissionYear}
                  onChange={(e) => setCommissionYear(Number(e.target.value))}
                />
              </div>
              <div>
                <Label className="text-xs">月</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  className="mt-1 w-20"
                  value={commissionMonth}
                  onChange={(e) => setCommissionMonth(Number(e.target.value))}
                />
              </div>
              <div>
                <Label className="text-xs">服務人員</Label>
                <Select value={commissionStaffId} onValueChange={setCommissionStaffId}>
                  <SelectTrigger className="mt-1 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">全部服務人員</SelectItem>
                    {(staffList ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button disabled={exporting} onClick={() => void handleExportCommission()}>
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
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div>
                <Label className="text-xs">開始日期</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={leaveStartDate}
                  onChange={(e) => setLeaveStartDate(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">結束日期</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={leaveEndDate}
                  onChange={(e) => setLeaveEndDate(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">服務人員</Label>
                <Select value={leaveStaffId} onValueChange={setLeaveStaffId}>
                  <SelectTrigger className="mt-1 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">全部服務人員</SelectItem>
                    {(staffList ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button disabled={exporting} onClick={() => void handleExportLeave()}>
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
