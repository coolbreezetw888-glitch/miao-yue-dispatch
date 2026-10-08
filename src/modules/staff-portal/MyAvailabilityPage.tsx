// 對應規格書 4.4:我的休假設定頁(新路由 /app/my-availability)。完全比照既有商家管理員設定
// 服務人員可預約時段的既有 UI 模式(每週固定時段的星期幾 + 時段區間表單,單日例外的日期點選 +
// 開啟/關閉切換),但畫面上只操作「自己」的資料,不需要先選「哪位服務人員」。

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { GuardLoading, LoadingSkeleton } from "@/components/patterns";
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
import { AvailabilityWindowEditList } from "@/modules/booking/AvailabilityWindowEditList";
import { validateNewAvailabilityWindow } from "@/modules/booking/availabilityWindowEdit";

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
    // 第 22 批(主腦裁決):新增也檢查「同一天不能重疊」,訊息跟直接調時間一字不差(資料庫也擋)。
    const problem = validateNewAvailabilityWindow(
      windows ?? [],
      Number(dayOfWeek),
      startTime,
      endTime,
    );
    if (problem) {
      toast.error(problem);
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
          這裡設定的是你自己願意接單的時段，完全沒有設定時這次還不可預約。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
          <LoadingSkeleton variant="lines" rows={3} />
        ) : !windows || windows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
            尚未設定任何可預約時段
          </p>
        ) : (
          // #1024 第 22 批:每一組可以直接調開始 / 結束時間(跟商家端編輯服務人員共用同一份清單元件)。
          // 這裡是一般頁面(不是視窗),沒有 Esc / 空白條,所以不用接 onDirtyChange。
          <AvailabilityWindowEditList
            windows={windows}
            onChanged={refetch}
            onRemove={(windowId) => void handleRemove(windowId)}
          />
        )}

        {/* 🔴 這三個原生控制項的字級一定是「手機 16px / 桌機 text-sm」,**不可以改回單一 text-sm**
            (SPECS-INDEX #869,2026-09-30 使用者回報)。iOS Safari 只要可輸入的控制項字級 < 16px,
            聚焦時就會自動把整頁放大、左右兩側被切掉。這一頁的 select / time 是手寫的原生控制項,
            沒有走 components/patterns/FormField.tsx,所以不會被那邊的共用修法涵蓋,要各自寫。
            Tailwind 是 mobile-first ⇒ `text-[16px] md:text-sm` = 手機 16px、≥768px 桌機仍是 14px,
            **桌機外觀完全不變**(py-1.5 也沒動,高度不變)。
            ❌ 不要改用在 index.html 的 viewport 鎖縮放,那會連使用者自己想放大看都被擋掉。
            📌 這一頁整體換成 FieldNativeSelect / FieldTime 的 ui-pattern 對齊是另一列需求,
               這次**只補字級、不做改版**。 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[16px] md:text-sm"
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
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[16px] md:text-sm"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">至</span>
          <input
            type="time"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[16px] md:text-sm"
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
    // skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。這裡等的是整頁的前提資料
    // (自己的服務人員紀錄),後面接的是一整頁,所以用守衛共用的那支。
    return <GuardLoading />;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      {/* 商家端調整批次(2026-09-22,#609):這個頁面現在是底部「休假設定」分頁籤直接可達的
          目的地,不再是「功能」卡片底下的子頁面,不需要「← 返回功能」連結
          (/app/manage 對服務人員角色而言已經沒有對應入口)。 */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">休假設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          這裡設定的是你自己願意接單的時段，只有抽成制的服務人員才能使用這個功能。
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
