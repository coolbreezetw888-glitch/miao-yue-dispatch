// 客戶端第 3 批(C3-D06,依零之零改寫):完成頁 ⑦-1 / ⑦-2 / ⑦-3。畫面對照預覽圖同名區塊。
//
//   ⑦-1 會員、待確認     「已送出，等待店家確認」
//   ⑦-2 會員、直接成立   「預約成功」
//   ⑦-3 訪客(一律待確認)「已送出，等待店家確認」+ 填的電話 +(店家有 LINE 登入時)「用 LINE 登入加入會員」
//
// 零之零:
//   ・副標 = 伺服器回的 completion_message(店家自訂,會員 / 訪客分開;沒填 = 預設句)。純文字、保留換行,
//     🔴 不用 dangerouslySetInnerHTML。
//   ・「要取消或改時間請聯絡店家」+ 聯絡按鈕是**固定一行**,不在店家自訂文字裡(第 4 批有自助取消再調整)。
//   ・服務人員欄一律顯示 staff_display(被排到的那位);萬一伺服器沒給才顯示「由店家安排」。
//   ・「前往會員中心」這批不顯示(第 4 批)。
// 結果只放在記憶體:重新整理 / 系統上一頁都回 ①(由 PublicBookingPage 處理)。

import { CalendarCheck, Check, Clock } from "lucide-react";

import { AlertNote, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";

import {
  completionKind,
  formatSubmittedItems,
  formatSubmittedStart,
  type SubmittedBooking,
} from "./bookingSubmitLogic";
import { LINE_GREEN_BUTTON_CLASS } from "./CustomerLoginScreens";
import { ContactButtons, LineIcon, PublicShell, TitleOnlyHeader } from "./PublicBookingChrome";
import { formatPublicPrice, type ContactLinks } from "./publicBookingLogic";

export const CANCEL_OR_RESCHEDULE_TEXT = "要取消或改時間請聯絡店家";

export function BookingCompleteScreen({
  booking,
  contacts,
  isOnSite,
  lineLoginEnabled,
  joinBusy,
  joinError,
  onJoin,
  onHome,
}: {
  booking: SubmittedBooking;
  contacts: ContactLinks;
  isOnSite: boolean;
  lineLoginEnabled: boolean;
  joinBusy: boolean;
  joinError: string | null;
  onJoin: () => void;
  onHome: () => void;
}) {
  const kind = completionKind(booking);
  const accepted = kind === "member_accepted";
  const title = accepted ? "預約成功" : "已送出，等待店家確認";
  const headerTitle = accepted ? "預約成功" : "預約已送出";
  const hasContacts = Boolean(contacts.lineUrl || contacts.telHref);

  return (
    <PublicShell
      header={<TitleOnlyHeader title={headerTitle} />}
      footer={
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          onClick={onHome}
          data-testid="booking-complete-home"
        >
          回店家首頁
        </Button>
      }
    >
      <div className="flex flex-col gap-4 py-2" data-testid="booking-complete" data-kind={kind}>
        <div
          aria-hidden="true"
          className={
            accepted
              ? "mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-soft text-success-strong"
              : "mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warn-soft text-warn-strong"
          }
        >
          {accepted ? (
            <Check className="h-9 w-9" strokeWidth={2.6} />
          ) : (
            <Clock className="h-9 w-9" strokeWidth={2} />
          )}
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold text-foreground" data-testid="booking-complete-title">
            {title}
          </h2>
          <p
            className="mt-1.5 whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground"
            data-testid="booking-complete-message"
          >
            {booking.completionMessage}
          </p>
        </div>

        <section
          className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
          data-testid="booking-complete-summary"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-foreground">預約內容</h3>
            {accepted ? (
              <StatusTag tone="success">已確認</StatusTag>
            ) : (
              <StatusTag tone="warning">待確認</StatusTag>
            )}
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13.5px]">
            <dt className="text-muted-foreground">時間</dt>
            <dd className="tabular-nums text-foreground" data-testid="booking-complete-time">
              {formatSubmittedStart(booking.startAt)}
            </dd>
            <dt className="text-muted-foreground">服務人員</dt>
            <dd className="break-words text-foreground" data-testid="booking-complete-staff">
              {booking.staffDisplay ?? "由店家安排"}
            </dd>
            <dt className="text-muted-foreground">項目</dt>
            <dd className="break-words text-foreground">{formatSubmittedItems(booking.items)}</dd>
            {booking.address ? (
              <>
                <dt className="text-muted-foreground">地址</dt>
                <dd className="break-words text-foreground">{booking.address}</dd>
              </>
            ) : null}
            {booking.isGuest && booking.phone ? (
              <>
                <dt className="text-muted-foreground">電話</dt>
                <dd className="tabular-nums text-foreground" data-testid="booking-complete-phone">
                  {booking.phone}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">預估金額</dt>
            <dd className="font-semibold tabular-nums text-destructive/80">
              {formatPublicPrice(booking.estimatedAmount)}
            </dd>
          </dl>
          {isOnSite ? (
            <p
              className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground"
              data-testid="booking-complete-onsite-note"
            >
              預約時間為預計抵達時間，可能因交通稍有誤差，可與店家確認。
            </p>
          ) : null}
        </section>

        {booking.isGuest && lineLoginEnabled ? (
          <section
            className="flex flex-col gap-2.5 rounded-xl border border-[#06C755]/35 bg-[#06C755]/[0.08] p-3.5"
            data-testid="booking-complete-join"
          >
            <div>
              <p className="text-[15px] font-semibold text-foreground">加入會員，下次預約更快</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                用 LINE
                登入加入會員，下次預約不用再填電話；這筆預約之後會出現在會員中心（即將推出）。
              </p>
            </div>
            {joinError ? (
              <AlertNote tone="danger" data-testid="booking-complete-join-error">
                {joinError}
              </AlertNote>
            ) : null}
            <Button
              type="button"
              className={LINE_GREEN_BUTTON_CLASS}
              onClick={onJoin}
              disabled={joinBusy}
              data-testid="booking-complete-join-button"
            >
              <LineIcon className="!size-6" />
              {joinBusy ? "前往 LINE⋯" : "用 LINE 登入加入會員"}
            </Button>
          </section>
        ) : null}

        <section
          className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 shadow-sm"
          data-testid="booking-complete-contact"
        >
          <p className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground">
            <CalendarCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            {CANCEL_OR_RESCHEDULE_TEXT}
          </p>
          {hasContacts ? <ContactButtons links={contacts} /> : null}
        </section>
      </div>
    </PublicShell>
  );
}
