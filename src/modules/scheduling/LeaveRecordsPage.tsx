// 對應模組 7(排班與休假管理)規格書 §4.3:請假紀錄管理頁(新路由 /app/leave-records)。
// 清單:篩選服務人員(只列月薪制)+ 日期區間,顯示每筆請假紀錄的服務人員姓名、假別、日期區間、
// 備註、狀態(進行中/已結束/已取消,依日期跟 status 綜合判斷顯示文字)。
// 新增表單:選服務人員(只能選月薪制)、選假別、日期區間、備註,選完服務人員+日期區間後即時呼叫
// preview_staff_leave_conflicts,如果有衝突,顯示清單並要求勾選「我已知悉,仍要登記」才能送出
// (規則 2.6)。
// 取消按鈕:呼叫 cancel_staff_leave,取消前二次確認。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 A5 / #18):
//   - 登記請假(約 6 欄)→ 全頁層殼(FullPageLayer),受控開關,底部「取消 / 確認登記」等寬;
//     欄位改 FormField / FieldSelect / FieldDate / FieldTextarea;「選單只列月薪制」那段說明改 `!` 常駐
//     (skill 二:「找不到某人」屬於「狀態跟使用者以為的不一樣」);衝突清單改 `!` 常駐區塊。
//   - 取消確認 → 小卡窗純確認殼(CardAlertDialog),受控開關(觸發點是 ListCard 的主要動作)。
//   - 紀錄列改 ListCard(狀態標籤:即將開始 / 進行中 = 綠、已結束 = 灰、已取消 = 紅;已取消整張變灰)。
//   - 篩選卡的欄位改 FormField / FieldSelect / FieldDate;頁首改 PageHeader、載入中改骨架、空狀態改 EmptyState。
// **只動外觀與版面,不動任何行為**:衝突預覽的時序、驗證、送出、取消照舊。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  EmptyState,
  ErrorState,
  FieldDate,
  FieldSelect,
  FieldTextarea,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  type StatusTone,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

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
  filterMonthlySalaryStaff,
  getLeaveRecordDisplayStatus,
  LEAVE_RECORD_DISPLAY_STATUS_LABELS,
  type LeaveRecordDisplayStatus,
  type StaffLeaveConflictBooking,
  type StaffLeaveRecord,
} from "./types";

const staffLeaveRecordsQueryKey = ["scheduling-module", "staff-leave-records"] as const;

/** skill 二之四 狀態標籤配色:正常 = 綠 / 結束 = 灰 / 出事 = 紅。「即將開始」「進行中」都是生效中的請假,
 *  同屬正常;「已取消」跟預約詳情的「已取消」一樣用紅系,跟「已結束」(灰)區分開。 */
const LEAVE_STATUS_TONE: Record<LeaveRecordDisplayStatus, StatusTone> = {
  upcoming: "success",
  ongoing: "success",
  ended: "neutral",
  cancelled: "danger",
};

const CREATE_LEAVE_FORM_ID = "create-leave-form";

// =========================================================================
// 新增請假表單(含規則 2.6 衝突預覽確認流程)
// =========================================================================
function CreateLeaveDialog({
  merchantId,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
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

  // 2026-09-24 使用者指定:下拉選單只列月薪制的人,抽成制的人完全不出現(原本是列出來但設成
  // disabled + 加註記)。過濾規則抽成純函式 filterMonthlySalaryStaff(見 types.ts 的說明)。
  const monthlySalaryStaff = useMemo(() => filterMonthlySalaryStaff(staffList), [staffList]);

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
        merchantId,
      });
      toast.success("已登記請假");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error("登記失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title="登記請假"
        subtitle="只有月薪制的服務人員可以登記請假紀錄,建立即生效(這次不做審核流程)。"
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={CREATE_LEAVE_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "登記中⋯" : "確認登記"}
            </Button>
          </ActionBar>
        }
      >
        <form id={CREATE_LEAVE_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FormField label="服務人員" htmlFor="leave-staff" required>
            <FieldSelect
              id="leave-staff"
              value={staffId}
              onValueChange={setStaffId}
              placeholder="請選擇服務人員"
              options={monthlySalaryStaff.map((s) => ({ value: s.id, label: s.name }))}
            >
              {monthlySalaryStaff.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  目前沒有月薪制的服務人員
                </div>
              ) : null}
            </FieldSelect>
          </FormField>
          {/* 2026-09-24 主腦裁決:選單裡抽成制的人是「整個不出現」(不是 disabled 灰掉),管理員要幫
              某位抽成制的人登記時會找不到那個人、卻不知道原因。刻意不把 disabled 選項加回來(選單
              會變長,而且抽成制本來就永遠不能登記),改在這裡把因果講清楚。
              ui-v1-full:這屬於 skill 二「現在的狀態跟使用者以為的不一樣」⇒ `!` 常駐,不收進 `?`
              (沒有人會為了「怎麼找不到某個人」去點問號)。 */}
          <AlertNote>
            這個選單只會列出月薪制的服務人員。找不到某位服務人員,表示他的計酬類型是抽成制——抽成制
            不需要登記請假,他不接單的時段由他本人在服務人員端的「休假設定」自己設定。
          </AlertNote>

          <FormField label="假別" htmlFor="leave-type" required>
            <FieldSelect
              id="leave-type"
              value={leaveTypeId}
              onValueChange={setLeaveTypeId}
              placeholder="請選擇假別"
              options={(leaveTypes ?? []).map((lt) => ({ value: lt.id, label: lt.name }))}
            >
              {(leaveTypes ?? []).length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  目前沒有可用的假別,請先到「月薪人員假別設定」新增
                </div>
              ) : null}
            </FieldSelect>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="開始日期" htmlFor="leave-start-date" required>
              <FieldDate
                id="leave-start-date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </FormField>
            <FormField label="結束日期" htmlFor="leave-end-date" required>
              <FieldDate
                id="leave-end-date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          <FormField label="備註" htmlFor="leave-notes">
            {/* 🔴 2026-09-30 QA:這裡原本寫 className="min-h-0",cn() 是 twMerge,會把共用元件的
                min-h-[88px] 直接蓋掉(不是「加上去」)。FieldTextarea 的註解要求 className 只用在
                版面寬度,不要改高度——全站備註欄同高才是對的,所以拿掉。 */}
            <FieldTextarea
              id="leave-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>

          {checkingConflicts ? (
            <p className="text-xs text-muted-foreground">正在檢查這段期間的既有預約⋯</p>
          ) : hasConflicts ? (
            // 規則 2.6:有衝突就一定要讓人看到並明確勾選,skill 二的 `!` 常駐區塊。
            <AlertNote>
              <p className="font-semibold">
                這段期間已經有 {conflicts!.length} 筆預約,系統不會自動處理,請確認後再登記:
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-xs tabular-nums">
                {conflicts!.map((c) => (
                  <li key={c.bookingId} className="break-words">
                    {isoToTaipeiDateKey(c.startAt)} {isoToTaipeiTime(c.startAt)}-
                    {isoToTaipeiTime(c.endAt)} ・ {c.customerName}
                    {c.serviceItemNames.length > 0 ? ` ・ ${c.serviceItemNames.join("、")}` : ""}
                  </li>
                ))}
              </ul>
              <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-semibold text-foreground">
                <Checkbox
                  checked={confirmDespiteConflicts}
                  onCheckedChange={(v) => setConfirmDespiteConflicts(v === true)}
                />
                我已知悉,仍要登記
              </label>
            </AlertNote>
          ) : null}
        </form>
      </FullPageLayerContent>
    </FullPageLayer>
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
  // 2026-09-24 使用者指定:上方篩選的服務人員下拉選單只列月薪制的人(抽成制的人根本不會有請假
  // 紀錄,列出來只是讓客服多看一堆永遠篩不出東西的選項)。同一條規則跟登記表單共用同一個純函式。
  const monthlySalaryStaff = useMemo(() => filterMonthlySalaryStaff(staffList), [staffList]);
  const [filterStaffId, setFilterStaffId] = useState("__all__");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // refetchRecords 是 react-query 自己的重抓(ErrorState 的「重試」用);下面那個 refetch() 是
  // 「取消 / 登記完之後讓清單失效」的既有函式,兩個不一樣,名字要分開。
  const {
    data: records,
    isLoading,
    isError,
    refetch: refetchRecords,
  } = useStaffLeaveRecords({
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

  const [createOpen, setCreateOpen] = useState(false);
  // 取消確認小卡窗(盤點 #18):受控開關,記住要取消哪一筆。
  const [cancellingRecord, setCancellingRecord] = useState<StaffLeaveRecord | null>(null);

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
      <PageHeader
        backTo="/app/manage"
        title="請假紀錄"
        description={`「${merchant!.name}」月薪制服務人員的請假登記`}
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            登記請假
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>月薪服務人員篩選</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <FormField label="服務人員" htmlFor="leave-filter-staff">
            {/* 「全部」的語意跟著下面的清單一起收斂成「全部月薪制服務人員」——清單裡已經只剩
                月薪制的人,如果這一項還寫「全部服務人員」會讓人以為抽成制的人也被算進來。
                ⚠️ 底層查詢條件不變:選這一項就是 staffId = null(不帶服務人員條件),
                   實際回傳範圍由 RLS 決定,而抽成制的人本來就不會有請假紀錄。 */}
            <FieldSelect
              id="leave-filter-staff"
              value={filterStaffId}
              onValueChange={setFilterStaffId}
              options={[
                { value: "__all__", label: "全部月薪制服務人員" },
                ...monthlySalaryStaff.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </FormField>
          <FormField label="日期區間(起)" htmlFor="leave-filter-from">
            <FieldDate
              id="leave-filter-from"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </FormField>
          <FormField label="日期區間(訖)" htmlFor="leave-filter-to">
            <FieldDate
              id="leave-filter-to"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>紀錄清單</CardTitle>
          <CardDescription>依開始日期新到舊排序</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : isError ? (
            // 🔴 2026-09-30 QA:原本查詢失敗會偽裝成「沒有符合篩選條件的紀錄」,客服會以為請假
            // 紀錄真的不存在,重複登記一次。skill 二之八 出錯。
            <ErrorState
              title="讀不到請假紀錄"
              reason="可能是網路斷了,或你沒有查看請假紀錄的權限"
              onRetry={() => void refetchRecords()}
            />
          ) : !records || records.length === 0 ? (
            // 下一步就在同一個畫面上(上方的篩選卡 + 頁首的「登記請假」),用一句話指路即可。
            <EmptyState
              title="沒有符合篩選條件的請假紀錄"
              description="可以調整上方的篩選條件,或用右上角「登記請假」新增一筆。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {records.map((record) => {
                const displayStatus = getLeaveRecordDisplayStatus(record, todayDateKey);
                return (
                  <li key={record.id}>
                    {/* skill 二之五:姓名・假別 + 狀態標籤 → 日期區間・備註 → 右側唯一動作「取消」。
                        這張卡沒有「編輯」(要改期或改假別是取消後重新登記),所以唯一的主要動作就是取消。 */}
                    <ListCard
                      title={`${staffNameById.get(record.staff_id) ?? "(服務人員)"} ・ ${record.leave_type_name_snapshot}`}
                      state={displayStatus === "cancelled" ? "inactive" : "default"}
                      tags={
                        <StatusTag tone={LEAVE_STATUS_TONE[displayStatus]}>
                          {LEAVE_RECORD_DISPLAY_STATUS_LABELS[displayStatus]}
                        </StatusTag>
                      }
                      meta={
                        <>
                          {record.start_date} ~ {record.end_date}
                          {record.notes ? ` ・ ${record.notes}` : ""}
                        </>
                      }
                      primaryAction={
                        record.status === "confirmed" ? (
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => setCancellingRecord(record)}
                          >
                            取消
                          </Button>
                        ) : undefined
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 小卡窗純確認(盤點 #18)。取消請假紀錄之後紀錄還在(狀態變已取消)、可以重新登記一筆,
          不是「真正刪除」那種不可逆動作 ⇒ 確認鈕用主要樣式,不用紅字(2026-09-29 主腦裁決:紅色只留給不可逆)。 */}
      <CardAlertDialog
        open={cancellingRecord !== null}
        onOpenChange={(open) => {
          if (!open) setCancellingRecord(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定要取消這筆請假紀錄嗎?</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              取消後這位服務人員這段期間恢復正常排班,可以正常被預約。要改期或改假別,
              取消後重新登記一筆新的即可。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>先不要</CardAlertDialogCancel>
            <CardAlertDialogAction
              onClick={() => {
                if (cancellingRecord) void handleCancel(cancellingRecord);
              }}
            >
              確定取消
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>

      <CreateLeaveDialog
        merchantId={merchantId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetch}
      />
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
