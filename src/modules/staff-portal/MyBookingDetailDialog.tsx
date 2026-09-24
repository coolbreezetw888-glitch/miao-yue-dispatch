// 對應規格書 v2 §10.2.2:服務人員自助行事曆的唯讀預約詳情彈窗。
//
// 不複用商家端 BookingDetailDialog.tsx——那顆內部會呼叫 getBooking(bookingId),讀的是
// bookings 表本身(受 bookings_select RLS 保護)。v1 判斷 7/一之二節表格已經明講「刻意不修改
// bookings_select」,服務人員完全沒有這張表的直接讀取權限,如果讓服務人員視角開啟那顆彈窗,
// getBooking() 會直接被 RLS 擋下、顯示「載入失敗」(詳見規格書 10.0 第 1 點)。
//
// 這裡改成直接接受呼叫端已經拿到手的 MyBookingScheduleItem(get_my_booking_schedule 的回傳形狀)
// 當 prop,不重新查詢,開啟即顯示,不會有載入中狀態。Footer 只有一個「關閉」按鈕,不渲染任何
// 確認/完成/編輯/取消/相關訂單按鈕——服務人員這次的自助功能是唯讀查看,不包含操作訂單
// (v1 判斷 2、規則 2.3)。

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { BOOKING_STATUS_LABELS, type BookingStatus } from "@/modules/booking/types";
import { isoToTaipeiTime } from "@/modules/booking/dateUtils";
import { formatAmount } from "@/modules/booking/orderAmount";

import type { MyBookingScheduleItem } from "./api";

function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

export function MyBookingDetailDialog({
  booking,
  open,
  onOpenChange,
}: {
  booking: MyBookingScheduleItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!booking) return null;

  // 2026-09-24 深夜巡檢問題 5:原本用 toLocaleTimeString 但沒帶 timeZone,跟著瀏覽器本機時區跑
  // ——服務人員的裝置時區不是 UTC+8 時(出國、手機自動時區抓錯)這裡的預約時間會顯示錯誤,而且
  // 跟「時間軸格線」檢視(用正確的 isoToTaipeiTime)對同一筆預約顯示出不同的時間。改用
  // dateUtils.ts 提供、明確指定 Asia/Taipei 的 isoToTaipeiTime。
  const startTime = isoToTaipeiTime(booking.start_at);
  const endTime = isoToTaipeiTime(booking.end_at);
  const status = booking.status as BookingStatus;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden rounded-t-xl p-0"
      >
        <SheetHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 text-left">
          <SheetTitle>預約詳情</SheetTitle>
        </SheetHeader>

        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">訂單狀態</span>
            <Badge variant={bookingStatusBadgeVariant(status)}>
              {BOOKING_STATUS_LABELS[status] ?? booking.status}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">預約時間</span>
            <span className="font-medium text-foreground">
              {startTime} - {endTime}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">角色</span>
            <Badge variant={booking.role_in_booking === "primary" ? "default" : "secondary"}>
              {booking.role_in_booking === "primary" ? "主要服務人員" : "協助"}
            </Badge>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">客戶姓名</span>
            <span className="min-w-0 break-words text-right font-medium text-foreground">
              {booking.customer_name}
              {booking.customer_phone ? ` ・ ${booking.customer_phone}` : ""}
            </span>
          </div>
          {booking.customer_address ? (
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">客戶地址</span>
              <span className="min-w-0 break-words text-right font-medium text-foreground">
                {booking.customer_address}
              </span>
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">服務項目</span>
            <p className="mt-1 text-foreground">
              {booking.service_item_names.length > 0
                ? booking.service_item_names.join("、")
                : "(無服務項目資料)"}
            </p>
          </div>
          {booking.is_member ? (
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">會員</span>
              <span className="min-w-0 break-words text-right font-medium text-foreground">
                {booking.member_name ?? "會員"}
                {booking.member_points_balance != null
                  ? `(目前點數 ${booking.member_points_balance})`
                  : ""}
              </span>
            </div>
          ) : null}
          {booking.notes ? (
            <div>
              <span className="text-muted-foreground">內部備註</span>
              <p className="mt-1 text-foreground">{booking.notes}</p>
            </div>
          ) : null}
          {booking.customer_notes ? (
            <div>
              <span className="text-muted-foreground">客戶備註</span>
              <p className="mt-1 text-foreground">{booking.customer_notes}</p>
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t border-border pt-2">
            <span className="font-semibold text-foreground">金額</span>
            <span className="text-base font-bold text-cta">
              {formatAmount(booking.final_amount_snapshot)}
            </span>
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-background px-5 py-3">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            關閉
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
