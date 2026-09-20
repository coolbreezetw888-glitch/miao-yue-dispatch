// 對應規格書 4.4:我的休假設定頁(新路由 /app/my-availability)。完全比照既有商家管理員設定
// 服務人員可預約時段的既有 UI 模式(每週固定時段的星期幾 + 時段區間表單,單日例外的日期點選 +
// 開啟/關閉切換),但畫面上只操作「自己」的資料,不需要先選「哪位服務人員」。

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { DAY_OF_WEEK_LABELS } from "@/modules/booking/types";
import { toDateKey, getTaipeiNow, addMonths, startOfMonth } from "@/modules/booking/dateUtils";
// 這個元件已經從呼叫端直接拿到自己的 staff_id(見下方 MyAvailabilityPageInner),所以直接用
// 模組 5 對外介面 useStaffAvailabilityWindows(staffId),不要繞去用 5.2 的
// useMyAvailabilityWindows(merchantId)——那支是給「還沒解出 staffId、只知道 merchantId」的
// 呼叫端用的,兩個函式的參數語意不同,曾經在這裡誤用過(把 staffId 當 merchantId 傳進去,
// 導致實際上時段已經寫進資料庫,畫面卻永遠顯示「尚未設定任何可預約時段」),已用 Playwright
// e2e 測試抓到並修正。
import { useStaffAvailabilityWindows } from "@/modules/booking/context";

import {
  clearMyDayOverride,
  deleteMyAvailabilityWindow,
  setMyDayOverride,
  upsertMyAvailabilityWindow,
  useActiveMyStaffRecord,
  useMyAvailabilityOverrides,
} from "./context";
import { RequireStaffAvailabilityAccess } from "./RequireStaffAvailabilityAccess";

function WeeklyWindowsSection({ staffId }: { staffId: string }) {
  const { data: windows, isLoading } = useStaffAvailabilityWindows(staffId);
  const queryClient = useQueryClient();

  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [saving, setSaving] = useState(false);

  function refetch() {
    return queryClient.invalidateQueries({
      queryKey: ["booking-module", "staff-availability-windows", staffId],
    });
  }

  async function handleAdd() {
    if (startTime >= endTime) {
      toast.error("開始時間必須早於結束時間");
      return;
    }
    setSaving(true);
    try {
      await upsertMyAvailabilityWindow(staffId, {
        dayOfWeek: Number(dayOfWeek),
        startTime,
        endTime,
      });
      await refetch();
      toast.success("已新增可預約時段");
    } catch (err) {
      toast.error("新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(windowId: string) {
    try {
      await deleteMyAvailabilityWindow(windowId);
      await refetch();
      toast.success("已刪除這組時段");
    } catch (err) {
      toast.error("刪除失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>每週固定可預約時段</CardTitle>
        <CardDescription>這裡設定的是你自己願意接單的時段,完全沒有設定時這次還不可預約。</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : !windows || windows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
            尚未設定任何可預約時段
          </p>
        ) : (
          <ul className="space-y-1.5">
            {windows.map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
              >
                <span>
                  星期{DAY_OF_WEEK_LABELS[w.day_of_week]} {w.start_time.slice(0, 5)} -{" "}
                  {w.end_time.slice(0, 5)}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => handleRemove(w.id)}>
                  刪除
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(e.target.value)}
          >
            {DAY_OF_WEEK_LABELS.map((label, index) => (
              <option key={label} value={index}>
                星期{label}
              </option>
            ))}
          </select>
          <input
            type="time"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">至</span>
          <input
            type="time"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={handleAdd}>
            新增時段
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DayOverrideSection({
  merchantId,
  staffId,
}: {
  merchantId: string;
  staffId: string;
}) {
  const [monthAnchor] = useState(() => startOfMonth(getTaipeiNow()));
  const rangeStart = toDateKey(monthAnchor);
  const rangeEnd = toDateKey(addMonths(monthAnchor, 2));

  const { data: overrides, isLoading } = useMyAvailabilityOverrides(
    merchantId,
    rangeStart,
    rangeEnd,
  );
  const queryClient = useQueryClient();

  const [date, setDate] = useState(() => toDateKey(getTaipeiNow()));
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [mode, setMode] = useState<"open" | "closed">("closed");
  const [saving, setSaving] = useState(false);

  function refetch() {
    return queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-availability-overrides"],
    });
  }

  async function handleSetOverride() {
    if (startTime >= endTime) {
      toast.error("開始時間必須早於結束時間");
      return;
    }
    setSaving(true);
    try {
      const conflictCount = await setMyDayOverride(
        staffId,
        date,
        startTime,
        endTime,
        mode === "open",
      );
      await refetch();
      if (mode === "closed" && conflictCount > 0) {
        toast.success("已設定為休假", {
          description: `這段時間你已經有 ${conflictCount} 筆預約,系統不會自動取消,請自行確認。`,
        });
      } else {
        toast.success(mode === "open" ? "已標記為可預約" : "已設定為休假");
      }
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearOverride() {
    setSaving(true);
    try {
      await clearMyDayOverride(staffId, date, startTime, endTime);
      await refetch();
      toast.success("已清除這段時間的單日例外,回歸每週固定時段");
    } catch (err) {
      toast.error("清除失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  // 把同一天連續、同狀態的半小時格子合併顯示,不逐格列出。
  const groupedByDate = new Map<string, { start: string; end: string; isAvailable: boolean }[]>();
  for (const o of overrides ?? []) {
    const list = groupedByDate.get(o.override_date) ?? [];
    const last = list[list.length - 1];
    if (last && last.isAvailable === o.is_available && last.end === o.slot_start_time) {
      const [h, m] = o.slot_start_time.split(":").map(Number);
      const totalMinutes = h! * 60 + m! + 30;
      last.end = `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(
        totalMinutes % 60,
      ).padStart(2, "0")}`;
    } else {
      list.push({ start: o.slot_start_time, end: o.slot_start_time, isAvailable: o.is_available });
      const [h, m] = o.slot_start_time.split(":").map(Number);
      const totalMinutes = h! * 60 + m! + 30;
      list[list.length - 1]!.end = `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(
        totalMinutes % 60,
      ).padStart(2, "0")}`;
    }
    groupedByDate.set(o.override_date, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>單日臨時休假/開放</CardTitle>
        <CardDescription>
          針對特定日期臨時關閉(休假)或額外開放某段時間,不影響每週固定時段的長期設定。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : groupedByDate.size === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
            未來兩個月內沒有任何單日例外設定
          </p>
        ) : (
          <ul className="space-y-1.5">
            {Array.from(groupedByDate.entries()).map(([d, ranges]) =>
              ranges.map((r, idx) => (
                <li
                  key={`${d}-${idx}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
                >
                  <span>
                    {d} {r.start}-{r.end}
                  </span>
                  <span
                    className={r.isAvailable ? "text-sm text-foreground" : "text-sm text-destructive"}
                  >
                    {r.isAvailable ? "額外開放" : "休假"}
                  </span>
                </li>
              )),
            )}
          </ul>
        )}

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="override-date" className="text-xs">
              日期
            </Label>
            <Input
              id="override-date"
              type="date"
              className="w-40"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <input
              type="time"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">至</span>
            <input
              type="time"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
          <RadioGroup
            className="flex gap-6"
            value={mode}
            onValueChange={(v) => setMode(v as "open" | "closed")}
          >
            <label className="flex items-center gap-2 text-sm text-foreground">
              <RadioGroupItem value="closed" id="override-mode-closed" />
              設為休假(關閉)
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <RadioGroupItem value="open" id="override-mode-open" />
              額外開放
            </label>
          </RadioGroup>
          <div className="flex gap-2">
            <Button type="button" disabled={saving} onClick={handleSetOverride}>
              套用設定
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={handleClearOverride}>
              清除這段時間的例外
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MyAvailabilityPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);

  if (!staffRow) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">我的休假設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          這裡設定的是你自己願意接單的時段,只有按件計酬的服務人員才能使用這個功能。
        </p>
      </div>

      <WeeklyWindowsSection staffId={staffRow.id} />
      <DayOverrideSection merchantId={merchantId} staffId={staffRow.id} />
    </main>
  );
}

export default function MyAvailabilityPage() {
  return (
    <RequireStaffAvailabilityAccess>
      <MyAvailabilityPageInner />
    </RequireStaffAvailabilityAccess>
  );
}
