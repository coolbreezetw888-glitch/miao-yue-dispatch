// 對應模組 7(排班與休假管理)規格書 §4.3:請假紀錄管理頁(新路由 /app/leave-records)。
// 清單:篩選服務人員(只列月薪制)+ 日期區間,顯示每筆請假紀錄的服務人員姓名、假別、日期區間、
// 備註、狀態(進行中/已結束/已取消,依日期跟 status 綜合判斷顯示文字)。
// 新增表單:選服務人員(只能選月薪制)、選假別、日期區間、備註,選完服務人員+日期區間後即時呼叫
// preview_staff_leave_conflicts,如果有衝突,顯示清單並要求勾選「我已知悉,仍要登記」才能送出
// (規則 2.6)。
// 取消按鈕:呼叫 cancel_staff_leave,取消前二次確認。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import { isoToTaipeiDateKey, isoToTaipeiTime } from "@/modules/booking/dateUtils";

import {
  cancelStaffLeave,
  createStaffLeave,
  previewStaffLeaveConflicts,
  useMerchantLeaveTypes,
  useStaffLeaveRecords,
} from "./context";
import { RequireTeamLeaveAccess } from "./RequireTeamLeaveAccess";
import {
  getLeaveRecordDisplayStatus,
  LEAVE_RECORD_DISPLAY_STATUS_LABELS,
  type StaffLeaveConflictBooking,
  type StaffLeaveRecord,
} from "./types";

const staffLeaveRecordsQueryKey = ["scheduling-module", "staff-leave-records"] as const;

// =========================================================================
// 新增請假表單(含規則 2.6 衝突預覽確認流程)
// =========================================================================
function CreateLeaveDialog({
  merchantId,
  trigger,
  onSaved,
}: {
  merchantId: string;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: staffList } = useMerchantStaffList(open ? merchantId : null);
  const { data: leaveTypes } = useMerchantLeaveTypes(open ? merchantId : null);

  const [staffId, setStaffId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const [conflicts, setConflicts] = useState<StaffLeaveConflictBooking[] | null>(null);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [confirmDespiteConflicts, setConfirmDespiteConflicts] = useState(false);
  const [saving, setSaving] = useState(false);

  const monthlySalaryStaff = useMemo(
    () => (staffList ?? []).filter((s) => s.compensation_type === "monthly_salary"),
    [staffList],
  );
  const pieceRateStaff = useMemo(
    () => (staffList ?? []).filter((s) => s.compensation_type !== "monthly_salary"),
    [staffList],
  );

  useEffect(() => {
    if (open) {
      setStaffId("");
      setLeaveTypeId("");
      setStartDate("");
      setEndDate("");
      setNotes("");
      setConflicts(null);
      setConfirmDespiteConflicts(false);
    }
  }, [open]);

  // 選完服務人員+日期區間後,即時查詢這段期間既有的預約衝突清單(規則 2.6 第 1 點)。
  useEffect(() => {
    setConflicts(null);
    setConfirmDespiteConflicts(false);
    if (!staffId || !startDate || !endDate || startDate > endDate) return;

    let active = true;
    setCheckingConflicts(true);
    previewStaffLeaveConflicts(staffId, startDate, endDate)
      .then((result) => {
        if (active) setConflicts(result);
      })
      .catch(() => {
        if (active) setConflicts(null);
      })
      .finally(() => {
        if (active) setCheckingConflicts(false);
      });
    return () => {
      active = false;
    };
  }, [staffId, startDate, endDate]);

  const hasConflicts = (conflicts?.length ?? 0) > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!staffId) {
      toast.error("請選擇服務人員");
      return;
    }
    if (!leaveTypeId) {
      toast.error("請選擇假別");
      return;
    }
    if (!startDate || !endDate) {
      toast.error("請選擇日期區間");
      return;
    }
    if (startDate > endDate) {
      toast.error("結束日期不能早於開始日期");
      return;
    }
    if (hasConflicts && !confirmDespiteConflicts) {
      toast.error("這段期間已經有既有預約,請先勾選「我已知悉,仍要登記」再送出");
      return;
    }

    setSaving(true);
    try {
      await createStaffLeave({
        staffId,
        leaveTypeId,
        startDate,
        endDate,
        notes: notes.trim() ? notes : null,
        confirmDespiteConflicts,
      });
      toast.success("已登記請假");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("登記失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>登記請假</DialogTitle>
          <DialogDescription>
            只有月薪制的服務人員可以登記請假紀錄,建立即生效(這次不做審核流程)。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>服務人員 *</Label>
            <Select value={staffId} onValueChange={setStaffId}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="請選擇服務人員" />
              </SelectTrigger>
              <SelectContent>
                {monthlySalaryStaff.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    目前沒有月薪制的服務人員
                  </div>
                ) : (
                  monthlySalaryStaff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))
                )}
                {pieceRateStaff.map((s) => (
                  <SelectItem key={s.id} value={s.id} disabled>
                    {s.name}(按件計酬,無法登記請假)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>假別 *</Label>
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="請選擇假別" />
              </SelectTrigger>
              <SelectContent>
                {(leaveTypes ?? []).length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    目前沒有可用的假別,請先到假別設定新增
                  </div>
                ) : (
                  (leaveTypes ?? []).map((lt) => (
                    <SelectItem key={lt.id} value={lt.id}>
                      {lt.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="leave-start-date">開始日期 *</Label>
              <input
                id="leave-start-date"
                type="date"
                className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="leave-end-date">結束日期 *</Label>
              <input
                id="leave-end-date"
                type="date"
                className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <Label htmlFor="leave-notes">備註</Label>
            <Textarea
              id="leave-notes"
              className="mt-2"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {checkingConflicts ? (
            <p className="text-xs text-muted-foreground">正在檢查這段期間的既有預約⋯</p>
          ) : hasConflicts ? (
            <div className="rounded-md border border-warn/50 bg-warn/10 p-3">
              <p className="text-sm font-medium text-warn">
                這段期間已經有 {conflicts!.length} 筆預約,系統不會自動處理,請確認後再登記:
              </p>
              <ul className="mt-2 space-y-1 text-xs text-warn">
                {conflicts!.map((c) => (
                  <li key={c.bookingId}>
                    {isoToTaipeiDateKey(c.startAt)} {isoToTaipeiTime(c.startAt)}-
                    {isoToTaipeiTime(c.endAt)} ・ {c.customerName}
                    {c.serviceItemNames.length > 0 ? ` ・ ${c.serviceItemNames.join("、")}` : ""}
                  </li>
                ))}
              </ul>
              <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={confirmDespiteConflicts}
                  onCheckedChange={(v) => setConfirmDespiteConflicts(v === true)}
                />
                我已知悉,仍要登記
              </label>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "登記中⋯" : "確認登記"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================================
// 主頁面
// =========================================================================
function LeaveRecordsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: staffList } = useMerchantStaffList(merchantId);
  const [filterStaffId, setFilterStaffId] = useState("__all__");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: records, isLoading } = useStaffLeaveRecords({
    staffId: filterStaffId === "__all__" ? null : filterStaffId,
    startDateFrom: dateFrom || null,
    startDateTo: dateTo || null,
  });

  // useStaffLeaveRecords 是唯讀依 staff_id 篩選的通用對外介面,這裡的清單只需要顯示「這間商家」
  // 的紀錄——staff_leave_records 本身沒有 merchant_id 欄位,靠 RLS(private.can_manage_team_leave
  // + staff_merchant_id)本來就只會回傳這間商家能看到的紀錄,不需要前端再過濾一次。
  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    (staffList ?? []).forEach((s) => map.set(s.id, s.name));
    return map;
  }, [staffList]);

  const todayDateKey = isoToTaipeiDateKey(new Date().toISOString());

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: staffLeaveRecordsQueryKey });
  }

  async function handleCancel(record: StaffLeaveRecord) {
    try {
      await cancelStaffLeave(record.id);
      await refetch();
      toast.success("已取消這筆請假紀錄");
    } catch (err) {
      toast.error("取消失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">請假紀錄</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            「{merchant!.name}」月薪制服務人員的請假登記
          </p>
        </div>
        <CreateLeaveDialog
          merchantId={merchantId}
          trigger={<Button variant="cta">登記請假</Button>}
          onSaved={refetch}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>篩選</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>服務人員</Label>
            <Select value={filterStaffId} onValueChange={setFilterStaffId}>
              <SelectTrigger className="mt-2">
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
          <div>
            <Label htmlFor="leave-filter-from">日期區間(起)</Label>
            <input
              id="leave-filter-from"
              type="date"
              className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="leave-filter-to">日期區間(訖)</Label>
            <input
              id="leave-filter-to"
              type="date"
              className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>紀錄清單</CardTitle>
          <CardDescription>依開始日期新到舊排序</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !records || records.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有符合篩選條件的請假紀錄。</p>
          ) : (
            <ul className="space-y-2">
              {records.map((record) => {
                const displayStatus = getLeaveRecordDisplayStatus(record, todayDateKey);
                return (
                  <li
                    key={record.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {staffNameById.get(record.staff_id) ?? "(服務人員)"} ・{" "}
                        {record.leave_type_name_snapshot}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {record.start_date} ~ {record.end_date}
                        {record.notes ? ` ・ ${record.notes}` : ""}
                      </p>
                      <div className="mt-1">
                        <Badge
                          variant={
                            displayStatus === "cancelled"
                              ? "secondary"
                              : displayStatus === "ongoing"
                                ? "default"
                                : "outline"
                          }
                        >
                          {LEAVE_RECORD_DISPLAY_STATUS_LABELS[displayStatus]}
                        </Badge>
                      </div>
                    </div>
                    {record.status === "confirmed" ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="shrink-0">
                            取消
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>確定要取消這筆請假紀錄嗎?</AlertDialogTitle>
                            <AlertDialogDescription>
                              取消後這位服務人員這段期間恢復正常排班,可以正常被預約。要改期或改假別,
                              取消後重新登記一筆新的即可。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>先不要</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleCancel(record)}>
                              確定取消
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function LeaveRecordsPage() {
  return (
    <RequireTeamLeaveAccess>
      <LeaveRecordsPageInner />
    </RequireTeamLeaveAccess>
  );
}
