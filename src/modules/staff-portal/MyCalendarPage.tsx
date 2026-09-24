// 對應規格書 4.3:服務人員自助行事曆(疊加在既有 src/modules/booking/CalendarPage.tsx 的
// role==='staff' 分支底下渲染)。月曆檢視 + 點開某一天看當天的預約明細清單(規則 2.5:含以
// 助手身份參與的預約;規則 2.6:依 show_member_info 決定要不要顯示會員專屬資訊)。
// 比起既有管理員/客服版本的行事曆(可以跨服務人員切換、建單、編輯),這裡刻意做成簡化版
// 唯讀檢視——服務人員這次的範圍只到「看得到自己的排程」,不包含建單/編輯(見規格書判斷 2)。

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import {
  addDays,
  buildMonthGrid,
  getTaipeiNow,
  isoToTaipeiDateKey,
  isoToTaipeiTime,
  startOfMonth,
  addMonths,
  toDateKey,
} from "@/modules/booking/dateUtils";

import { useActiveMyStaffRecord, useMyBookingSchedule, useMyStaffPermission } from "./context";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";
import { MyCalendarTimelineView } from "./MyCalendarTimelineView";
import type { MyBookingScheduleItem } from "./api";

// v2 §10.2.4:「卡片列表」/「時間軸格線」兩種檢視,預設卡片列表(維持 v1 既有行為不變,
// 新功能是選配的,不是取代)。
type CalendarViewMode = "list" | "timeline";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

// v2 §10.2.4:兩種檢視(卡片列表/時間軸格線)點擊任一筆預約都要能開啟同一個唯讀詳情彈窗
// (MyBookingDetailDialog),所以這裡新增 onClick,原本純展示用的 <li> 改成可點擊的 <button>,
// 卡片本身的呈現內容完全不變。
function BookingListItem({
  booking,
  showCustomerAddress,
  onClick,
}: {
  booking: MyBookingScheduleItem;
  /** 2026-09-24 使用者裁決(任務 2):商家目前的產業需要地址時才顯示客戶地址,見下方
   * MyCalendarPage 裡 showCustomerAddress 的完整說明。 */
  showCustomerAddress: boolean;
  onClick: () => void;
}) {
  // 2026-09-24 深夜巡檢問題 5:原本這裡用 toLocaleTimeString 但**沒有帶 timeZone**,顯示的是
  // 「瀏覽器本機時區」的時間。服務人員的手機/瀏覽器時區不是 UTC+8 時(出國、手機自動時區抓錯、
  // 境外機器)時間會顯示錯誤,而且同一頁切到「時間軸格線」檢視時
  // (MyCalendarTimelineView.tsx 用的是正確的 isoToTaipeiTime),同一筆預約會出現兩種時間。
  // dateUtils.ts 檔頭已明講「不依賴瀏覽器本機時區」,這裡改用它提供的 isoToTaipeiTime。
  const startTime = isoToTaipeiTime(booking.start_at);
  const endTime = isoToTaipeiTime(booking.end_at);

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:border-brand hover:bg-brand-soft/40"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {startTime} - {endTime}
          </p>
          <div className="flex gap-1.5">
            <Badge variant={booking.role_in_booking === "primary" ? "default" : "secondary"}>
              {booking.role_in_booking === "primary" ? "主要服務人員" : "協助"}
            </Badge>
            {booking.is_member ? <Badge variant="outline">會員</Badge> : null}
          </div>
        </div>
        <p className="mt-1 text-sm text-foreground">
          {booking.customer_name}
          {booking.customer_phone ? `・${booking.customer_phone}` : ""}
        </p>
        {/* 任務 2:商家切成「到店服務」之後,服務人員的手機上也不該再看到客戶住家地址,所以條件是
            「商家目前的產業需要地址」且「這筆預約真的有地址值」,不是只看有沒有值。 */}
        {showCustomerAddress && booking.customer_address ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{booking.customer_address}</p>
        ) : null}
        {booking.service_item_names.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            服務項目:{booking.service_item_names.join("、")}
          </p>
        ) : null}
        {booking.notes ? (
          <p className="mt-1 text-xs text-muted-foreground">內部備註:{booking.notes}</p>
        ) : null}
        {booking.customer_notes ? (
          <p className="mt-1 text-xs text-muted-foreground">客戶備註:{booking.customer_notes}</p>
        ) : null}
        {booking.is_member ? (
          <p className="mt-1 text-xs text-muted-foreground">
            會員{booking.member_name ? `:${booking.member_name}` : ""}
            {booking.member_points_balance != null
              ? `(目前點數 ${booking.member_points_balance})`
              : ""}
          </p>
        ) : null}
        {booking.final_amount_snapshot != null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            金額:{booking.final_amount_snapshot} 元
          </p>
        ) : null}
      </button>
    </li>
  );
}

export default function MyCalendarPage() {
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: hasCalendarAccess, isLoading: permissionLoading } =
    useMyStaffPermission("staff_calendar_view");
  const { data: staffRow, isLoading: staffLoading } = useActiveMyStaffRecord(merchantId);

  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(getTaipeiNow()));
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() => toDateKey(getTaipeiNow()));
  // v2 §10.2.4:「卡片列表」/「時間軸格線」切換,預設卡片列表(維持 v1 既有行為)。
  const [viewMode, setViewMode] = useState<CalendarViewMode>("list");
  // v2 §10.2.4:兩種檢視共用同一份 state 管理目前選中要看詳情的預約,不要兩套獨立的彈窗邏輯。
  const [detailBookingId, setDetailBookingId] = useState<string | null>(null);

  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const rangeStartKey = toDateKey(monthGrid[0]!.date);
  const rangeEndKey = toDateKey(monthGrid[monthGrid.length - 1]!.date);

  const {
    data: schedule,
    isLoading: scheduleLoading,
    error,
  } = useMyBookingSchedule(merchantId, rangeStartKey, rangeEndKey);

  const bookingsByDate = useMemo(() => {
    const map = new Map<string, MyBookingScheduleItem[]>();
    for (const b of schedule ?? []) {
      // 問題 5:原本是 toDateKey(new Date(b.start_at)),toDateKey 讀的是 Date 的**本機**年月日,
      // 所以瀏覽器時區不是 UTC+8 時,跨日的預約(例如台北時間 00:30)會被歸到前一天的格子,
      // 當天列表變成「這一天沒有預約」。月曆格線那邊的 dateKey 是用 getTaipeiNow() 推出來的
      // 台北日曆日,兩邊必須用同一套基準才對得起來,所以這裡改用 isoToTaipeiDateKey。
      const key = isoToTaipeiDateKey(b.start_at);
      const list = map.get(key) ?? [];
      list.push(b);
      map.set(key, list);
    }
    return map;
  }, [schedule]);

  // 2026-09-24 深夜巡檢問題 6:原本這裡只等 permissionLoading。權限查詢(useMyStaffPermission)
  // 內部要先解出自己的 staff_id 才問得到答案,staff_id 還沒解出來的那段時間,權限查詢等於沒有
  // 答案,但 isLoading 已經是 false ——於是一位權限完全正常的服務人員,用網路較慢的手機點「行事
  // 曆」分頁籤,會先閃出一次「尚未開放此功能,請洽商家管理員開通…」,等 staff_id 解出來才恢復
  // 正常。這裡把 useActiveMyStaffRecord 的載入狀態(以及它依賴的 merchant 載入狀態)一起算進
  // loading,寫法直接比照同資料夾已經正確的 RequireStaffAvailabilityAccess.tsx,保持一致。
  if (merchantLoading || staffLoading || permissionLoading) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }

  if (hasCalendarAccess !== true) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「行事曆檢視」權限。
        </CardContent>
      </Card>
    );
  }

  const selectedDayBookings = bookingsByDate.get(selectedDateKey) ?? [];
  const detailBooking = (schedule ?? []).find((b) => b.id === detailBookingId) ?? null;

  // 2026-09-24 使用者裁決(任務 2):商家從「到府派工」切成「到店服務」之後,既有訂單的客戶地址
  // 要隱藏——包含服務人員端這兩處(當天預約清單的卡片、唯讀詳情彈窗)。判斷用商家**目前**的
  // 產業設定(industry_type 現在可以隨時切換,見 modules/merchant/api.ts 2026-09-23 的說明),
  // 不是只看「這筆預約有沒有地址值」,否則到府派工時期建立的舊預約,切成到店服務之後客戶的住家
  // 地址還是會出現在師傅的手機上。
  //
  // 服務人員端拿得到 industry_type:merchants_select 這條 RLS 政策已經疊加
  // private.is_merchant_staff(id)(見 supabase/migrations/20260921100200_staff_portal_
  // merchants_and_staff_select_overlay.sql §3.2),而 fetchAccessibleMerchants() 是
  // select("*"),所以這裡 useCurrentMerchant() 拿到的商家資料本來就含 industry_type,
  // 不需要新開任何查詢。merchant 還沒載入完(null)時一律當成「不顯示」,寧可少顯示也不要
  // 在切成到店服務的商家那邊閃出一次地址。
  //
  // 刻意只改顯示不動資料:資料庫裡的地址值完全保留,商家切回「到府派工」時舊預約的地址會重新
  // 顯示出來——這是預期中的正確行為(使用者要的是「隱藏」,不是刪除)。
  const showCustomerAddress =
    merchant !== null &&
    INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[merchant.industry_type as IndustryType] === true;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonthAnchor((prev) => addMonths(prev, -1))}
        >
          ← 上個月
        </Button>
        <p className="text-sm font-semibold text-foreground">
          {monthAnchor.getFullYear()} 年 {monthAnchor.getMonth() + 1} 月
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMonthAnchor((prev) => addMonths(prev, 1))}
        >
          下個月 →
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">載入失敗:{getErrorMessage(error)}</p>
      ) : (
        <div className="grid grid-cols-7 gap-1 text-center text-xs">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="py-1 text-muted-foreground">
              {label}
            </div>
          ))}
          {monthGrid.map(({ date, inCurrentMonth }) => {
            const dateKey = toDateKey(date);
            const count = bookingsByDate.get(dateKey)?.length ?? 0;
            const isSelected = dateKey === selectedDateKey;
            return (
              <button
                key={dateKey}
                type="button"
                onClick={() => setSelectedDateKey(dateKey)}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-md border text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-foreground hover:bg-muted"
                } ${inCurrentMonth ? "" : "opacity-40"}`}
              >
                <span>{date.getDate()}</span>
                {count > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{selectedDateKey} 的預約</CardTitle>
          {/* v2 §10.2.4:「卡片列表」/「時間軸格線」切換開關。 */}
          <div className="flex rounded-md border border-border p-0.5">
            <Button
              type="button"
              size="sm"
              variant={viewMode === "list" ? "default" : "ghost"}
              onClick={() => setViewMode("list")}
            >
              卡片列表
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === "timeline" ? "default" : "ghost"}
              onClick={() => setViewMode("timeline")}
            >
              時間軸格線
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {scheduleLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : viewMode === "timeline" ? (
            <MyCalendarTimelineView
              staffId={staffRow?.id ?? null}
              selectedDateKey={selectedDateKey}
              bookings={selectedDayBookings}
              onSelectBooking={setDetailBookingId}
            />
          ) : selectedDayBookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">這一天沒有預約。</p>
          ) : (
            <ul className="space-y-2">
              {selectedDayBookings
                .slice()
                .sort((a, b) => a.start_at.localeCompare(b.start_at))
                .map((booking) => (
                  <BookingListItem
                    key={`${booking.id}-${booking.role_in_booking}`}
                    booking={booking}
                    showCustomerAddress={showCustomerAddress}
                    onClick={() => setDetailBookingId(booking.id)}
                  />
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MyBookingDetailDialog
        booking={detailBooking}
        showCustomerAddress={showCustomerAddress}
        open={detailBookingId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailBookingId(null);
        }}
      />
    </div>
  );
}
