// SPECS-INDEX #996(第 11 批 K):預約詳情的「服務人員抽成」區塊 + 「重新計算抽成」按鈕。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §十八 K-4~K-8 + 檔尾「主腦裁決」。
//
// 誰看得到由呼叫端(BookingDetailDialog)判斷(K-4:看原本那一筆 + 已完成 + 管理員或有
// 「抽成與薪資設定」的客服;角色 / 權限讀取中不顯示)。這個元件只管:
//   ・讀總額(get_booking_commission_summary,不讀明細、不讀比例)
//   ・沒有紀錄 ⇒ 灰字、沒有按鈕;主要服務人員目前不是抽成制(主腦裁決)⇒ 顯示目前抽成 + 灰字、沒有按鈕
//   ・按鈕 → 確認小卡窗(疊在全頁層上)→ 重算 → toast 新舊金額、重抓總額與抽成 / 報表相關查詢
//   ・送出中確認窗與詳情都不能關(onBusyChange 通知呼叫端擋住全頁層的關閉)
// 權限的安全邊界在資料庫(private.can_manage_commission_settings),前端只是體驗。
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardAlertDialog,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  DetailRow,
  DetailSection,
  ErrorState,
  LoadingSkeleton,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { fetchBookingCommissionSummary, recalculateBookingCommission } from "@/modules/payroll/api";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  BOOKING_COMMISSION_COPY,
  BOOKING_COMMISSION_STATE_CHANGED_MESSAGES,
  bookingCommissionSummaryQueryKey,
  formatCommissionComputedAt,
} from "./bookingCommissionCopy";
import { formatAmount } from "./orderAmount";

export function BookingCommissionSection({
  bookingId,
  onBusyChange,
  onStateChanged,
}: {
  bookingId: string;
  /** 送出中 = true;呼叫端用來擋住全頁層的關閉(K-6)。 */
  onBusyChange: (busy: boolean) => void;
  /** 失敗訊息是「狀態已改變」那幾句時呼叫,讓呼叫端重抓訂單詳情(K-8)。 */
  onStateChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: bookingCommissionSummaryQueryKey(bookingId),
    queryFn: () => fetchBookingCommissionSummary(bookingId),
    // 42501 / 狀態類錯誤重試也沒用;讀不到就直接顯示錯誤 + 重試鈕。
    retry: false,
    staleTime: 0,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 每次打開 +1 當小卡窗的 key(#999 / 第 11 批 E 的教訓:關掉很快又打開時,上一次退場中的節點會讓遮罩蓋住按鈕)。
  const [dialogSeq, setDialogSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  /** K-7:舊金額取自「打開確認窗當下」讀到的值。 */
  const [oldAmount, setOldAmount] = useState<number | null>(null);

  function setBusyBoth(next: boolean) {
    setBusy(next);
    onBusyChange(next);
  }

  function openConfirm() {
    setOldAmount(summaryQuery.data?.commission_amount ?? null);
    setDialogSeq((n) => n + 1);
    setConfirmOpen(true);
  }

  async function handleRecalculate() {
    if (busy) return;
    setBusyBoth(true);
    try {
      const result = await recalculateBookingCommission(bookingId);
      const from = formatAmount(oldAmount);
      const to = formatAmount(Number(result.commission_amount));
      toast.success(
        from === to
          ? BOOKING_COMMISSION_COPY.successSame(to)
          : BOOKING_COMMISSION_COPY.successChanged(from, to),
      );
      setConfirmOpen(false);
      // 抽成 / 報表相關查詢(含本區塊的總額)都是 payroll-module 開頭。
      void queryClient.invalidateQueries({ queryKey: ["payroll-module"] });
    } catch (err) {
      const message = getErrorMessage(err);
      toast.error(BOOKING_COMMISSION_COPY.failTitle, { description: message });
      setConfirmOpen(false);
      if (BOOKING_COMMISSION_STATE_CHANGED_MESSAGES.some((m) => message.includes(m))) {
        void queryClient.invalidateQueries({
          queryKey: bookingCommissionSummaryQueryKey(bookingId),
        });
        onStateChanged();
      }
    } finally {
      setBusyBoth(false);
    }
  }

  const summary = summaryQuery.data;
  const currentText = formatAmount(summary?.commission_amount ?? null);

  return (
    <DetailSection label={BOOKING_COMMISSION_COPY.sectionLabel}>
      <div data-testid="booking-commission-section" className="flex flex-col gap-2">
        {summaryQuery.isLoading ? (
          <LoadingSkeleton variant="lines" rows={1} />
        ) : summaryQuery.isError || !summary ? (
          <ErrorState
            className="py-4"
            title={BOOKING_COMMISSION_COPY.loadError}
            onRetry={() => void summaryQuery.refetch()}
          />
        ) : !summary.has_record ? (
          <p
            className="text-[13px] leading-relaxed text-muted-foreground"
            data-testid="booking-commission-no-record"
          >
            {BOOKING_COMMISSION_COPY.noRecord}
          </p>
        ) : (
          <>
            <DetailRow label={BOOKING_COMMISSION_COPY.currentLabel} size="lg">
              <span data-testid="booking-commission-amount">{currentText}</span>
            </DetailRow>
            {(summary.recalculated_at ?? summary.computed_at) ? (
              <p
                className="text-right text-[11px] text-muted-foreground"
                data-testid="booking-commission-computed-at"
              >
                {BOOKING_COMMISSION_COPY.lastComputed(
                  formatCommissionComputedAt((summary.recalculated_at ?? summary.computed_at)!),
                )}
              </p>
            ) : null}
            {summary.staff_is_piece_rate ? (
              <Button
                type="button"
                variant="neutral"
                size="touch"
                className="w-full"
                disabled={busy}
                onClick={openConfirm}
                data-testid="booking-commission-recalculate"
              >
                {BOOKING_COMMISSION_COPY.button}
              </Button>
            ) : (
              <p
                className="text-[13px] leading-relaxed text-muted-foreground"
                data-testid="booking-commission-not-piece-rate"
              >
                {BOOKING_COMMISSION_COPY.notPieceRate}
              </p>
            )}
          </>
        )}
      </div>

      {/* K-6:確認小卡窗(疊在預約詳情全頁層上 = 兩層重疊)。送出中按 Esc / 取消都關不掉。 */}
      <CardAlertDialog
        key={dialogSeq}
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next && busy) return;
          setConfirmOpen(next);
        }}
      >
        <CardAlertDialogContent
          data-testid="booking-commission-confirm"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>{BOOKING_COMMISSION_COPY.confirmTitle}</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              {BOOKING_COMMISSION_COPY.confirmBody(formatAmount(oldAmount))}
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={busy}>
              {BOOKING_COMMISSION_COPY.confirmCancel}
            </CardAlertDialogCancel>
            {/* 不用 CardAlertDialogAction:它按下就關窗,這裡要等 RPC 回來、送出中不能關。外觀照 Action 的 primary。 */}
            <Button
              type="button"
              variant="primary"
              size="touch"
              disabled={busy}
              onClick={() => void handleRecalculate()}
              data-testid="booking-commission-confirm-action"
            >
              {busy ? BOOKING_COMMISSION_COPY.confirmBusy : BOOKING_COMMISSION_COPY.confirmAction}
            </Button>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </DetailSection>
  );
}
