// 對應模組 7(排班與休假管理)規格書 §4.4:排班一覽頁(新路由 /app/scheduling)。
// 本模組唯一的「跨服務人員總覽」畫面,語意上補齊模組 5 行事曆頁「一次只能看一位服務人員在一天的
// 細節」的空缺。週日期列(比照 CalendarPage.tsx 既有的週切換 UX)+ 表格式呈現(橫向日期、縱向
// 服務人員),點擊儲存格連結跳轉到行事曆頁面對應日期。
//
// ui-v1-full 第二階段第 2 批(2026-09-29):這一頁沒有彈窗。
//   - 頁首改 PageHeader、週切換按鈕改次要樣式、載入中改骨架、空狀態補「前往服務人員管理」。
//   - 這張「服務人員 × 7 天」的格子**保留表格**:它不是資料清單(skill 一「列表一律卡片式」針對的是一筆一筆
//     的資料),而是跟行事曆同性質的「時間格線」,套用的是 skill 六:服務人員名稱欄固定在左邊、放不下橫向
//     捲、右緣漸層陰影暗示還有內容。已在交付回報中列出,由主腦確認這個歸類。
// **只動外觀與版面,不動任何行為**。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageHeader,
  useHorizontalScrollHint,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { addDays, getTaipeiNow, startOfWeek, toDateKey } from "@/modules/booking/dateUtils";

import { useStaffScheduleOverview } from "./context";
import { RequireSchedulingAccess } from "./RequireSchedulingAccess";
import { describeScheduleCell, type ScheduleCellTone } from "./types";

const CELL_TONE_CLASSES: Record<ScheduleCellTone, string> = {
  leave: "bg-muted text-muted-foreground",
  closed: "bg-destructive-soft text-destructive-strong",
  unset: "bg-muted/40 text-muted-foreground",
  normal: "bg-brand-soft/40 text-foreground hover:bg-brand-soft/70",
};

function SchedulingOverviewPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(getTaipeiNow()));
  const weekDays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)),
    [weekStart],
  );
  const startDateKey = toDateKey(weekStart);
  const endDateKey = toDateKey(addDays(weekStart, 6));

  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useStaffScheduleOverview(merchantId, startDateKey, endDateKey);

  // 右緣漸層只在真的還能往右捲時顯示(skill 六;2026-09-30 QA:原本永遠顯示,擋住最右 24px)。
  const scrollHint = useHorizontalScrollHint();

  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="排班一覽"
        description={`「${merchant!.name}」跨服務人員的每週時段/單日例外/請假彙整總覽`}
      />

      {/* 週切換:三顆都是次要動作(這一頁沒有「主要」動作),手機上三顆等分一列。
          🔴 2026-09-30 QA:size 從 "card"(36px)改成 "touch"(44px)——skill 二之三 的 36px 是
          「卡片內的小按鈕」,這三顆不在卡片裡,是頁面層級的操作,要 44px 觸控目標。 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
          <Button
            type="button"
            variant="neutral"
            size="touch"
            onClick={() => setWeekStart((d) => addDays(d, -7))}
          >
            上一週
          </Button>
          <Button
            type="button"
            variant="neutral"
            size="touch"
            onClick={() => setWeekStart(startOfWeek(getTaipeiNow()))}
          >
            本週
          </Button>
          <Button
            type="button"
            variant="neutral"
            size="touch"
            onClick={() => setWeekStart((d) => addDays(d, 7))}
          >
            下一週
          </Button>
        </div>
        <p className="text-sm tabular-nums text-muted-foreground">
          {startDateKey} ~ {endDateKey}
        </p>
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="lines" rows={5} />
      ) : isError ? (
        // 🔴 2026-09-30 QA:原本查詢失敗會偽裝成「目前沒有在職的服務人員」,商家會以為人都不見了。
        <ErrorState
          title="讀不到排班一覽"
          reason="可能是網路斷了,或你沒有查看排班的權限"
          onRetry={() => void refetch()}
        />
      ) : !overview || overview.staff.length === 0 ? (
        <EmptyState
          title="目前沒有在職的服務人員"
          description="新增服務人員並設定可預約時段後,這裡會列出每個人一週的排班狀況。"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app/staff">前往服務人員管理</Link>
            </Button>
          }
        />
      ) : (
        // skill 六:放不下橫向捲、名稱欄固定在左邊(sticky)、右緣漸層陰影暗示還有內容。
        <div className="relative">
          <div ref={scrollHint.attach} className="overflow-x-auto rounded-md border border-border">
            {/* 🔴 2026-09-30 QA 實測:表格的 min-w 原本是 720px,但七個日期欄各自 min-w-[120px]
                (= 840px)已經超過它,auto table layout 於是把沒有下限保護的服務人員名稱欄一路壓到
                **30.5px**(扣掉 p-2 只剩 14.5px = 一個中文字),名字直排 13 行、連表頭「服務人員」
                四個字都直排——skill 二之六 明文禁止的失敗模式。
                修法:把表格的 min-w 提高到「名稱欄 + 七天」的實際總和(112 + 7×120 = 952px),
                名稱欄自己也給 min-w-[112px](扣掉內距還有 96px,放得下 6 個中文字)。
                w-32(128px)留著當「螢幕寬的時候用這個寬度」的偏好值,min-w-[112px] 是窄螢幕的下限。
                真瀏覽器實測(2026-09-30,headless chromium):
                  舊:320/390 都是 30.5px(內容寬 14.5px)、列高 93px(名字直排三行);1280 才 128px
                  新:320/390 = 112px(內容寬 96px)、列高 36px(一行);1280 = 128px */}
            <table className="w-full min-w-[952px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="sticky left-0 z-10 w-32 min-w-[112px] border-r border-border bg-surface p-2 text-left font-medium text-foreground">
                    服務人員
                  </th>
                  {weekDays.map((d, i) => (
                    <th
                      key={toDateKey(d)}
                      className="min-w-[120px] border-r border-border p-2 text-center font-medium tabular-nums text-foreground last:border-r-0"
                    >
                      {d.getMonth() + 1}/{d.getDate()}({weekdayLabels[i]})
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overview.staff.map((staffBlock) => (
                  <tr key={staffBlock.staff_id} className="border-b border-border last:border-b-0">
                    <td className="sticky left-0 z-10 w-32 min-w-[112px] border-r border-border bg-background p-2 align-top font-medium text-foreground">
                      <span className="break-words">{staffBlock.staff_name}</span>
                    </td>
                    {staffBlock.days.map((day) => {
                      const { tone, label } = describeScheduleCell(
                        day,
                        staffBlock.no_time_slot_limit,
                      );
                      return (
                        <td
                          key={day.date}
                          className="border-r border-border p-0 align-top last:border-r-0"
                        >
                          <Link
                            to={`/app/calendar?date=${day.date}`}
                            className={cn(
                              "block h-full min-h-[56px] px-2 py-2 text-xs leading-snug transition-colors",
                              CELL_TONE_CLASSES[tone],
                            )}
                          >
                            {label}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 🔴 2026-09-30 QA:漸層原本永遠顯示,螢幕夠寬(或已經捲到最右端)時也把最右 24px 蓋住。
              漸層的語意是「這個方向還有內容」⇒ 只有真的還能往右捲才顯示。 */}
          {scrollHint.canScrollRight ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-md bg-gradient-to-l from-background/90 to-transparent"
            />
          ) : null}
        </div>
      )}
    </main>
  );
}

export default function SchedulingOverviewPage() {
  return (
    <RequireSchedulingAccess>
      <SchedulingOverviewPageInner />
    </RequireSchedulingAccess>
  );
}
