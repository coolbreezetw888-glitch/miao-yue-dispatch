// 對應規格書 4.4:我的休假設定頁(新路由 /app/my-availability)。完全比照既有商家管理員設定
// 服務人員可預約時段的既有 UI 模式(每週固定時段的星期幾 + 時段區間表單,單日例外的日期點選 +
// 開啟/關閉切換),但畫面上只操作「自己」的資料,不需要先選「哪位服務人員」。

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { DAY_OF_WEEK_LABELS } from "@/modules/booking/types";
// 這個元件已經從呼叫端直接拿到自己的 staff_id(見下方 MyAvailabilityPageInner),所以直接用
// 模組 5 對外介面 useStaffAvailabilityWindows(staffId),不要繞去用 5.2 的
// useMyAvailabilityWindows(merchantId)——那支是給「還沒解出 staffId、只知道 merchantId」的
// 呼叫端用的,兩個函式的參數語意不同,曾經在這裡誤用過(把 staffId 當 merchantId 傳進去,
// 導致實際上時段已經寫進資料庫,畫面卻永遠顯示「尚未設定任何可預約時段」),已用 Playwright
// e2e 測試抓到並修正。
import { useStaffAvailabilityWindows } from "@/modules/booking/context";

import {
  upsertMyAvailabilityWindow,
  deleteMyAvailabilityWindow,
  useActiveMyStaffRecord,
} from "./context";
import { DayOffTabsSection } from "./DayOffTabsSection";
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
        <CardDescription>
          這裡設定的是你自己願意接單的時段,完全沒有設定時這次還不可預約。
        </CardDescription>
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemove(w.id)}
                >
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

function MyAvailabilityPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);

  if (!staffRow) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      {/* 商家端調整批次(2026-09-22,#609):這個頁面現在是底部「休假設定」分頁籤直接可達的
          目的地,不再是「功能」卡片底下的子頁面,不需要「← 返回功能」連結
          (/app/manage 對服務人員角色而言已經沒有對應入口)。 */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">休假設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          這裡設定的是你自己願意接單的時段,只有按件計酬的服務人員才能使用這個功能。
        </p>
      </div>

      <WeeklyWindowsSection staffId={staffRow.id} />
      <DayOffTabsSection merchantId={merchantId} staffId={staffRow.id} />
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
