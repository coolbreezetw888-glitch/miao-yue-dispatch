// 模組 6(訂單管理)§3.1/§3.2/§3.3:預約詳情彈窗。
// 原本這顆彈窗定義在 CalendarPage.tsx 內部、不對外匯出;這次抽成獨立檔案,讓「訂單管理頁」
// (OrdersPage.tsx)也能直接複用同一顆彈窗——規格書 §1.1 明講「點擊任一列開啟既有的預約詳情
// 彈窗(BookingDetailDialog,沿用模組 5 擴充既有元件,不重做)」,抽檔案是達成「不重做」的必要
// 前提(CalendarPage.tsx 原本沒有 export 這個元件,兩個頁面沒辦法共用)。
//
// 除了抽檔案,這次同時疊加三項新內容:
//   §3.1 金額明細顯示改用快照(quantity × unit_price_snapshot,取代原本的即時查價)、
//        新增小計/折扣/稅金/最終金額 breakdown。
//   §3.2 付款方式顯示(沒有選擇時顯示「尚未設定」)。
//   §3.3 「相關訂單」按鈕:點擊後在同一顆彈窗裡切換顯示同一位客戶的歷史訂單清單,
//        點清單裡任一筆會直接切換成該筆的詳情(不重新開一顆彈窗)。
// 其餘既有邏輯(狀態徽章、確認/完成/編輯/取消按鈕、建立/修改追蹤資訊列)原封不動搬過來,不變動行為。

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

// ui-v1-full 階段一(2026-09-29):這顆彈窗是全站 55 個彈窗統一改版的「全頁層」範本(盤點 A11)。
// 外殼從 Sheet(底部 92vh)換成 ui-overlay-patterns 的 FullPageLayer(手機滿版 / 電腦置中面板),
// 內容改用明細列(DetailSection / DetailRow / 可點的電話與地址 / 兩種備註)、狀態標籤(StatusTag)、
// 底部等寬動作列(ActionBar)。**只動外觀與版面,不動任何行為**:按鈕顯示條件、點擊後做什麼、
// 資料查詢、權限判斷全部維持原樣。
import {
  ActionBar,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  CustomerNote,
  DetailAddressRow,
  DetailDivider,
  DetailLinkRow,
  DetailLinkRows,
  DetailPhoneRow,
  DetailRow,
  DetailSection,
  EmptyState,
  FieldTextarea,
  FullPageLayer,
  FullPageLayerContent,
  InternalNote,
  ListCard,
  LoadingSkeleton,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { ConfirmBookingLineDialog } from "@/modules/line-notifications/ConfirmBookingLineDialog";
import {
  dispatchLineNotification,
  usePendingLineNotificationPreview,
} from "@/modules/line-notifications/api";
import type { PendingLineNotificationTarget } from "@/modules/line-notifications/types";

import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  getBooking,
  getCustomerRelatedBookings,
} from "./api";
import { useBookingStatusChangeLogs } from "./context";
import { isoToTaipeiDateTimeWithSeconds, isoToTaipeiTime } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  BOOKING_STATUS_LABELS,
  bookingStatusTone,
  getPaymentMethodLabel,
  type BookingStatus,
  type BookingStatusChangeLog,
  type CustomerRelatedBooking,
} from "./types";

/** 子畫面左上角的「‹ 返回訂單詳情」:skill 二之八的骨架寫法(一行小字,不是按鈕)。 */
function BackToDetailLink({ onBack }: { onBack: () => void }) {
  return (
    <Button
      type="button"
      variant="text"
      size="card"
      className="-ml-2 self-start px-2"
      onClick={onBack}
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      返回訂單詳情
    </Button>
  );
}

// ---------------------------------------------------------------------------
// §3.3:相關訂單清單畫面,套用在同一顆 Dialog 裡(不另外疊一層彈窗)。
// ---------------------------------------------------------------------------
function RelatedBookingsView({
  loading,
  bookings,
  onBack,
  onSelect,
}: {
  loading: boolean;
  bookings: CustomerRelatedBooking[];
  onBack: () => void;
  onSelect: (bookingId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackToDetailLink onBack={onBack} />
      {loading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : bookings.length === 0 ? (
        <EmptyState
          title="這位客戶目前沒有其他訂單紀錄"
          description="之後這位客戶再預約,會自動列在這裡,方便對照上次做過什麼。"
          action={
            <Button type="button" variant="neutral" size="touch" onClick={onBack}>
              返回訂單詳情
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {bookings.map((b) => (
            <li key={b.id}>
              <ListCard
                onClick={() => onSelect(b.id)}
                title={
                  <span className="tabular-nums">{isoToTaipeiDateTimeWithSeconds(b.startAt)}</span>
                }
                tags={
                  <StatusTag tone={bookingStatusTone(b.status)}>
                    {BOOKING_STATUS_LABELS[b.status]}
                  </StatusTag>
                }
                meta={
                  <>
                    <span className="break-words">
                      {b.serviceItemNames.length > 0
                        ? b.serviceItemNames.join("、")
                        : "(無服務項目資料)"}
                    </span>
                    <span className="ml-2 font-medium text-foreground">
                      {formatAmount(b.finalAmountSnapshot)}
                    </span>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模組 6 §9.1(SPECS-INDEX #597):操作記錄清單畫面,套用在同一顆 Dialog 裡(比照 §3.3 相關訂單
// 的既有互動模式,不另外疊一層彈窗)。
// ---------------------------------------------------------------------------
function statusChangeLogText(log: BookingStatusChangeLog): string {
  if (log.fromStatus === null) {
    return `建立訂單(${BOOKING_STATUS_LABELS[log.toStatus]})`;
  }
  return `把訂單狀態從「${BOOKING_STATUS_LABELS[log.fromStatus]}」改成「${BOOKING_STATUS_LABELS[log.toStatus]}」`;
}

function StatusChangeLogsView({
  loading,
  logs,
  onBack,
}: {
  loading: boolean;
  logs: BookingStatusChangeLog[];
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackToDetailLink onBack={onBack} />
      {loading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : logs.length === 0 ? (
        <EmptyState
          title="目前沒有任何操作紀錄"
          description="之後有人確認、完成或取消這筆訂單,會記在這裡,可以查是誰、什麼時候改的。"
          action={
            <Button type="button" variant="neutral" size="touch" onClick={onBack}>
              返回訂單詳情
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {logs.map((log) => (
            <li key={log.id}>
              <ListCard
                title={
                  <span className="text-sm font-medium">
                    {log.actorNameSnapshot} {statusChangeLogText(log)}
                  </span>
                }
                meta={isoToTaipeiDateTimeWithSeconds(log.createdAt)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BookingDetailDialog({
  bookingId,
  staffNameById,
  open,
  onOpenChange,
  onChanged,
  onEdit,
}: {
  bookingId: string | null;
  staffNameById: Map<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  onEdit: (bookingId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // §3.3:目前顯示中的訂單 id——預設等於傳進來的 bookingId,點擊「相關訂單」清單裡的項目時
  // 切換成該筆訂單的 id,同一顆彈窗直接顯示對應詳情,不用另外開一顆彈窗。
  const [viewingBookingId, setViewingBookingId] = useState<string | null>(bookingId);
  const [showRelated, setShowRelated] = useState(false);
  // 模組 6 §9.1(SPECS-INDEX #597):操作記錄的顯示狀態,跟 showRelated 互斥(同一時間只顯示
  // 其中一種子畫面),比照「相關訂單」既有的互動模式。
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    if (open) {
      setViewingBookingId(bookingId);
      setReason("");
      setShowRelated(false);
      setShowLogs(false);
    }
  }, [open, bookingId]);

  const { data: booking, isLoading } = useQuery({
    queryKey: ["booking-module", "booking-detail", viewingBookingId],
    queryFn: () => getBooking(viewingBookingId as string),
    enabled: open && Boolean(viewingBookingId),
  });

  // 模組 10(會員與紅利)§4.5:判斷目前使用者是否也擁有 members 權限,決定會員姓名要不要做成
  // 可點擊連結。這裡完全不需要額外的權限檢查/API 呼叫(一之二節方向一)——member_name_snapshot
  // 已經隨著 bookings_select 政策一起讀到,純粹是前端顯示層的判斷。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageMembers } = useAgentPermission("members");
  const canViewMemberProfile = merchantRole === "admin" || canManageMembers === true;

  // 2026-09-24 使用者裁決(任務 2):商家切成「到店服務」之後,既有訂單的客戶地址要隱藏。
  // industry_type 現在可以隨時切換(見 merchant/api.ts 2026-09-23 的說明,資料庫層鎖定的
  // trigger 已經拿掉),所以顯示條件必須看「商家**目前**的產業設定需不需要地址」,不能只看
  // 「這筆訂單有沒有地址值」——不然到府派工時期建立的舊訂單,切成到店服務之後客戶住家地址
  // 還是會出現在預約詳情裡。判斷一律用 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS 這份共用對照表
  // (建單表單 CalendarPage.tsx 判斷「要不要顯示客戶地址欄位」用的是同一份),不要在這裡自己
  // 寫死產業判斷式。
  //
  // 刻意只改「顯示」不動資料:資料庫裡的 bookings.customer_address 值完全保留,所以商家如果
  // 再切回「到府派工」,舊訂單的地址會重新顯示出來——這是使用者要的行為(他說的是「隱藏」,
  // 不是刪除),不是漏改。
  const { merchant } = useCurrentMerchant();
  const showCustomerAddress =
    merchant !== null &&
    INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[merchant.industry_type as IndustryType] === true;

  const { data: relatedBookings, isLoading: relatedLoading } = useQuery({
    queryKey: [
      "booking-module",
      "related-bookings",
      booking?.merchant_id,
      booking?.customer_phone,
      viewingBookingId,
    ],
    queryFn: () =>
      getCustomerRelatedBookings(booking!.merchant_id, booking!.customer_phone, viewingBookingId),
    enabled: open && showRelated && Boolean(booking),
  });

  // 模組 6 §9.1(SPECS-INDEX #597):操作記錄查詢,只在打開這個子畫面時才查(比照「相關訂單」
  // 既有的 enabled 條件寫法),不用等使用者點開按鈕就預先撈。
  const { data: statusChangeLogs, isLoading: statusChangeLogsLoading } = useBookingStatusChangeLogs(
    viewingBookingId,
    open && showLogs,
  );

  // 模組 11(LINE 通知)規則 2.5/§4.8:確認訂單前先預覽會不會通知任何人——沒有目標就直接確認,
  // 有目標才彈出 Yes/No 對話框,兩個選項都會執行 confirm_booking(),差別只在於「是」之後才呼叫
  // dispatchLineNotification。
  const { refetch: refetchLinePreview } = usePendingLineNotificationPreview(
    booking?.id,
    "booking_confirmed",
  );
  const [showLineDialog, setShowLineDialog] = useState(false);
  const [lineDialogTargets, setLineDialogTargets] = useState<PendingLineNotificationTarget[]>([]);

  async function doConfirm(shouldNotify: boolean) {
    if (!booking) return;
    setBusy(true);
    try {
      await confirmBooking(booking.id);
      if (shouldNotify) {
        dispatchLineNotification({
          merchantId: booking.merchant_id,
          bookingId: booking.id,
          eventType: "booking_confirmed",
        });
      }
      toast.success("已確認訂單");
      setShowLineDialog(false);
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    try {
      const { data: preview } = await refetchLinePreview();
      if (preview?.hasAnyTarget) {
        setLineDialogTargets(preview.targets);
        setShowLineDialog(true);
        setBusy(false);
        return;
      }
      await doConfirm(false);
    } catch (err) {
      // 規則 2.5 的預覽本身失敗不應該擋住確認訂單這個核心業務操作——退回成「視為沒有通知對象」
      // 直接確認,不彈窗(這是本模組沒有明文規定、由 engineer 補上的保守假設,已在回報中提出
      // 請主腦/使用者確認是否認同這個 fallback 行為)。
      console.error("[preview_line_notification_targets] 呼叫失敗,略過通知彈窗", err);
      await doConfirm(false);
    }
  }

  async function handleComplete() {
    if (!booking) return;
    setBusy(true);
    try {
      await completeBooking(booking.id);
      toast.success("已標記完成");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!booking) return;
    setBusy(true);
    try {
      await cancelBooking(booking.id, reason.trim() ? reason.trim() : null);
      toast.success("已取消預約");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!bookingId) return null;

  // 5.2 第 3 點:操作按鈕依狀態調整(這幾個按鈕只對「目前傳入的這一筆」有效,切去看相關訂單時
  // 不顯示,避免誤操作到剛剛切換過去查看的另一筆訂單)。
  const isViewingOriginal = viewingBookingId === bookingId;
  const showConfirm = isViewingOriginal && booking?.status === "pending_confirmation";
  const showComplete = isViewingOriginal && booking?.status === "accepted";
  const showEditAndCancel =
    isViewingOriginal &&
    (booking?.status === "pending_confirmation" || booking?.status === "accepted");

  // ui-v1-full 階段一:外殼改用 FullPageLayer(skill 三、全頁層:手機滿版 / 電腦置中面板、標題列與
  // 按鈕列固定、只有中間捲動)。操作按鈕依 skill 二之三搬到底部固定動作列並三顆等寬(取消預約 /
  // 編輯 / 確認訂單或標記完成),**顯示條件與點擊行為跟原本一模一樣**;取消預約的二次確認改用小卡窗
  // 殼 CardAlertDialog(疊在全頁層之上,skill 三、兩層重疊),內容與 handleCancel 不變。
  // 狀態標籤搬到標題列右側(titleExtra),原本內容區第一列的「訂單狀態」因此拿掉,資訊沒有少。
  const isDetailView = !showRelated && !showLogs;
  const showActionBar =
    Boolean(booking) && isDetailView && (showConfirm || showComplete || showEditAndCancel);

  return (
    <>
      <FullPageLayer open={open} onOpenChange={onOpenChange}>
        <FullPageLayerContent
          title={showRelated ? "相關訂單" : showLogs ? "操作記錄" : "預約詳情"}
          titleExtra={
            booking && isDetailView ? (
              <StatusTag tone={bookingStatusTone(booking.status as BookingStatus)}>
                {BOOKING_STATUS_LABELS[booking.status as BookingStatus]}
              </StatusTag>
            ) : null
          }
          footer={
            booking && showActionBar ? (
              <ActionBar>
                {showEditAndCancel ? (
                  <CardAlertDialog>
                    <CardAlertDialogTrigger asChild>
                      <Button type="button" variant="danger" size="touch" disabled={busy}>
                        取消預約
                      </Button>
                    </CardAlertDialogTrigger>
                    <CardAlertDialogContent>
                      <CardAlertDialogHeader>
                        <CardAlertDialogTitle>確定要取消這筆預約嗎?</CardAlertDialogTitle>
                        <CardAlertDialogDescription>
                          取消後這個時段會恢復可預約,可以填寫取消原因(選填)。
                        </CardAlertDialogDescription>
                      </CardAlertDialogHeader>
                      <FieldTextarea
                        placeholder="取消原因(選填)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        className="min-h-0"
                      />
                      <CardAlertDialogFooter>
                        <CardAlertDialogCancel>再想想</CardAlertDialogCancel>
                        <CardAlertDialogAction tone="danger" onClick={handleCancel}>
                          確定取消
                        </CardAlertDialogAction>
                      </CardAlertDialogFooter>
                    </CardAlertDialogContent>
                  </CardAlertDialog>
                ) : null}
                {showEditAndCancel ? (
                  <Button
                    type="button"
                    variant="neutral"
                    size="touch"
                    disabled={busy}
                    onClick={() => onEdit(booking.id)}
                  >
                    編輯
                  </Button>
                ) : null}
                {showConfirm ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="touch"
                    onClick={handleConfirm}
                    disabled={busy}
                  >
                    確認訂單
                  </Button>
                ) : null}
                {showComplete ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="touch"
                    onClick={handleComplete}
                    disabled={busy}
                  >
                    標記完成
                  </Button>
                ) : null}
              </ActionBar>
            ) : null
          }
        >
          {showLogs ? (
            <StatusChangeLogsView
              loading={statusChangeLogsLoading}
              logs={statusChangeLogs ?? []}
              onBack={() => setShowLogs(false)}
            />
          ) : showRelated ? (
            <RelatedBookingsView
              loading={relatedLoading}
              bookings={relatedBookings ?? []}
              onBack={() => setShowRelated(false)}
              onSelect={(id) => {
                setViewingBookingId(id);
                setShowRelated(false);
              }}
            />
          ) : isLoading || !booking ? (
            // skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。
            <LoadingSkeleton variant="lines" rows={8} />
          ) : (
            // skill 二之六 明細列:分組 + 組間留白、金額整組色塊、最重要的值放大、標籤淡值粗、
            // 數字 tabular-nums、電話/地址可點擊各佔一行、兩種備註分開。
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex flex-col gap-1">
                <DetailRow label="預約時間" size="lg">
                  {isoToTaipeiTime(booking.start_at)} – {isoToTaipeiTime(booking.end_at)}
                </DetailRow>
                {/* 模組 6 §3.1/§4.3:自訂工時開啟時,工時旁邊註明,避免管理員誤以為是逐項
                    加總算出來的。 */}
                {booking.custom_duration_enabled ? (
                  <p className="text-right text-[11px] text-muted-foreground">
                    已套用自訂工時 {booking.custom_duration_minutes} 分鐘
                  </p>
                ) : null}
              </div>

              <DetailDivider />

              <DetailSection label="人員">
                <DetailRow label="服務人員">
                  {staffNameById.get(booking.staff_id) ?? "(未知人員)"}
                </DetailRow>
                {booking.assistants.length > 0 ? (
                  <DetailRow label="助手">
                    {booking.assistants.map((a) => a.staffName).join("、")}
                  </DetailRow>
                ) : null}
                <DetailRow label="預約客服" size="sm">
                  {booking.createdByName}
                </DetailRow>
              </DetailSection>

              {/* 模組 6 §3.1:金額明細改用快照(quantity × unitPriceSnapshot),取代原本的即時查價。 */}
              <DetailSection label="金額" tone="amount">
                {booking.serviceItems.map((i) => (
                  <DetailRow key={i.id} label={`${i.name} × ${i.quantity}`}>
                    {formatAmount(i.lineTotal)}
                  </DetailRow>
                ))}
                <DetailRow
                  label={`服務金額小計${booking.custom_total_amount_enabled ? "(已套用自訂總金額)" : ""}`}
                  size="sm"
                >
                  {formatAmount(booking.subtotal_amount_snapshot)}
                </DetailRow>
                {booking.discount_enabled ? (
                  <DetailRow
                    label={`折扣(${
                      booking.discount_mode
                        ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                            booking.discount_mode as "fixed" | "percentage"
                          ]
                        : ""
                    })`}
                    size="sm"
                  >
                    -{formatAmount(booking.discount_amount_snapshot)}
                  </DetailRow>
                ) : null}
                {booking.tax_enabled ? (
                  <DetailRow
                    label={`稅金(${
                      booking.tax_mode_snapshot
                        ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                            booking.tax_mode_snapshot as "fixed" | "percentage"
                          ]
                        : ""
                    })`}
                    size="sm"
                  >
                    +{formatAmount(booking.tax_amount_snapshot)}
                  </DetailRow>
                ) : null}
                <DetailDivider className="bg-brand/20" />
                <DetailRow label="最終金額" size="xl">
                  {formatAmount(booking.final_amount_snapshot)}
                </DetailRow>
                {/* 模組 9(支付方式)v2:直接顯示快照文字,沒有選擇時顯示「尚未設定」。 */}
                <DetailRow label="付款方式" size="sm">
                  {getPaymentMethodLabel(booking.payment_method_name_snapshot)}
                </DetailRow>
              </DetailSection>

              {booking.materialCosts.length > 0 ? (
                <DetailSection label="料錢成本">
                  {booking.materialCosts.map((c) => (
                    <DetailRow key={c.materialCostItemId} label={c.name}>
                      {formatAmount(c.amountSnapshot)}
                    </DetailRow>
                  ))}
                </DetailSection>
              ) : null}

              <DetailSection label="客戶">
                <p className="min-w-0 break-words text-base font-semibold text-foreground">
                  {booking.customer_name}
                </p>
                {/* 模組 10(會員與紅利)§4.5:member_name_snapshot 有值才顯示這一列。有
                    members 權限(或管理員)才做成可點擊連結,否則只顯示純文字。 */}
                {booking.member_name_snapshot ? (
                  <DetailRow label="會員">
                    {canViewMemberProfile && booking.member_id ? (
                      <Link
                        to={`/app/members/${booking.member_id}`}
                        className="text-brand hover:underline"
                      >
                        {booking.member_name_snapshot}
                      </Link>
                    ) : (
                      booking.member_name_snapshot
                    )}
                  </DetailRow>
                ) : null}
                {/* skill 二之六:電話 tel: 直接撥號、地址開地圖導航,各佔一行不並排。 */}
                <DetailPhoneRow phone={booking.customer_phone} />
                {/* 任務 2:商家目前的產業需要地址(showCustomerAddress)且這筆訂單真的有
                    地址值,才顯示這一列——切成「到店服務」之後舊訂單的地址一律不顯示。 */}
                {showCustomerAddress && booking.customer_address ? (
                  <DetailAddressRow address={booking.customer_address} />
                ) : null}
              </DetailSection>

              {booking.customer_notes || booking.notes ? (
                <DetailSection label="備註">
                  {booking.customer_notes ? (
                    <CustomerNote>{booking.customer_notes}</CustomerNote>
                  ) : null}
                  {/* SPECS-INDEX #854:🔒 標記要說實話 —— 這一筆勾了「不讓服務人員看到」時,
                      標記文字要從「客戶看不到,服務人員看得到」改成「客戶與服務人員都看不到」。
                      不改的話客服會看著詳情頁以為自己明明藏起來的備註服務人員還是看得到。 */}
                  {booking.notes ? (
                    <InternalNote
                      audience={booking.hide_notes_from_staff ? "staff-hidden" : "staff-visible"}
                    >
                      {booking.notes}
                    </InternalNote>
                  ) : null}
                </DetailSection>
              ) : null}

              <DetailSection label="記錄">
                <DetailRow label="建單時間" size="sm">
                  {isoToTaipeiDateTimeWithSeconds(booking.created_at)}
                </DetailRow>
                {booking.lastModifiedByName && booking.last_modified_at ? (
                  <DetailRow label="最後修改" size="sm">
                    {booking.lastModifiedByName} ・{" "}
                    {isoToTaipeiDateTimeWithSeconds(booking.last_modified_at)}
                  </DetailRow>
                ) : null}
              </DetailSection>

              {/* 模組 6 §3.3:相關訂單。§9.1(SPECS-INDEX #597):操作記錄。skill 二之六第 6 點:
                  「去別的地方看」做成可點的列 + ›,不是整條寬的按鈕。 */}
              <DetailLinkRows>
                <DetailLinkRow label="相關訂單" onClick={() => setShowRelated(true)} />
                <DetailLinkRow label="操作記錄" onClick={() => setShowLogs(true)} />
              </DetailLinkRows>
            </div>
          )}
        </FullPageLayerContent>
      </FullPageLayer>

      {/* 模組 11(LINE 通知)§4.8/規則 2.5:有實際會被通知的對象時才顯示,兩個選項都會執行
        confirm_booking(),差別只在於要不要額外呼叫 dispatchLineNotification。刻意放在 Sheet
        外層(獨立的 Radix AlertDialog root),避免巢狀在同一個 Sheet root 底下互相干擾。 */}
      <ConfirmBookingLineDialog
        open={showLineDialog}
        targets={lineDialogTargets}
        busy={busy}
        onOpenChange={setShowLineDialog}
        onChoice={(shouldNotify) => void doConfirm(shouldNotify)}
      />
    </>
  );
}
