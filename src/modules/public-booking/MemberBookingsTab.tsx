// 客戶端第 4 批 4-A(C4-C04、C4-D06):會員中心「我的預約」(⑨-1 即將到來、⑨-3 歷史紀錄、⑨-2 取消確認窗)。
//
// ・分頁用網址 `?tab=history`(系統上一頁可以回上一個分頁;C4-B05)。
// ・卡片上的「能不能取消」只看伺服器回的 can_cancel(C4-D01:看得到按鈕 = 取消得了),前端不自己算期限。
// ・取消走 Edge Function customer-booking-cancel(C4-D03);結果依 state 顯示前端自己的句子(C4-D06)。
// ・取消確認窗用全站確認小卡窗(點遮罩不關,一定要選一顆;「確定取消」白底紅字);關掉後很快又打開要重新掛載
//   (dialogSeq 當 key,ui-overlay-patterns 兩層重疊段最後一點)。

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  ErrorState,
  LoadingSkeleton,
  StatusTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";

import type { MemberCenterContext } from "./MemberCenterPage";
import { cancelMyBooking, fetchMyBookings, memberCenterQueryKey } from "./memberCenterApi";
import {
  CANCEL_CONFIRM_BODY,
  cancelAreaView,
  cancelConfirmTitle,
  cancelResultView,
  formatMemberBookingItems,
  formatMemberBookingTime,
  isMemberGate,
  memberBookingStatusView,
  parseBookingScope,
  type CancelAreaView,
  type MemberBooking,
  type MemberBookingPage,
  type MemberBookingScope,
} from "./memberCenterLogic";
import { ContactButtons } from "./PublicBookingChrome";
import { formatPublicPrice, type ContactLinks } from "./publicBookingLogic";

/** 到府店的提示句(沿用第 1 批 / 完成頁同一句)。 */
const ON_SITE_NOTE = "預約時間為預計抵達時間，可能因交通稍有誤差，可與店家確認。";

export function MemberBookingsTab({ ctx }: { ctx: MemberCenterContext }) {
  const { slug, page, contacts } = ctx;
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const scope = parseBookingScope(params.get("tab"));
  const deadlineHours = page.booking_settings.customer_cancel_deadline_hours;
  const isOnSite = page.booking_settings.is_on_site;

  const listQuery = useInfiniteQuery({
    queryKey: [...memberCenterQueryKey(slug), "bookings", scope],
    queryFn: ({ pageParam }) => fetchMyBookings(slug, scope, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (isMemberGate(last) ? null : last.nextCursor),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const pages = listQuery.data?.pages ?? [];
  const gate = pages.find(isMemberGate) ?? null;
  const okPages = pages.filter((p): p is MemberBookingPage => !isMemberGate(p));
  const items = okPages.flatMap((p) => p.items);
  const counts = okPages[0]?.counts ?? null;

  const [notice, setNotice] = useState<{ message: string; showContacts: boolean } | null>(null);
  const [target, setTarget] = useState<MemberBooking | null>(null);
  const [dialogSeq, setDialogSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // 登入失效 / 被移除 ⇒ 回登入頁(C4-B05)。
  const onSessionLost = ctx.onSessionLost;
  useEffect(() => {
    if (gate?.state === "not_linked") onSessionLost();
  }, [gate, onSessionLost]);

  function switchScope(next: MemberBookingScope) {
    setNotice(null);
    setParams(next === "history" ? { tab: "history" } : {}, { replace: false });
  }

  function openCancel(booking: MemberBooking) {
    setDialogError(null);
    setDialogSeq((n) => n + 1);
    setTarget(booking);
  }

  async function reloadAll() {
    await queryClient.invalidateQueries({ queryKey: memberCenterQueryKey(slug) });
  }

  async function runCancel() {
    if (!target || busy) return;
    setBusy(true);
    setDialogError(null);
    const code = await cancelMyBooking(slug, target.id);
    const view = cancelResultView(code);
    setBusy(false);
    if (view.relogin) {
      setTarget(null);
      ctx.onSessionLost();
      return;
    }
    if (!view.closeDialog) {
      setDialogError(view.message);
      return;
    }
    setTarget(null);
    if (view.toast) toast.success(view.toast);
    setNotice(view.message ? { message: view.message, showContacts: view.showContacts } : null);
    if (view.reload) await reloadAll();
  }

  return (
    <div className="flex flex-col gap-3" data-testid="member-bookings">
      <Tabs value={scope} onValueChange={(v) => switchScope(v as MemberBookingScope)}>
        <UnderlineTabsList variant="filter" aria-label="預約分類">
          <UnderlineTabsTrigger
            value="upcoming"
            count={counts?.upcoming}
            data-testid="member-bookings-tab-upcoming"
          >
            即將到來
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger
            value="history"
            count={counts?.history}
            data-testid="member-bookings-tab-history"
          >
            歷史紀錄
          </UnderlineTabsTrigger>
        </UnderlineTabsList>
      </Tabs>

      {notice ? (
        <div className="flex flex-col gap-2" data-testid="member-bookings-notice">
          <AlertNote>{notice.message}</AlertNote>
          {notice.showContacts ? <ContactButtons links={contacts} /> : null}
        </div>
      ) : null}

      {listQuery.isPending ? (
        <div className="flex flex-col gap-3" data-testid="member-center-loading">
          <LoadingSkeleton variant="cards" rows={2} />
        </div>
      ) : listQuery.isError ? (
        <div data-testid="member-center-error">
          <ErrorState
            title="讀不到預約紀錄"
            reason="可能是網路不穩"
            onRetry={() => void listQuery.refetch()}
            retryLabel="重新整理"
          />
        </div>
      ) : items.length === 0 ? (
        scope === "upcoming" ? (
          <div
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center"
            data-testid="member-bookings-empty"
          >
            <p className="text-[15px] font-semibold text-foreground">目前沒有即將到來的預約</p>
            <Button asChild variant="primary" size="touch">
              <Link to={`/booking/${slug}`}>預約新的服務</Link>
            </Button>
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-[15px] font-semibold text-foreground"
            data-testid="member-bookings-empty"
          >
            還沒有任何紀錄
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-3" data-testid="member-bookings-list">
          {items.map((b) => (
            <li key={b.id}>
              <MemberBookingCard
                booking={b}
                scope={scope}
                deadlineHours={deadlineHours}
                isOnSite={isOnSite}
                contacts={contacts}
                onCancel={() => openCancel(b)}
              />
            </li>
          ))}
        </ul>
      )}

      {listQuery.hasNextPage ? (
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          onClick={() => void listQuery.fetchNextPage()}
          disabled={listQuery.isFetchingNextPage}
          data-testid="member-bookings-more"
        >
          {listQuery.isFetchingNextPage ? "載入中⋯" : "載入更多"}
        </Button>
      ) : null}

      <CardAlertDialog
        key={dialogSeq}
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <CardAlertDialogContent
          data-testid="member-cancel-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>{target ? cancelConfirmTitle(target) : ""}</CardAlertDialogTitle>
            <CardAlertDialogDescription>{CANCEL_CONFIRM_BODY}</CardAlertDialogDescription>
          </CardAlertDialogHeader>
          {dialogError ? (
            <AlertNote tone="danger" data-testid="member-cancel-error">
              {dialogError}
            </AlertNote>
          ) : null}
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={busy} data-testid="member-cancel-keep">
              先不要
            </CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              disabled={busy}
              onClick={(e) => {
                // 送出中不關窗(結果回來再決定要不要關)。
                e.preventDefault();
                void runCancel();
              }}
              data-testid="member-cancel-confirm"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              確定取消
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </div>
  );
}

function MemberBookingCard({
  booking,
  scope,
  deadlineHours,
  isOnSite,
  contacts,
  onCancel,
}: {
  booking: MemberBooking;
  scope: MemberBookingScope;
  deadlineHours: number;
  isOnSite: boolean;
  contacts: ContactLinks;
  onCancel: () => void;
}) {
  const status = memberBookingStatusView(booking.status);
  // 取消區只在「即將到來」顯示(歷史分頁的單都已經開始或結束了)。
  const area: CancelAreaView =
    scope === "upcoming" ? cancelAreaView(booking, deadlineHours) : { kind: "none" };

  return (
    <article
      className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
      data-testid="member-booking-card"
      data-status={booking.status}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="min-w-0 text-base font-semibold tabular-nums text-foreground"
          data-testid="member-booking-time"
        >
          {formatMemberBookingTime(booking.startAt, scope === "history")}
        </span>
        <StatusTag tone={status.tone} className="shrink-0">
          {status.label}
        </StatusTag>
      </div>
      <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13.5px]">
        <dt className="text-muted-foreground">服務人員</dt>
        <dd className="break-words text-foreground">{booking.staffDisplay ?? "由店家安排"}</dd>
        <dt className="text-muted-foreground">項目</dt>
        <dd className="break-words text-foreground">{formatMemberBookingItems(booking.items)}</dd>
        <dt className="text-muted-foreground">金額</dt>
        <dd className="font-semibold tabular-nums text-destructive/80">
          {formatPublicPrice(booking.amount)}
        </dd>
        {booking.pointsRedeemed > 0 ? (
          <>
            <dt className="text-muted-foreground">紅利折抵</dt>
            <dd
              className="tabular-nums text-foreground"
              data-testid="member-booking-points"
            >{`${booking.pointsRedeemed.toLocaleString("en-US")} 點`}</dd>
          </>
        ) : null}
      </dl>
      {booking.bookedBy ? (
        <p
          className="mt-1.5 text-[12.5px] text-muted-foreground"
          data-testid="member-booking-booked-by"
        >{`由 ${booking.bookedBy} 預約`}</p>
      ) : null}
      {isOnSite && scope === "upcoming" && area.kind !== "none" ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{ON_SITE_NOTE}</p>
      ) : null}

      {area.kind === "can_cancel" ? (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span
            className="min-w-0 text-[13px] text-muted-foreground"
            data-testid="member-booking-deadline"
          >
            {area.text}
          </span>
          <Button
            type="button"
            variant="danger"
            size="card"
            className="shrink-0"
            onClick={onCancel}
            data-testid="member-booking-cancel"
          >
            取消預約
          </Button>
        </div>
      ) : area.kind === "contact" ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-[13px] text-muted-foreground" data-testid="member-booking-no-cancel">
            {area.text}
          </p>
          <ContactButtons links={contacts} />
        </div>
      ) : null}
    </article>
  );
}
