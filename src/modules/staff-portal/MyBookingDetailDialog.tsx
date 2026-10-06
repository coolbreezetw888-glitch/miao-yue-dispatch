// 對應規格書 v2 §10.2.2:服務人員自助行事曆的預約詳情彈窗。
//
// 🔴 SPECS-INDEX #977 第 4 批(2026-10-06,推翻下面「唯讀、只有關閉按鈕」的舊決策):
//   訂單是「待確認」而且自己是**主要服務人員**時,底部多一顆主要按鈕「確認接單」
//   (判斷在 staffConfirmLogic.canStaffConfirmBooking;協助人員、已確認、已完成、已取消都不顯示)。
//   按下 → 呼叫 public.staff_confirm_booking(後端自己再檢查一次身分與狀態,前端不是只靠隱藏按鈕擋)
//   → 成功提示 → 立刻 invalidate 行事曆查詢,詳情與列表一起更新(不只等即時同步)。
//   不發 LINE、不發推播(後端只寫操作紀錄 + 商家管理員鈴鐺通知)。
//   順手修:標題列的狀態標籤改用商家自訂顏色(fillColor),跟列表卡片一致。
//   下面舊註解裡「唯讀 / Footer 只有一個關閉按鈕」的描述,以這一段為準。
//
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
// 🔴 服務人員端**預設**看得到內部備註(2026-09-29 使用者確認),所以 InternalNote 照樣顯示。
// SPECS-INDEX #850~#855(2026-09-30):客服可以逐單勾「不讓服務人員看到這則內部備註」。
// 勾起來的那一筆,遮蔽是做在資料庫那一層(get_my_booking_schedule 直接回 notes = null),
// **不是在這裡 if 掉不 render** —— 服務人員端是手機瀏覽器直打 Supabase,只要 API 回應裡帶著
// 那段文字,開發者工具的 Network 面板就看得到。所以下面那個既有的 `{booking.notes ? …}`
// 條件式一行都不用改,旗標打開時 notes 本來就是 null,整塊自動消失(主腦裁決 T1=A:
// **不顯示任何「有東西被藏起來」的提示**,連「有沒有藏」都不讓服務人員知道)。
// ⚠️ 所以這顆彈窗裡的 InternalNote 一律維持預設的 audience="staff-visible" ——
//    服務人員只會在「看得到」的情況下看到它,標記文字本來就成立;傳 "staff-hidden" 反而等於
//    告訴服務人員「這裡有東西被藏起來」,跟 T1 的裁決相反。
//
// 🔴 SPECS-INDEX #861(2026-09-30 使用者實機巡檢)這顆彈窗改了三處:
//   ① 「人員」那一組的小標改成「服務人員」(第 2 項)
//   ② 「我的角色」那一列除了角色標籤,還要顯示自己的名字(第 3 項)
//   ③ 「主要服務人員 / 協助」兩顆標籤要分得開、主手要更顯眼(第 4 項)

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
import { toast } from "sonner";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import {
  BOOKING_STATUS_LABELS,
  bookingStatusTone,
  DEFAULT_BOOKING_STATUS_COLORS,
  getBookingStatusColor,
  type BookingStatus,
  type BookingStatusColorMap,
} from "@/modules/booking/types";
import { isoToTaipeiTime } from "@/modules/booking/dateUtils";
import { formatAmount } from "@/modules/booking/orderAmount";

import type { MyBookingScheduleItem } from "./api";
import { useStaffConfirmBooking } from "./context";
import { canStaffConfirmBooking } from "./staffConfirmLogic";

export function MyBookingDetailDialog({
  booking,
  staffName,
  showCustomerAddress,
  statusColors = DEFAULT_BOOKING_STATUS_COLORS,
  open,
  onOpenChange,
}: {
  booking: MyBookingScheduleItem | null;
  /**
   * SPECS-INDEX #861 第 3 項:登入者自己的姓名,顯示在「我的角色」那一列。
   * 由呼叫端(MyCalendarPage)從已經查好的 useActiveMyStaffRecord 傳進來,不在這顆彈窗裡自己查
   * —— 沿用這個元件既有的設計原則(呼叫端已經拿到手的資料直接當 prop,不重新查詢,見檔頭)。
   * 還沒載入完時傳 null,那一列就只顯示角色標籤(不顯示一個空白的名字)。
   */
  staffName: string | null;
  /**
   * 2026-09-24 使用者裁決(任務 2):商家從「到府派工」切成「到店服務」之後,既有訂單的客戶地址
   * 要隱藏(包含服務人員端)。這裡刻意由呼叫端(MyCalendarPage)算好再傳進來,不在這顆彈窗裡自己
   * 讀商家設定——這個元件的既有設計就是「呼叫端已經拿到手的資料直接當 prop,不重新查詢」
   * (見檔頭說明),判斷邏輯與完整理由寫在 MyCalendarPage.tsx 的 showCustomerAddress 那段。
   */
  showCustomerAddress: boolean;
  /** #977 第 4 批:商家自訂的訂單狀態色碼(呼叫端已經查好,跟列表卡片同一份)。 */
  statusColors?: BookingStatusColorMap | undefined;
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
  const showConfirm = canStaffConfirmBooking(booking);

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title="預約詳情"
        titleExtra={
          <StatusTag
            tone={bookingStatusTone(status)}
            fillColor={getBookingStatusColor(statusColors, status)}
          >
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
            {showConfirm ? <StaffConfirmBookingButton bookingId={booking.id} /> : null}
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

          {/* #861 第 2 項:小標從「人員」改成「服務人員」—— 這一組講的就是服務人員本人,
              「人員」太籠統,而且全站用語一律「服務人員」(skill 二之二)。 */}
          <DetailSection label="服務人員">
            {/* #861 第 3 項:除了角色標籤,也要顯示自己的名字。服務人員可能同時在多間商家任職、
                也可能一個人被登記成兩筆(改名前/改名後),看到名字才確定「這確實是我這一筆」。
                #861 第 4 項:主手用 tone="strong"(主題色淺底),協助維持安靜灰底,一眼分得開。 */}
            <DetailRow label="我的角色">
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {staffName ? (
                  <span className="min-w-0 break-words font-semibold text-foreground">
                    {staffName}
                  </span>
                ) : null}
                <AttributeTag tone={booking.role_in_booking === "primary" ? "strong" : "muted"}>
                  {booking.role_in_booking === "primary" ? "主要服務人員" : "協助"}
                </AttributeTag>
              </span>
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

/**
 * #977 第 4 批:「確認接單」主要按鈕。獨立成一個小元件,讓 mutation(需要 QueryClient)只在按鈕真的出現時才建立
 * —— 已確認 / 已完成 / 協助人員的詳情不會掛任何寫入用的 hook。
 * 成功 ⇒ 提示 + useStaffConfirmBooking 內部立刻 invalidate 行事曆查詢(詳情、列表、鈴鐺待確認數一起更新)。
 * 失敗 ⇒ 顯示後端的中文原因(例如「這筆訂單已經不是待確認狀態，請重新整理」)。
 */
function StaffConfirmBookingButton({ bookingId }: { bookingId: string }) {
  const confirmMutation = useStaffConfirmBooking();

  function handleConfirm() {
    confirmMutation.mutate(bookingId, {
      onSuccess: () => {
        toast.success("已確認接單");
      },
      onError: (err) => {
        toast.error("確認接單失敗", { description: getErrorMessage(err) });
      },
    });
  }

  return (
    <Button
      type="button"
      variant="primary"
      size="touch"
      onClick={handleConfirm}
      disabled={confirmMutation.isPending}
      data-testid="staff-confirm-booking-button"
    >
      確認接單
    </Button>
  );
}
