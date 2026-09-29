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
//
// ui-v1-full 第二階段第 1 批(盤點 S3):外殼從 Sheet(底部 85vh)換成 ui-overlay-patterns 的
// FullPageLayer,內容改用明細列(DetailSection / DetailRow / 可點的電話與地址 / 兩種備註)、狀態
// 標籤搬到標題列右側,底部固定「關閉」一顆。**照商家端 BookingDetailDialog.tsx 第一階段改好的樣子
// 改,但刻意不合併成同一個元件**(權限不同,見上方說明),也不把商家端才有的動作按鈕搬過來。
// 🔴 服務人員端看得到內部備註(2026-09-29 使用者確認),所以 InternalNote 照樣顯示,並保留
// 「客戶看不到,服務人員看得到」那個標記(標記由 InternalNote 元件固定加上)。

import {
  ActionBar,
  AttributeTag,
  CustomerNote,
  DetailAddressRow,
  DetailDivider,
  DetailPhoneRow,
  DetailRow,
  DetailSection,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  InternalNote,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import {
  BOOKING_STATUS_LABELS,
  bookingStatusTone,
  type BookingStatus,
} from "@/modules/booking/types";
import { isoToTaipeiTime } from "@/modules/booking/dateUtils";
import { formatAmount } from "@/modules/booking/orderAmount";

import type { MyBookingScheduleItem } from "./api";

export function MyBookingDetailDialog({
  booking,
  showCustomerAddress,
  open,
  onOpenChange,
}: {
  booking: MyBookingScheduleItem | null;
  /**
   * 2026-09-24 使用者裁決(任務 2):商家從「到府派工」切成「到店服務」之後,既有訂單的客戶地址
   * 要隱藏(包含服務人員端)。這裡刻意由呼叫端(MyCalendarPage)算好再傳進來,不在這顆彈窗裡自己
   * 讀商家設定——這個元件的既有設計就是「呼叫端已經拿到手的資料直接當 prop,不重新查詢」
   * (見檔頭說明),判斷邏輯與完整理由寫在 MyCalendarPage.tsx 的 showCustomerAddress 那段。
   */
  showCustomerAddress: boolean;
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
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title="預約詳情"
        titleExtra={
          <StatusTag tone={bookingStatusTone(status)}>
            {BOOKING_STATUS_LABELS[status] ?? booking.status}
          </StatusTag>
        }
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                關閉
              </Button>
            </FullPageLayerClose>
          </ActionBar>
        }
      >
        {/* skill 二之六 明細列:分組 + 組間留白、金額整組色塊、最重要的值放大、標籤淡值粗、
            數字 tabular-nums、電話/地址可點擊各佔一行、兩種備註分開。順序比照商家端:
            時間 → 人員 → 金額 → 客戶 → 備註。 */}
        <div className="flex min-w-0 flex-col gap-5">
          <DetailRow label="預約時間" size="lg">
            {startTime} – {endTime}
          </DetailRow>

          <DetailDivider />

          <DetailSection label="人員">
            <DetailRow label="我的角色">
              <AttributeTag>
                {booking.role_in_booking === "primary" ? "主要服務人員" : "協助"}
              </AttributeTag>
            </DetailRow>
          </DetailSection>

          <DetailSection label="金額" tone="amount">
            {/* 服務人員端拿到的是 get_my_booking_schedule 的精簡形狀,沒有逐項金額快照,
                只有服務項目名稱清單與最終金額,所以這一組只列名稱 + 最終金額。 */}
            <DetailRow label="服務項目">
              {booking.service_item_names.length > 0
                ? booking.service_item_names.join("、")
                : "(無服務項目資料)"}
            </DetailRow>
            <DetailDivider className="bg-brand/20" />
            <DetailRow label="最終金額" size="xl">
              {formatAmount(booking.final_amount_snapshot)}
            </DetailRow>
          </DetailSection>

          <DetailSection label="客戶">
            <p className="min-w-0 break-words text-base font-semibold text-foreground">
              {booking.customer_name}
            </p>
            {booking.is_member ? (
              <DetailRow label="會員">
                {booking.member_name ?? "會員"}
                {booking.member_points_balance != null
                  ? `(目前點數 ${booking.member_points_balance})`
                  : ""}
              </DetailRow>
            ) : null}
            {/* skill 二之六:電話 tel: 直接撥號、地址開地圖導航,各佔一行不並排。 */}
            {booking.customer_phone ? <DetailPhoneRow phone={booking.customer_phone} /> : null}
            {/* 任務 2:商家目前的產業需要地址且這筆預約真的有地址值,才顯示這一列。資料庫裡的
                地址值不動,所以商家切回「到府派工」時會重新顯示(預期行為)。 */}
            {showCustomerAddress && booking.customer_address ? (
              <DetailAddressRow address={booking.customer_address} />
            ) : null}
          </DetailSection>

          {booking.customer_notes || booking.notes ? (
            <DetailSection label="備註">
              {booking.customer_notes ? (
                <CustomerNote>{booking.customer_notes}</CustomerNote>
              ) : null}
              {booking.notes ? <InternalNote>{booking.notes}</InternalNote> : null}
            </DetailSection>
          ) : null}
        </div>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}
