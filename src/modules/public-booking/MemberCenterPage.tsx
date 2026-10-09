// 客戶端第 4 批 4-A(C4-B02~B05、C4-C02):會員中心 `/booking/<代碼>/me`(+ /bookings、/wallet、/profile)。
// 規格:.project/specs/客戶端第4批-會員中心與自己取消.md(🔴「零之零」優先);畫面對照預覽圖 ⑧~⑪。
//
// ─── 這一頁的幾個重要決定 ───────────────────────────────────────────────────────────
// ・跟預約頁一樣不套後台外殼、不讀後台目前操作中的商家;店名、主題色、聯絡方式都來自
//   get_public_booking_page(以網址代碼查),離開時把主題色與分頁標題還原。
// ・只開給「有啟用 LINE 登入」的店(零之一第 1 點);其他店打開 /me ⇒「這間店目前沒有開放會員中心」。
// ・登入狀態用「這間店的客戶 client」(customerClient.ts),跟預約頁共用同一份 react-query 快取:
//   沒登入 ⇒ C4-B02 登入頁;用 LINE 登入了、還沒接上會員 ⇒ ⑥-2「加入會員」;接上 ⇒ 會員中心本體。
// ・任何會員中心函式回 not_linked(登入失效 / 被移除)⇒ 登出這間店的客戶 client、回 C4-B02(C4-B05)。
// ・分頁之間是一般網址切換(系統「上一頁」可以回上一個分頁),不用預約頁那套 history state(C4-B05)。
// ・讀取中用灰色骨架、失敗用 ErrorState,不顯示資料庫原文(鐵律 4)。
// ・第 5 批 5-A(C5-M01):首頁「加入店家 LINE 好友」提示卡(MemberLineNotify.tsx),
//   只有店家能用 LINE 通知客人時才出現(不承諾還沒做的功能)。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, ChevronRight, House, UserRound, Wallet } from "lucide-react";

import { AlertNote, ErrorState, LoadingSkeleton, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { applyThemeColorToDocument, resolveMerchantThemeColor } from "@/modules/merchant/theme";

import { fetchPublicBookingPage, PublicBookingError, PUBLIC_RATE_LIMITED_MESSAGE } from "./api";
import {
  CompleteProfileError,
  completeCustomerProfile,
  CustomerAuthError,
  customerSessionQueryKey,
  fetchCustomerSessionState,
  redirectToAuthorizeUrl,
  signOutCustomer,
  startLineJoin,
} from "./customerAuthApi";
import {
  completeProfileErrorMessage,
  isAllowedAuthorizeUrl,
  isSessionInvalidHint,
  lineStartErrorMessage,
  peekPendingDraft,
  rememberLoginOrigin,
  rememberLoginSlug,
  safeImageUrl,
  takePendingDraft,
  type CustomerSessionState,
} from "./customerLoginLogic";
import {
  CustomerProfileScreen,
  JoinPendingScreen,
  LINE_GREEN_BUTTON_CLASS,
  type ProfileSubmitOutcome,
} from "./CustomerLoginScreens";
import { fetchMemberHome, memberCenterQueryKey } from "./memberCenterApi";
import { cancelMyJoinRequest } from "./memberContactsApi";
import { pendingRequestsTitle } from "./memberContactsLogic";
import {
  formatMemberBookingItems,
  formatMemberBookingTime,
  isMemberGate,
  memberArrivalToast,
  memberBookingStatusView,
  memberCenterPath,
  memberNavItems,
  missingProfileTitle,
  readMissingProfileDismissed,
  resolveMemberCenterView,
  walletVisible,
  writeMissingProfileDismissed,
  type MemberCenterTab,
  type MemberHome,
} from "./memberCenterLogic";
import { MemberBookingsTab } from "./MemberBookingsTab";
import { MemberAddFriendCard } from "./MemberLineNotify";
import { MemberProfileTab } from "./MemberProfileTab";
import { MemberWalletTab } from "./MemberWalletTab";
import { ContactButtons, LineIcon, PublicShell, TitleOnlyHeader } from "./PublicBookingChrome";
import {
  formatPublicPrice,
  merchantLogoText,
  resolveContactLinks,
  type ContactLinks,
} from "./publicBookingLogic";
import type { PublicBookingPageOk } from "./types";

/** 預約頁也用同一個 key(兩邊共用快取)。 */
const PAGE_QUERY_KEY = (slug: string) => ["public-booking", "page", slug] as const;

/** 各分頁共用的資料(由外框交給分頁)。 */
export interface MemberCenterContext {
  slug: string;
  page: PublicBookingPageOk;
  contacts: ContactLinks;
  /** 首頁資料(底部選單決定要不要顯示「錢包」也用它)。 */
  home: MemberHome | null;
  /** 會員中心函式回 not_linked ⇒ 登出、回登入頁。 */
  onSessionLost: () => void;
  onLogout: () => Promise<void>;
}

// =========================================================================
// 路由進入點
// =========================================================================

export default function MemberCenterPage({ tab }: { tab: MemberCenterTab }) {
  const { slug: rawSlug = "" } = useParams();
  const slug = rawSlug.trim().toLowerCase();

  const pageQuery = useQuery({
    queryKey: PAGE_QUERY_KEY(slug),
    queryFn: () => fetchPublicBookingPage(slug),
    retry: (count, err) =>
      !(err instanceof PublicBookingError && err.kind === "rate_limited") && count < 1,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const page = pageQuery.data;
  const okPage = page?.status === "ok" ? page : null;

  // 主題色跟著這間店;離開時還原(同預約頁 C1-A02)。
  useEffect(() => {
    applyThemeColorToDocument(okPage ? resolveMerchantThemeColor(okPage.merchant) : null);
  }, [okPage?.merchant.theme_preset, okPage?.merchant.theme_custom_color]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyThemeColorToDocument(null), []);

  const previousTitle = useRef<string | null>(null);
  useEffect(() => {
    previousTitle.current = document.title;
    return () => {
      if (previousTitle.current !== null) document.title = previousTitle.current;
    };
  }, []);
  useEffect(() => {
    if (okPage) document.title = `${okPage.merchant.name}會員中心`;
    else if (page) document.title = "會員中心";
  }, [okPage?.merchant.name, page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pageQuery.isPending) {
    return (
      <PublicShell header={<div className="h-[54px]" />}>
        <div className="flex flex-col gap-3" data-testid="member-center-loading">
          <LoadingSkeleton variant="lines" rows={3} />
          <LoadingSkeleton variant="cards" rows={2} />
        </div>
      </PublicShell>
    );
  }

  if (pageQuery.isError || !page) {
    const rateLimited =
      pageQuery.error instanceof PublicBookingError && pageQuery.error.kind === "rate_limited";
    return (
      <PublicShell header={<TitleOnlyHeader title="會員中心" />}>
        <div data-testid="member-center-error">
          <ErrorState
            honorific
            title={rateLimited ? PUBLIC_RATE_LIMITED_MESSAGE : "讀取失敗，請稍後再試"}
            reason={rateLimited ? "短時間內查詢次數太多，等幾分鐘再按重新整理" : "可能是網路不穩"}
            onRetry={() => void pageQuery.refetch()}
            retryLabel="重新整理"
          />
        </div>
      </PublicShell>
    );
  }

  const view = resolveMemberCenterView({
    pageStatus: page.status,
    lineLoginEnabled: okPage?.booking_settings.line_login_enabled ?? false,
    session: { state: "anonymous" },
  });
  if (view === "closed" || !okPage) {
    return <ClosedScreen slug={slug} page={okPage} />;
  }
  return <MemberCenterFlow key={slug} page={okPage} slug={slug} tab={tab} />;
}

/** C4-B02 邊界:店家沒啟用 LINE 登入 / 停用 / 找不到 ⇒ 沒有會員中心。 */
function ClosedScreen({ slug, page }: { slug: string; page: PublicBookingPageOk | null }) {
  const navigate = useNavigate();
  const contacts = page ? resolveContactLinks(page.merchant) : null;
  return (
    <PublicShell header={<TitleOnlyHeader title={page?.merchant.name ?? "會員中心"} />}>
      <div
        className="mx-auto mt-6 flex max-w-sm flex-col gap-4 rounded-xl border border-border bg-card px-5 py-8 text-center shadow-sm"
        data-testid="member-center-closed"
      >
        <p className="text-[17px] font-bold text-foreground">這間店目前沒有開放會員中心</p>
        <p className="text-sm text-muted-foreground">如需查詢或取消預約，請直接聯絡店家。</p>
        {contacts ? <ContactButtons links={contacts} /> : null}
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          onClick={() => navigate(`/booking/${slug}`)}
          data-testid="member-center-home-link"
        >
          回店家首頁
        </Button>
      </div>
    </PublicShell>
  );
}

// =========================================================================
// 登入狀態 → 畫面
// =========================================================================

function MemberCenterFlow({
  page,
  slug,
  tab,
}: {
  page: PublicBookingPageOk;
  slug: string;
  tab: MemberCenterTab;
}) {
  const queryClient = useQueryClient();
  const { merchant } = page;
  const contacts = resolveContactLinks(merchant);

  const sessionQuery = useQuery({
    queryKey: customerSessionQueryKey(slug),
    queryFn: () => fetchCustomerSessionState(slug),
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const session: CustomerSessionState | null = sessionQuery.data ?? null;

  // C4-B03:登入回來(沒有草稿)時跳一次提示。標記第一次 render 先看,effect 裡才拿走。
  const [arrival] = useState(() => peekPendingDraft(slug));
  const arrivalHandled = useRef(false);
  useEffect(() => {
    takePendingDraft(slug);
  }, [slug]);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  useEffect(() => {
    if (arrivalHandled.current || arrival?.outcome !== "logged_in") return;
    if (session?.state === "linked") {
      arrivalHandled.current = true;
      toast.success(memberArrivalToast(merchant.name, false));
    }
  }, [arrival, session, merchant.name]);

  const resetToLogin = useCallback(
    async (notice: string | null) => {
      await signOutCustomer(slug);
      queryClient.setQueryData(customerSessionQueryKey(slug), { state: "anonymous" });
      queryClient.removeQueries({ queryKey: memberCenterQueryKey(slug) });
      setLoginNotice(notice);
    },
    [queryClient, slug],
  );
  const handleSessionLost = useCallback(
    () => void resetToLogin("登入狀態已失效，請重新用 LINE 登入。"),
    [resetToLogin],
  );
  const handleLogout = useCallback(() => resetToLogin(null), [resetToLogin]);

  async function handleProfileSubmit(input: {
    phone: string;
    agree: boolean;
  }): Promise<ProfileSubmitOutcome> {
    try {
      const result = await completeCustomerProfile({
        slug,
        phone: input.phone,
        name: "",
        agreePolicy: input.agree,
      });
      if (result.kind === "phone_taken") return "phone_taken";
      if (result.kind === "join_pending") {
        // C4-H04:已送出加入聯絡人申請 ⇒ 重抓登入狀態(變 join_pending)換畫面。
        await queryClient.invalidateQueries({ queryKey: customerSessionQueryKey(slug) });
        return "join_pending";
      }
      arrivalHandled.current = true;
      await queryClient.invalidateQueries({ queryKey: customerSessionQueryKey(slug) });
      toast.success(memberArrivalToast(merchant.name, true));
      return "linked";
    } catch (err) {
      const hint = err instanceof CompleteProfileError ? err.hint : null;
      if (isSessionInvalidHint(hint)) {
        await resetToLogin(completeProfileErrorMessage(hint));
      }
      return { error: completeProfileErrorMessage(hint) };
    }
  }

  if (sessionQuery.isError) {
    return (
      <PublicShell header={<TitleOnlyHeader title={merchant.name} />}>
        <div data-testid="member-center-error">
          <ErrorState
            honorific
            title="讀取失敗，請稍後再試"
            reason="可能是網路不穩"
            onRetry={() => void sessionQuery.refetch()}
            retryLabel="重新整理"
          />
        </div>
      </PublicShell>
    );
  }

  const view = resolveMemberCenterView({
    pageStatus: "ok",
    lineLoginEnabled: true,
    session,
  });

  if (view === "loading") {
    return (
      <PublicShell header={<TitleOnlyHeader title={merchant.name} />}>
        <div className="flex flex-col gap-3" data-testid="member-center-loading">
          <LoadingSkeleton variant="lines" rows={3} />
        </div>
      </PublicShell>
    );
  }

  if (view === "login") {
    return <MemberLoginScreen page={page} slug={slug} notice={loginNotice} />;
  }

  if (view === "profile" && session?.state === "needs_profile") {
    return (
      <CustomerProfileScreen
        merchantName={merchant.name}
        lineDisplayName={session.lineDisplayName}
        linePictureUrl={session.linePictureUrl}
        policy={page.member_policy}
        contacts={contacts}
        allowGuest={false}
        mode="join"
        joinRequest={session.joinRequest ?? null}
        onSubmit={handleProfileSubmit}
        onLogout={() => void resetToLogin(null)}
        onGuest={() => undefined}
      />
    );
  }

  if (view === "join_pending" && session?.state === "join_pending") {
    return (
      <JoinPendingScreen
        lineDisplayName={session.lineDisplayName}
        linePictureUrl={session.linePictureUrl}
        contacts={contacts}
        allowGuest={false}
        onUseOtherPhone={async () => {
          await cancelMyJoinRequest(slug);
          await queryClient.invalidateQueries({ queryKey: customerSessionQueryKey(slug) });
        }}
        onGuest={() => undefined}
        onLogout={() => void resetToLogin(null)}
      />
    );
  }

  return (
    <MemberCenterBody
      page={page}
      slug={slug}
      tab={tab}
      contacts={contacts}
      onSessionLost={handleSessionLost}
      onLogout={handleLogout}
    />
  );
}

// =========================================================================
// C4-B02 會員中心登入頁
// =========================================================================

function MemberLoginScreen({
  page,
  slug,
  notice,
}: {
  page: PublicBookingPageOk;
  slug: string;
  notice: string | null;
}) {
  const navigate = useNavigate();
  const { merchant } = page;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logo = safeImageUrl(merchant.logo_url);

  async function handleLogin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // 第 3 批已有的 purpose:'join'(不帶草稿);回來時登入回來頁依「沒有草稿」送回 /me(C4-B03)。
      const url = await startLineJoin(slug);
      if (!isAllowedAuthorizeUrl(url, window.location.origin)) {
        setError(lineStartErrorMessage(null));
        setBusy(false);
        return;
      }
      rememberLoginSlug(slug);
      rememberLoginOrigin("member_center");
      redirectToAuthorizeUrl(url);
      // 不解除 busy:頁面即將離開,避免客人在跳轉前又按一次。
    } catch (err) {
      setError(lineStartErrorMessage(err instanceof CustomerAuthError ? err.code : null));
      setBusy(false);
    }
  }

  return (
    <PublicShell header={<TitleOnlyHeader title={merchant.name} />}>
      <div
        className="mx-auto flex min-h-[60dvh] max-w-sm flex-col justify-center gap-[18px] py-6 text-center"
        data-testid="member-center-login"
      >
        {logo ? (
          <img
            src={logo}
            alt={`${merchant.name}的標誌`}
            className="mx-auto h-[72px] w-[72px] rounded-[20px] bg-background object-cover shadow-sm"
          />
        ) : (
          <div
            aria-hidden="true"
            className="mx-auto flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-brand text-[22px] font-extrabold text-brand-foreground shadow-sm"
          >
            {merchantLogoText(merchant.name)}
          </div>
        )}
        <div>
          <h2 className="break-words text-xl font-bold text-foreground">{`登入「${merchant.name}」會員中心`}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            用 LINE 登入就能查看預約、取消預約、查看紅利點數。
          </p>
        </div>
        {notice ? (
          <AlertNote className="text-left" data-testid="member-center-login-notice">
            {notice}
          </AlertNote>
        ) : null}
        {error ? (
          <AlertNote tone="danger" className="text-left" data-testid="member-center-login-error">
            {error}
          </AlertNote>
        ) : null}
        <Button
          type="button"
          className={LINE_GREEN_BUTTON_CLASS}
          onClick={() => void handleLogin()}
          disabled={busy}
          data-testid="member-center-login-button"
        >
          <LineIcon className="!size-6" />
          {busy ? "前往 LINE⋯" : "用 LINE 登入"}
        </Button>
        <Button
          type="button"
          variant="text"
          size="touch"
          className="mx-auto"
          onClick={() => navigate(`/booking/${slug}`)}
          data-testid="member-center-home-link"
        >
          回店家首頁
        </Button>
      </div>
    </PublicShell>
  );
}

// =========================================================================
// C4-B05 會員中心外框 + 分頁
// =========================================================================

const NAV_ICONS: Record<MemberCenterTab, ReactNode> = {
  home: <House className="h-[22px] w-[22px]" aria-hidden="true" />,
  bookings: <CalendarDays className="h-[22px] w-[22px]" aria-hidden="true" />,
  wallet: <Wallet className="h-[22px] w-[22px]" aria-hidden="true" />,
  profile: <UserRound className="h-[22px] w-[22px]" aria-hidden="true" />,
};

function MemberCenterBody({
  page,
  slug,
  tab,
  contacts,
  onSessionLost,
  onLogout,
}: {
  page: PublicBookingPageOk;
  slug: string;
  tab: MemberCenterTab;
  contacts: ContactLinks;
  onSessionLost: () => void;
  onLogout: () => Promise<void>;
}) {
  const homeQuery = useQuery({
    queryKey: [...memberCenterQueryKey(slug), "home"],
    queryFn: () => fetchMemberHome(slug),
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });
  const homeResult = homeQuery.data;
  const home = homeResult && !isMemberGate(homeResult) ? homeResult : null;
  const gate = homeResult && isMemberGate(homeResult) ? homeResult : null;

  const lostHandled = useRef(false);
  useEffect(() => {
    if (gate?.state === "not_linked" && !lostHandled.current) {
      lostHandled.current = true;
      onSessionLost();
    }
  }, [gate, onSessionLost]);

  // 底部選單要不要有「錢包」:首頁資料回來之前先不畫選單內容(避免出現又消失)。
  const navReady = home !== null || homeQuery.isError || gate !== null;
  const showWallet = walletVisible(home?.wallet);

  // C4-W01:沒有錢包的店直接打 /me/wallet ⇒ 回 /me。
  if (tab === "wallet" && home !== null && !showWallet) {
    return <Navigate to={memberCenterPath(slug)} replace />;
  }

  const ctx: MemberCenterContext = {
    slug,
    page,
    contacts,
    home,
    onSessionLost,
    onLogout,
  };

  let content: ReactNode;
  if (gate?.state === "unavailable") {
    content = <UnavailableNotice contacts={contacts} />;
  } else if (tab === "bookings") {
    content = <MemberBookingsTab ctx={ctx} />;
  } else if (tab === "wallet") {
    content = <MemberWalletTab ctx={ctx} />;
  } else if (tab === "profile") {
    content = <MemberProfileTab ctx={ctx} />;
  } else if (homeQuery.isError) {
    content = (
      <div data-testid="member-center-error">
        <ErrorState
          honorific
          title="讀不到會員資料"
          reason="可能是網路不穩"
          onRetry={() => void homeQuery.refetch()}
          retryLabel="重新整理"
        />
      </div>
    );
  } else if (!home) {
    content = (
      <div className="flex flex-col gap-3" data-testid="member-center-loading">
        <LoadingSkeleton variant="lines" rows={2} />
        <LoadingSkeleton variant="cards" rows={2} />
      </div>
    );
  } else {
    content = <MemberHomeTab ctx={ctx} home={home} />;
  }

  return (
    <div data-testid="member-center" className="flex min-h-dvh min-w-0 flex-col bg-surface">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex h-[54px] w-full max-w-3xl items-center justify-between gap-2 px-3 sm:px-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-foreground">
              <span>會員中心</span>
              <span className="font-normal text-muted-foreground">{` · ${page.merchant.name}`}</span>
            </h1>
          </div>
          <Button
            asChild
            variant="text"
            size="card"
            className="shrink-0 px-2"
            data-testid="member-center-book-link"
          >
            <Link to={`/booking/${slug}`}>預約新的服務</Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-3 py-3 sm:px-4">{content}</main>
      <nav
        aria-label="會員中心選單"
        className="sticky bottom-0 z-30 border-t border-border bg-background"
        data-testid="member-center-nav"
      >
        <div className="mx-auto flex h-[60px] w-full max-w-3xl pb-[env(safe-area-inset-bottom)]">
          {navReady
            ? memberNavItems(showWallet).map((item) => (
                <NavLink
                  key={item.tab}
                  to={memberCenterPath(slug, item.tab)}
                  end
                  className={({ isActive }) =>
                    cn(
                      "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive && "font-semibold text-brand",
                    )
                  }
                  data-testid={`member-nav-${item.tab}`}
                >
                  {NAV_ICONS[item.tab]}
                  {item.label}
                </NavLink>
              ))
            : null}
        </div>
      </nav>
    </div>
  );
}

function UnavailableNotice({ contacts }: { contacts: ContactLinks }) {
  return (
    <div
      className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-8 text-center shadow-sm"
      data-testid="member-center-unavailable"
    >
      <p className="text-[17px] font-bold text-foreground">這間店目前沒有開放會員中心</p>
      <p className="text-sm text-muted-foreground">如需查詢或取消預約，請直接聯絡店家。</p>
      <ContactButtons links={contacts} />
    </div>
  );
}

// =========================================================================
// C4-C02 首頁(⑧)
// =========================================================================

function MemberHomeTab({ ctx, home }: { ctx: MemberCenterContext; home: MemberHome }) {
  const navigate = useNavigate();
  const { slug } = ctx;
  const next = home.nextBooking;
  // 第二聯絡人不能改會員資料 ⇒ 不出現「補上生日、地址和 Email」提示卡(⚠️ 乙推斷)。
  const missingTitle = home.isPrimary ? missingProfileTitle(home.missing) : null;
  const [missingDismissed, setMissingDismissed] = useState(() => readMissingProfileDismissed(slug));
  const status = next ? memberBookingStatusView(next.status) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="member-home">
      <p
        className="break-words px-0.5 pt-0.5 text-lg font-bold text-foreground"
        data-testid="member-home-greeting"
      >
        {`${home.memberName}，您好`}
      </p>

      {next && status ? (
        <button
          type="button"
          onClick={() => navigate(memberCenterPath(slug, "bookings"))}
          className={cn(
            "flex w-full cursor-pointer flex-col gap-1 rounded-xl border border-l-4 border-border bg-card p-3.5 text-left shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            status.tone === "success" ? "border-l-success" : "border-l-warn",
          )}
          data-testid="member-home-next"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-muted-foreground">最新的預約</span>
            <StatusTag tone={status.tone}>{status.label}</StatusTag>
          </span>
          <span className="text-base font-semibold tabular-nums text-foreground">
            {formatMemberBookingTime(next.startAt, false)}
          </span>
          <span className="break-words text-[13.5px] text-foreground">
            {formatMemberBookingItems(next.items)}
          </span>
          <span className="mt-1 flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 break-words text-muted-foreground">
              {next.staffDisplay ?? "由店家安排"}
            </span>
            <span className="flex shrink-0 items-center gap-1 font-semibold tabular-nums text-foreground">
              {formatPublicPrice(next.amount)}
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
          </span>
        </button>
      ) : (
        <div
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-7 text-center"
          data-testid="member-home-empty"
        >
          <p className="text-[15px] font-semibold text-foreground">目前沒有即將到來的預約</p>
          <Button asChild variant="primary" size="touch">
            <Link to={`/booking/${slug}`}>預約新的服務</Link>
          </Button>
        </div>
      )}

      {home.isPrimary && home.pendingContactRequests > 0 ? (
        // C4-C02:主要聯絡人有待處理申請 ⇒ 黃色提示卡(要你去處理的事,ui-overlay-patterns 二之四待辦)。
        <section
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/50 bg-warn-soft p-3.5"
          data-testid="member-home-requests"
        >
          <p className="min-w-0 text-[15px] font-semibold text-warn-strong">
            {pendingRequestsTitle(home.pendingContactRequests)}
          </p>
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="shrink-0"
            onClick={() => navigate(`${memberCenterPath(slug, "profile")}#contacts`)}
            data-testid="member-home-requests-go"
          >
            去處理
          </Button>
        </section>
      ) : null}

      {missingTitle && !missingDismissed ? (
        <section
          className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
          data-testid="member-home-missing"
        >
          <p className="text-[15px] font-semibold text-foreground">{missingTitle}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
            資料完整一點，店家服務時更方便跟您聯絡。
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button
              type="button"
              variant="neutral"
              size="card"
              className="flex-1"
              onClick={() => {
                writeMissingProfileDismissed(slug);
                setMissingDismissed(true);
              }}
              data-testid="member-home-missing-skip"
            >
              略過
            </Button>
            <Button
              type="button"
              variant="neutral"
              size="card"
              className="flex-1"
              onClick={() => navigate(memberCenterPath(slug, "profile"))}
              data-testid="member-home-missing-go"
            >
              去填寫
            </Button>
          </div>
        </section>
      ) : null}

      <MemberAddFriendCard
        slug={slug}
        merchantName={ctx.page.merchant.name}
        lineNotify={home.lineNotify}
      />

      {next ? (
        <Button asChild variant="primary" size="touch" className="w-full">
          <Link to={`/booking/${slug}`} data-testid="member-home-book">
            預約新的服務
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
