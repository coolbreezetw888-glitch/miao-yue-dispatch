// 對應規格書 4.3:服務人員自助行事曆(疊加在既有 src/modules/booking/CalendarPage.tsx 的
// role==='staff' 分支底下渲染)。月曆檢視 + 點開某一天看當天的預約明細清單(規則 2.5:含以
// 助手身份參與的預約;規則 2.6:依 show_member_info 決定要不要顯示會員專屬資訊)。
// 比起既有管理員/客服版本的行事曆(可以跨服務人員切換、建單、編輯),這裡刻意做成簡化版
// 唯讀檢視——服務人員這次的範圍只到「看得到自己的排程」,不包含建單/編輯(見規格書判斷 2)。

import { useMemo, useState, type CSSProperties } from "react";

import {
  AttributeTag,
  GuardLoading,
  ListCard,
  LoadingSkeleton,
  StatusTag,
} from "@/components/patterns";
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
import { formatAmount } from "@/modules/booking/orderAmount";
import {
  BOOKING_STATUS_LABELS,
  bookingCardAccentBorderStyle,
  bookingCardHoverBorderColor,
  bookingStatusTone,
  DEFAULT_BOOKING_STATUS_COLORS,
  getBookingStatusColor,
  type BookingStatus,
  type BookingStatusColorMap,
} from "@/modules/booking/types";

import {
  useActiveMyStaffRecord,
  useMyBookingSchedule,
  useMyBookingStatusColors,
  useMyStaffPermission,
  useStaffScheduleLiveSync,
} from "./context";
import { MyBookingDetailDialog } from "./MyBookingDetailDialog";
import { MyCalendarTimelineView } from "./MyCalendarTimelineView";
import type { MyBookingScheduleItem } from "./api";

// v2 §10.2.4:「卡片列表」/「時間軸格線」兩種檢視,預設卡片列表(維持 v1 既有行為不變,
// 新功能是選配的,不是取代)。
type CalendarViewMode = "list" | "timeline";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

// v2 §10.2.4:兩種檢視(卡片列表/時間軸格線)點擊任一筆預約都要能開啟同一個唯讀詳情彈窗
// (MyBookingDetailDialog),所以卡片是可點的。
//
// 🔴 SPECS-INDEX #861(2026-09-30 使用者實機巡檢):「卡片列表改成訂單管理那樣的 UI」。
// 改版前這裡是自己手刻的 <li><button> + 一堆 text-xs 小灰字堆疊,跟訂單管理頁(OrdersPage.tsx)
// 的訂單卡片完全是兩套外觀。現在改成套用跟它同一套共用元件與同一套視覺規則
// (skill 二之五「列表卡片」+ 二之四「標籤三類」):
//   ① 外殼用共用的 ListCard(圓角 12px、整張可點、狀態底色)
//   ② 左側 4px 色條 + 狀態膠囊都讀商家自訂的訂單狀態顏色(#860,bookingCardAccentBorderStyle /
//      getBookingStatusColor),跟商家端/訂單管理頁同一組色碼,不再是寫死的灰藍
//   ③ 待確認的卡片整張變黃(state="attention")、已取消整張變灰 —— 跟 OrdersPage 同一條規則
//   ④ 金額用 text-base font-bold text-brand,跟 OrdersPage 的金額同一個樣式
// 刻意**不照抄** OrdersPage 的欄位組合:那邊 title 放服務項目、meta 第一行放「預約時間・建單時間・
// 建單客服」。服務人員端沒有建單時間/建單客服(get_my_booking_schedule 不回傳,也不該回傳),
// 而且服務人員看自己的一天,最需要一眼看到的是**幾點到幾點**,所以時間放在 meta 第一行放大加粗。
function BookingListItem({
  booking,
  showCustomerAddress,
  statusColors,
  onClick,
}: {
  booking: MyBookingScheduleItem;
  /** 2026-09-24 使用者裁決(任務 2):商家目前的產業需要地址時才顯示客戶地址,見下方
   * MyCalendarPage 裡 showCustomerAddress 的完整說明。 */
  showCustomerAddress: boolean;
  /** #860:商家自訂的四個訂單狀態色碼(由呼叫端一次查好傳進來,不是每張卡各查一次)。 */
  statusColors: BookingStatusColorMap;
  onClick: () => void;
}) {
  // 2026-09-24 深夜巡檢問題 5:原本這裡用 toLocaleTimeString 但**沒有帶 timeZone**,顯示的是
  // 「瀏覽器本機時區」的時間。服務人員的手機/瀏覽器時區不是 UTC+8 時(出國、手機自動時區抓錯、
  // 境外機器)時間會顯示錯誤,而且同一頁切到「時間軸格線」檢視時
  // (MyCalendarTimelineView.tsx 用的是正確的 isoToTaipeiTime),同一筆預約會出現兩種時間。
  // dateUtils.ts 檔頭已明講「不依賴瀏覽器本機時區」,這裡改用它提供的 isoToTaipeiTime。
  const startTime = isoToTaipeiTime(booking.start_at);
  const endTime = isoToTaipeiTime(booking.end_at);
  const status = booking.status as BookingStatus;
  const isPrimary = booking.role_in_booking === "primary";

  return (
    <li>
      <ListCard
        onClick={onClick}
        state={
          status === "pending_confirmation"
            ? "attention"
            : status === "cancelled"
              ? "inactive"
              : "default"
        }
        className="border-l-4 hover:border-[color:var(--booking-card-hover-border)]"
        style={
          {
            ...bookingCardAccentBorderStyle(statusColors, status),
            "--booking-card-hover-border": bookingCardHoverBorderColor(statusColors, status),
          } as CSSProperties
        }
        title={
          booking.service_item_names.length > 0
            ? booking.service_item_names.join("、")
            : "(無服務項目資料)"
        }
        tags={
          <>
            {/* 狀態膠囊:實心填入商家自訂的那個顏色 + 一律白字,跟訂單管理頁同一條規則
                (2026-09-30 使用者裁決,SPECS-INDEX #832,理由見 lib/statusPillStyle.ts 檔頭)。 */}
            <StatusTag
              tone={bookingStatusTone(status)}
              fillColor={getBookingStatusColor(statusColors, status)}
            >
              {BOOKING_STATUS_LABELS[status] ?? booking.status}
            </StatusTag>
            {/* 🔴 SPECS-INDEX #861:「主要服務人員 / 協助」要更顯眼,而且兩者顏色要分得開。
                改版前兩顆都是同一個灰底 Badge(default/secondary 在這個主題下幾乎一樣),
                服務人員分不出自己這一單是主手還是副手。現在主手用 tone="strong"(主題色淺底 +
                主題色字 + 淡框)、協助維持安靜灰底。兩顆都是方角屬性標籤,不會跟左邊的狀態膠囊搞混。 */}
            <AttributeTag tone={isPrimary ? "strong" : "muted"}>
              {isPrimary ? "主要服務人員" : "協助"}
            </AttributeTag>
            {booking.is_member ? <AttributeTag>會員</AttributeTag> : null}
          </>
        }
        meta={
          <div className="flex flex-col gap-0.5">
            {/* 服務人員看自己的一天,最需要一眼看到的就是幾點到幾點 ⇒ 放大加粗放在第一行。 */}
            <span className="text-[15px] font-semibold text-foreground">
              {startTime} - {endTime}
            </span>
            <span className="text-foreground">
              {booking.customer_name}
              {booking.customer_phone ? `・${booking.customer_phone}` : ""}
            </span>
            {/* 任務 2:商家切成「到店服務」之後,服務人員的手機上也不該再看到客戶住家地址,所以條件是
                「商家目前的產業需要地址」且「這筆預約真的有地址值」,不是只看有沒有值。 */}
            {showCustomerAddress && booking.customer_address ? (
              <span>{booking.customer_address}</span>
            ) : null}
            {/* SPECS-INDEX #851:客服勾了「不讓服務人員看到」時,booking.notes 在資料庫那一層就
                已經是 null(不是前端藏起來),所以這個既有的條件式不用改就自動什麼都不顯示。 */}
            {booking.notes ? <span>內部備註:{booking.notes}</span> : null}
            {booking.customer_notes ? <span>客戶備註:{booking.customer_notes}</span> : null}
            {booking.is_member ? (
              <span>
                會員{booking.member_name ? `:${booking.member_name}` : ""}
                {booking.member_points_balance != null
                  ? `(目前點數 ${booking.member_points_balance})`
                  : ""}
              </span>
            ) : null}
            {booking.final_amount_snapshot != null ? (
              <span className="mt-1 text-base font-bold text-brand">
                {formatAmount(booking.final_amount_snapshot)}
              </span>
            ) : null}
          </div>
        }
      />
    </li>
  );
}

export default function MyCalendarPage() {
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: hasCalendarAccess, isLoading: permissionLoading } =
    useMyStaffPermission("staff_calendar_view");
  const { data: staffRow, isLoading: staffLoading } = useActiveMyStaffRecord(merchantId);

  // SPECS-INDEX #874(#895):商家端改單時自動更新這一頁,不用手動重新整理。
  // 一定要在下面任何 early return 之前呼叫(hook 規則)。沒有行事曆檢視權限 / staff_id 還沒解出來時
  // hook 內部不會訂閱;即時同步失敗也只記 console,不影響這一頁(#899)。
  useStaffScheduleLiveSync(staffRow?.id ?? null, { hasCalendarView: hasCalendarAccess });

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

  // SPECS-INDEX #860:商家自訂的四個訂單狀態色碼,整頁查一次傳給每張卡片(卡片列表的色條/狀態
  // 膠囊、時間軸格線的色塊都用它)。載入中/查無資料時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS。
  const { data: bookingStatusColors } = useMyBookingStatusColors(staffRow?.id ?? null);
  const effectiveStatusColors = bookingStatusColors ?? DEFAULT_BOOKING_STATUS_COLORS;

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
    // skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。這裡等的是整頁的前提(商家 / 自己的
    // 服務人員紀錄 / 權限),後面接的是一整頁,所以用守衛共用的那支(GuardLoading)。
    // ⚠️ 對應的測試(MyCalendarPage.test.tsx「問題 6」兩條)改成查 GuardLoading 的
    //    aria-label="載入中",不是查那四個字 —— 骨架沒有文字。
    return <GuardLoading />;
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
  // 地址還是會出現在服務人員的手機上。
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
            /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
            <LoadingSkeleton variant="lines" rows={4} />
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
                    statusColors={effectiveStatusColors}
                    onClick={() => setDetailBookingId(booking.id)}
                  />
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MyBookingDetailDialog
        booking={detailBooking}
        // SPECS-INDEX #861 第 3 項:「我的角色」那一列要顯示自己的名字,不是只有角色標籤。
        // 名字從 useActiveMyStaffRecord 拿(這一頁本來就已經查過,不用多發一支查詢);
        // 還沒載入完時傳 null,那一列就只顯示角色標籤(維持改版前的樣子,不顯示空白名字)。
        staffName={staffRow?.name ?? null}
        showCustomerAddress={showCustomerAddress}
        open={detailBookingId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailBookingId(null);
        }}
      />
    </div>
  );
}
