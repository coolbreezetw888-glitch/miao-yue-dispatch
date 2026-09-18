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
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  getBooking,
  getCustomerRelatedBookings,
} from "./api";
import { isoToTaipeiDateTimeWithSeconds, isoToTaipeiTime } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  BOOKING_STATUS_LABELS,
  getPaymentMethodLabel,
  type BookingStatus,
  type CustomerRelatedBooking,
} from "./types";

function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
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
    <div className="space-y-3">
      <Button type="button" variant="outline" size="sm" onClick={onBack}>
        ← 返回訂單詳情
      </Button>
      {loading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : bookings.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          這位客戶目前沒有其他訂單紀錄。
        </p>
      ) : (
        <ul className="space-y-2">
          {bookings.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onSelect(b.id)}
                className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:border-brand hover:bg-brand-soft/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {isoToTaipeiDateTimeWithSeconds(b.startAt)}
                  </span>
                  <Badge variant={bookingStatusBadgeVariant(b.status)}>
                    {BOOKING_STATUS_LABELS[b.status]}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {b.serviceItemNames.length > 0
                    ? b.serviceItemNames.join("、")
                    : "(無服務項目資料)"}
                </p>
                <p className="mt-1 text-xs font-medium text-foreground">
                  {formatAmount(b.finalAmountSnapshot)}
                </p>
              </button>
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

  useEffect(() => {
    if (open) {
      setViewingBookingId(bookingId);
      setReason("");
      setShowRelated(false);
    }
  }, [open, bookingId]);

  const { data: booking, isLoading } = useQuery({
    queryKey: ["booking-module", "booking-detail", viewingBookingId],
    queryFn: () => getBooking(viewingBookingId as string),
    enabled: open && Boolean(viewingBookingId),
  });

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

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    try {
      await confirmBooking(booking.id);
      toast.success("已確認訂單");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
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

  // 建單與訂單管理介面優化 §5:改用 Sheet(側邊為 bottom)取代 Dialog,呈現成從底部滑出、
  // 佔滿寬度跟大部分高度的樣式,不要有明顯的四周留白。標題列固定在頂端(shrink-0),下方內容區
  // 可以捲動(flex-1 overflow-y-auto)——這顆彈窗沒有單一「送出」按鈕(確認/完成/編輯/取消是
  // 依狀態顯示的多個操作按鈕,既有版面本來就放在標題下方、資訊列之上,不是規格書 §5 第 2 點
  // 講的「送出按鈕」,維持原本位置,不強制搬到底部)。取消預約的二次確認 AlertDialog 維持原樣
  // 不用改(§5 第 3 點),巢狀在下面 showEditAndCancel 區塊裡,原封不動搬過來。
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[92vh] max-h-[92vh] flex-col gap-0 overflow-hidden rounded-t-xl p-0"
      >
        <SheetHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 text-left">
          <SheetTitle>{showRelated ? "相關訂單" : "預約詳情"}</SheetTitle>
        </SheetHeader>

        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {showRelated ? (
            <RelatedBookingsView
              loading={relatedLoading}
              bookings={relatedBookings ?? []}
              onBack={() => setShowRelated(false)}
              onSelect={(id) => {
                setViewingBookingId(id);
                setShowRelated(false);
              }}
            />
          ) : (
            <>
              {/* 預約詳情資訊擴充與建單備註分類第四節:操作按鈕從彈窗最下方搬到標題下方、
                資訊列之上,純版面位置調整,按鈕本身的顯示條件/點擊行為完全不變。 */}
              {booking && (showConfirm || showComplete || showEditAndCancel) ? (
                <div className="flex flex-wrap items-center gap-2 sm:justify-between">
                  {showEditAndCancel ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" disabled={busy}>
                          取消預約
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>確定要取消這筆預約嗎?</AlertDialogTitle>
                          <AlertDialogDescription>
                            取消後這個時段會恢復可預約,可以填寫取消原因(選填)。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <Textarea
                          placeholder="取消原因(選填)"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          rows={2}
                        />
                        <AlertDialogFooter>
                          <AlertDialogCancel>再想想</AlertDialogCancel>
                          <AlertDialogAction onClick={handleCancel}>確定取消</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {showEditAndCancel ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onEdit(booking.id)}
                      >
                        編輯
                      </Button>
                    ) : null}
                    {showConfirm ? (
                      <Button type="button" onClick={handleConfirm} disabled={busy}>
                        確認訂單
                      </Button>
                    ) : null}
                    {showComplete ? (
                      <Button type="button" onClick={handleComplete} disabled={busy}>
                        標記完成
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {isLoading || !booking ? (
                <p className="text-sm text-muted-foreground">載入中⋯</p>
              ) : (
                <div className="min-w-0 space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">訂單狀態</span>
                    <Badge variant={bookingStatusBadgeVariant(booking.status as BookingStatus)}>
                      {BOOKING_STATUS_LABELS[booking.status as BookingStatus]}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">建單時間</span>
                    <span className="font-medium text-foreground">
                      {isoToTaipeiDateTimeWithSeconds(booking.created_at)}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">預約客服</span>
                    <span className="min-w-0 break-words text-right font-medium text-foreground">
                      {booking.createdByName}
                    </span>
                  </div>
                  {booking.lastModifiedByName && booking.last_modified_at ? (
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">最後修改</span>
                      <span className="min-w-0 break-words text-right font-medium text-foreground">
                        {booking.lastModifiedByName} ・{" "}
                        {isoToTaipeiDateTimeWithSeconds(booking.last_modified_at)}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">服務人員</span>
                    <span className="min-w-0 break-words text-right font-medium text-foreground">
                      {staffNameById.get(booking.staff_id) ?? "(未知人員)"}
                    </span>
                  </div>
                  {booking.assistants.length > 0 ? (
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">助手</span>
                      <span className="min-w-0 break-words text-right font-medium text-foreground">
                        {booking.assistants.map((a) => a.staffName).join("、")}
                      </span>
                    </div>
                  ) : null}

                  {/* 模組 6 §3.1:金額明細改用快照(quantity × unitPriceSnapshot),取代原本的即時查價。 */}
                  <div>
                    <span className="text-muted-foreground">服務項目</span>
                    <ul className="mt-1 space-y-0.5">
                      {booking.serviceItems.map((i) => (
                        <li
                          key={i.id}
                          className="flex items-start justify-between gap-3 text-foreground"
                        >
                          <span className="min-w-0 break-words">
                            {i.name} × {i.quantity}
                          </span>
                          <span className="shrink-0">{formatAmount(i.lineTotal)}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1 flex items-center justify-between border-t border-border pt-1 text-xs">
                      <span className="text-muted-foreground">
                        服務金額小計
                        {booking.custom_total_amount_enabled ? "(已套用自訂總金額)" : ""}
                      </span>
                      <span className="font-medium text-foreground">
                        {formatAmount(booking.subtotal_amount_snapshot)}
                      </span>
                    </div>
                    {booking.discount_enabled ? (
                      <div className="mt-1 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          折扣(
                          {booking.discount_mode
                            ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                                booking.discount_mode as "fixed" | "percentage"
                              ]
                            : ""}
                          )
                        </span>
                        <span className="font-medium text-foreground">
                          -{formatAmount(booking.discount_amount_snapshot)}
                        </span>
                      </div>
                    ) : null}
                    {booking.tax_enabled ? (
                      <div className="mt-1 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          稅金(
                          {booking.tax_mode_snapshot
                            ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                                booking.tax_mode_snapshot as "fixed" | "percentage"
                              ]
                            : ""}
                          )
                        </span>
                        <span className="font-medium text-foreground">
                          +{formatAmount(booking.tax_amount_snapshot)}
                        </span>
                      </div>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between border-t border-border pt-1">
                      <span className="font-semibold text-foreground">最終金額</span>
                      <span className="text-base font-bold text-cta">
                        {formatAmount(booking.final_amount_snapshot)}
                      </span>
                    </div>
                  </div>

                  {/* 模組 6 §3.2:付款方式,沒有選擇時顯示「尚未設定」。 */}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">付款方式</span>
                    <span className="font-medium text-foreground">
                      {getPaymentMethodLabel(booking.payment_method)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">預約時間</span>
                    <span className="font-medium text-foreground">
                      {isoToTaipeiTime(booking.start_at)} - {isoToTaipeiTime(booking.end_at)}
                      {/* 模組 6 §3.1/§4.3:自訂工時開啟時,工時旁邊註明,避免管理員誤以為是逐項
                        加總算出來的。 */}
                      {booking.custom_duration_enabled ? (
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                          (已套用自訂工時 {booking.custom_duration_minutes} 分鐘)
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">客戶姓名</span>
                    <span className="min-w-0 break-words text-right font-medium text-foreground">
                      {booking.customer_name} ・ {booking.customer_phone}
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
                  {booking.customer_notes ? (
                    <div>
                      <span className="text-muted-foreground">客戶備註</span>
                      <p className="mt-1 text-foreground">{booking.customer_notes}</p>
                    </div>
                  ) : null}
                  {booking.materialCosts.length > 0 ? (
                    <div>
                      <span className="text-muted-foreground">料錢成本</span>
                      <ul className="mt-1 space-y-0.5">
                        {booking.materialCosts.map((c) => (
                          <li key={c.materialCostItemId} className="break-words text-foreground">
                            {c.name} ・ {formatAmount(c.amountSnapshot)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {booking.notes ? (
                    <div>
                      <span className="text-muted-foreground">內部備註</span>
                      <p className="mt-1 text-foreground">{booking.notes}</p>
                    </div>
                  ) : null}

                  {/* 模組 6 §3.3:相關訂單按鈕。 */}
                  <div className="border-t border-border pt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setShowRelated(true)}
                    >
                      相關訂單
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
