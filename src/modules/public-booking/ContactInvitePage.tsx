// 客戶端第 4 批 4-B(#1041,C4-H06 / H07):聯絡人邀請落地頁 `/booking/<代碼>/invite/<邀請碼>`。
//
// 做的事(順序不能變):
//   1. 第一次 render 前就把邀請碼從網址列拿掉(history.replaceState ⇒ `/booking/<代碼>/invite`,C4-F04),
//      邀請碼只留在這個分頁的記憶體(重新整理就沒了 ⇒ 請客人重新打開邀請連結)。
//   2. 問伺服器這個邀請還有沒有效(customer_peek_contact_invite;只回 valid / invalid + 店名,不回會員姓名)。
//   3. 沒登入 ⇒「你被邀請成為『店名』會員的聯絡人」+「用 LINE 登入並加入」
//      (customer-line-login start 帶 purpose:'invite'、invite_token;邀請碼存在伺服器的 attempt 列)。
//   4. 用 LINE 登入了 ⇒ 勾同意 +「你的電話(選填)」+「加入」⇒ customer_accept_contact_invite
//      ⇒ linked 到會員中心首頁;已經是別的會員的聯絡人 / 額滿 / 無效 ⇒ 固定句子。
//      從 LINE 登入回來時伺服器已把邀請保留給這個 LINE 帳號(c4-contract B4-4)⇒ p_token 傳 null。
// 不套後台外殼;主題色跟著這間店;店名、LINE 名稱一律純文字。

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import {
  AlertNote,
  ErrorState,
  FieldInput,
  FormField,
  LoadingSkeleton,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { applyThemeColorToDocument, resolveMerchantThemeColor } from "@/modules/merchant/theme";

import { fetchPublicBookingPage, PublicBookingError } from "./api";
import {
  CustomerAuthError,
  customerSessionQueryKey,
  fetchCustomerSessionState,
  redirectToAuthorizeUrl,
  signOutCustomer,
  startLineInvite,
} from "./customerAuthApi";
import {
  customerPhoneError,
  isAllowedAuthorizeUrl,
  lineStartErrorMessage,
  rememberLoginOrigin,
  rememberLoginSlug,
  safeImageUrl,
  takePendingDraft,
} from "./customerLoginLogic";
import { ConsentBox, LINE_GREEN_BUTTON_CLASS, LineAvatar } from "./CustomerLoginScreens";
import { MemberCenterError, memberCenterQueryKey } from "./memberCenterApi";
import { memberCenterPath } from "./memberCenterLogic";
import { acceptContactInvite, peekContactInvite } from "./memberContactsApi";
import {
  acceptInviteErrorMessage,
  ALREADY_MEMBER_ELSEWHERE_MESSAGE,
  captureInviteTokenFromLocation,
  clearPendingInvite,
  INVITE_BODY,
  INVITE_CONTACT_LIMIT_MESSAGE,
  INVITE_INVALID_MESSAGE,
  INVITE_MISSING_MESSAGE,
  INVITE_PHONE_HELP,
  INVITE_TITLE,
  invitePath,
  MY_PHONE_IN_USE_MESSAGE,
  peekPendingInvite,
  type PendingInvite,
} from "./memberContactsLogic";
import { ContactButtons, LineIcon, PublicShell, TitleOnlyHeader } from "./PublicBookingChrome";
import { merchantLogoText, resolveContactLinks } from "./publicBookingLogic";
import type { PublicBookingPageOk } from "./types";

const PAGE_QUERY_KEY = (slug: string) => ["public-booking", "page", slug] as const;

export default function ContactInvitePage() {
  const { slug: rawSlug = "" } = useParams();
  const slug = rawSlug.trim().toLowerCase();
  const navigate = useNavigate();
  // 1. 第一次 render 前抓邀請碼並從網址列拿掉(React 開發模式跑兩次時,第二次從記憶體拿)。
  const [pending] = useState<PendingInvite | null>(() => {
    const fromUrl = captureInviteTokenFromLocation(slug);
    return fromUrl ? { kind: "token", token: fromUrl } : peekPendingInvite(slug);
  });
  // 讓路由也知道網址換了(replaceState 不會通知 React Router)。
  useEffect(() => {
    if (window.location.pathname !== invitePath(slug)) return;
    navigate(invitePath(slug), { replace: true });
  }, [navigate, slug]);

  const pageQuery = useQuery({
    queryKey: PAGE_QUERY_KEY(slug),
    queryFn: () => fetchPublicBookingPage(slug),
    retry: (count, err) =>
      !(err instanceof PublicBookingError && err.kind === "rate_limited") && count < 1,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const okPage = pageQuery.data?.status === "ok" ? pageQuery.data : null;

  useEffect(() => {
    applyThemeColorToDocument(okPage ? resolveMerchantThemeColor(okPage.merchant) : null);
  }, [okPage?.merchant.theme_preset, okPage?.merchant.theme_custom_color]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyThemeColorToDocument(null), []);

  if (pageQuery.isPending) {
    return (
      <PublicShell header={<div className="h-[54px]" />}>
        <div data-testid="contact-invite-loading">
          <LoadingSkeleton variant="lines" rows={3} />
        </div>
      </PublicShell>
    );
  }
  if (pageQuery.isError) {
    return (
      <PublicShell header={<TitleOnlyHeader title="聯絡人邀請" />}>
        <ErrorState
          title="讀取失敗，請稍後再試"
          reason="可能是網路不穩"
          onRetry={() => void pageQuery.refetch()}
          retryLabel="重新整理"
        />
      </PublicShell>
    );
  }
  if (!okPage || !okPage.booking_settings.line_login_enabled) {
    return <InviteMessage page={okPage} slug={slug} message={INVITE_INVALID_MESSAGE} />;
  }
  if (!pending) {
    return <InviteMessage page={okPage} slug={slug} message={INVITE_MISSING_MESSAGE} />;
  }
  if (pending.kind === "claimed" && !pending.valid) {
    return <InviteMessage page={okPage} slug={slug} message={INVITE_INVALID_MESSAGE} />;
  }
  return <InviteFlow page={okPage} slug={slug} pending={pending} />;
}

/** 無效 / 找不到邀請碼:一句話 + 聯絡按鈕 +「回店家首頁」。 */
function InviteMessage({
  page,
  slug,
  message,
}: {
  page: PublicBookingPageOk | null;
  slug: string;
  message: string;
}) {
  const navigate = useNavigate();
  return (
    <PublicShell header={<TitleOnlyHeader title={page?.merchant.name ?? "聯絡人邀請"} />}>
      <div
        className="mx-auto mt-6 flex max-w-sm flex-col gap-4 rounded-xl border border-border bg-card px-5 py-8 text-center shadow-sm"
        data-testid="contact-invite-invalid"
      >
        <p className="text-[15px] leading-relaxed text-foreground">{message}</p>
        {page ? <ContactButtons links={resolveContactLinks(page.merchant)} /> : null}
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          onClick={() => navigate(`/booking/${slug}`)}
        >
          回店家首頁
        </Button>
      </div>
    </PublicShell>
  );
}

function InviteFlow({
  page,
  slug,
  pending,
}: {
  page: PublicBookingPageOk;
  slug: string;
  pending: PendingInvite;
}) {
  const queryClient = useQueryClient();
  const token = pending.kind === "token" ? pending.token : null;
  // 從 LINE 登入回來(claimed)不用再查:伺服器 complete 時已經查過、而且保留給這個帳號了。
  const peekQuery = useQuery({
    queryKey: ["public-booking", "invite-peek", slug, token],
    queryFn: () =>
      token
        ? peekContactInvite(slug, token)
        : Promise.resolve({ state: "valid" as const, merchantName: null }),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const sessionQuery = useQuery({
    queryKey: customerSessionQueryKey(slug),
    queryFn: () => fetchCustomerSessionState(slug),
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const [forcedInvalid, setForcedInvalid] = useState(false);

  if (peekQuery.isPending || sessionQuery.isPending) {
    return (
      <PublicShell header={<TitleOnlyHeader title={page.merchant.name} />}>
        <div data-testid="contact-invite-loading">
          <LoadingSkeleton variant="lines" rows={3} />
        </div>
      </PublicShell>
    );
  }
  if (peekQuery.isError || sessionQuery.isError) {
    const rateLimited =
      peekQuery.error instanceof MemberCenterError && peekQuery.error.code === "rate_limited";
    return (
      <PublicShell header={<TitleOnlyHeader title={page.merchant.name} />}>
        <ErrorState
          title={rateLimited ? "操作太頻繁，請稍後再試" : "讀取失敗，請稍後再試"}
          reason={rateLimited ? "短時間內查詢次數太多，等幾分鐘再按重新整理" : "可能是網路不穩"}
          onRetry={() => {
            void peekQuery.refetch();
            void sessionQuery.refetch();
          }}
          retryLabel="重新整理"
        />
      </PublicShell>
    );
  }
  if (forcedInvalid || peekQuery.data.state === "invalid") {
    return <InviteMessage page={page} slug={slug} message={INVITE_INVALID_MESSAGE} />;
  }

  const session = sessionQuery.data;
  if (session.state === "anonymous") {
    // 從 LINE 登入回來卻沒有登入狀態(不應該發生)⇒ 請客人重新打開連結。
    if (!token) return <InviteMessage page={page} slug={slug} message={INVITE_MISSING_MESSAGE} />;
    return <InviteLanding page={page} slug={slug} token={token} />;
  }
  const lineName = session.state === "linked" ? null : session.lineDisplayName;
  const linePicture = session.state === "linked" ? null : session.linePictureUrl;
  return (
    <InviteAccept
      page={page}
      slug={slug}
      token={token}
      lineDisplayName={lineName}
      linePictureUrl={linePicture}
      onInvalid={() => setForcedInvalid(true)}
      onSignedOut={async () => {
        await signOutCustomer(slug);
        queryClient.setQueryData(customerSessionQueryKey(slug), { state: "anonymous" });
      }}
    />
  );
}

/** C4-H06 沒登入:邀請說明 +「用 LINE 登入並加入」。 */
function InviteLanding({
  page,
  slug,
  token,
}: {
  page: PublicBookingPageOk;
  slug: string;
  token: string;
}) {
  const { merchant } = page;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logo = safeImageUrl(merchant.logo_url);

  async function handleLogin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await startLineInvite(slug, token);
      if (!isAllowedAuthorizeUrl(url, window.location.origin)) {
        setError(lineStartErrorMessage(null));
        setBusy(false);
        return;
      }
      rememberLoginSlug(slug);
      rememberLoginOrigin(null);
      redirectToAuthorizeUrl(url);
    } catch (err) {
      const code = err instanceof CustomerAuthError ? err.code : null;
      setError(code === "invalid_invite" ? INVITE_INVALID_MESSAGE : lineStartErrorMessage(code));
      setBusy(false);
    }
  }

  return (
    <PublicShell header={<TitleOnlyHeader title={merchant.name} />}>
      <div
        className="mx-auto flex min-h-[60dvh] max-w-sm flex-col justify-center gap-[18px] py-6 text-center"
        data-testid="contact-invite-landing"
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
          <h2 className="break-words text-xl font-bold text-foreground">
            {INVITE_TITLE(merchant.name)}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{INVITE_BODY}</p>
        </div>
        {error ? (
          <AlertNote tone="danger" className="text-left" data-testid="contact-invite-error">
            {error}
          </AlertNote>
        ) : null}
        <Button
          type="button"
          className={LINE_GREEN_BUTTON_CLASS}
          onClick={() => void handleLogin()}
          disabled={busy}
          data-testid="contact-invite-login"
        >
          <LineIcon className="!size-6" />
          {busy ? "前往 LINE⋯" : "用 LINE 登入並加入"}
        </Button>
      </div>
    </PublicShell>
  );
}

/** C4-H07 已登入:同意 + 電話(選填)+「加入」。 */
function InviteAccept({
  page,
  slug,
  token,
  lineDisplayName,
  linePictureUrl,
  onInvalid,
  onSignedOut,
}: {
  page: PublicBookingPageOk;
  slug: string;
  token: string | null;
  lineDisplayName: string | null;
  linePictureUrl: string | null;
  onInvalid: () => void;
  onSignedOut: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { merchant } = page;
  const contacts = resolveContactLinks(merchant);
  const [agree, setAgree] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const done = useRef(false);

  const phoneError = phone.trim() === "" ? null : customerPhoneError(phone);

  async function handleAccept() {
    setPhoneTouched(true);
    setError(null);
    if (!agree || phoneError || busy || done.current) return;
    setBusy(true);
    try {
      const result = await acceptContactInvite({ slug, token, phone, agreePolicy: agree });
      if (result.state === "linked") {
        done.current = true;
        clearPendingInvite(slug);
        // 登入回來頁留下的「登入成功」標記拿掉,會員中心才不會再跳一次「已登入」。
        takePendingDraft(slug);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: customerSessionQueryKey(slug) }),
          queryClient.removeQueries({ queryKey: memberCenterQueryKey(slug) }),
        ]);
        toast.success(`已加入「${merchant.name}」會員`);
        if (result.phoneResult === "in_use") toast(MY_PHONE_IN_USE_MESSAGE);
        navigate(memberCenterPath(slug), { replace: true });
        return;
      }
      if (result.state === "already_member_elsewhere") {
        setBlockedMessage(ALREADY_MEMBER_ELSEWHERE_MESSAGE);
        return;
      }
      if (result.state === "contact_limit") {
        setBlockedMessage(INVITE_CONTACT_LIMIT_MESSAGE);
        return;
      }
      if (result.state === "not_linked") {
        await onSignedOut();
        return;
      }
      clearPendingInvite(slug);
      onInvalid();
    } catch (err) {
      setError(acceptInviteErrorMessage(err instanceof MemberCenterError ? err.code : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell
      header={<TitleOnlyHeader title={merchant.name} />}
      footer={
        blockedMessage ? null : (
          <>
            {!agree ? (
              <AlertNote data-testid="contact-invite-blocked">請先勾選同意，才能加入。</AlertNote>
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="w-full"
              disabled={!agree || busy}
              onClick={() => void handleAccept()}
              data-testid="contact-invite-accept"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {busy ? "處理中⋯" : "加入"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4" data-testid="contact-invite-accept-screen">
        <div>
          <h2 className="break-words text-lg font-bold text-foreground">
            {INVITE_TITLE(merchant.name)}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{INVITE_BODY}</p>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm">
          <LineAvatar name={lineDisplayName} pictureUrl={linePictureUrl} />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] font-semibold text-foreground">
              {lineDisplayName ?? "已用 LINE 登入"}
            </p>
            <button
              type="button"
              className="cursor-pointer text-xs text-brand underline-offset-2 hover:underline"
              onClick={() => void onSignedOut()}
              data-testid="contact-invite-switch"
            >
              不是你？改用其他 LINE 帳號
            </button>
          </div>
        </div>

        {blockedMessage ? (
          <div className="flex flex-col gap-2.5" data-testid="contact-invite-blocked-result">
            <AlertNote>{blockedMessage}</AlertNote>
            <ContactButtons links={contacts} />
            <Button
              type="button"
              variant="neutral"
              size="touch"
              className="w-full"
              onClick={() => navigate(memberCenterPath(slug))}
            >
              前往會員中心
            </Button>
          </div>
        ) : (
          <>
            <FormField
              label="你的電話（選填）"
              htmlFor="contact-invite-phone"
              error={phoneTouched ? phoneError : null}
            >
              <FieldInput
                id="contact-invite-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                className="tabular-nums"
                placeholder="0912-345-678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={() => setPhoneTouched(true)}
              />
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                {INVITE_PHONE_HELP}
              </p>
            </FormField>
            <ConsentBox
              checked={agree}
              onChange={setAgree}
              policy={page.member_policy}
              merchantName={merchant.name}
              lead="我已閱讀並同意"
              testId="contact-invite-consent"
            />
            {error ? (
              <AlertNote tone="danger" data-testid="contact-invite-accept-error">
                {error}
              </AlertNote>
            ) : null}
          </>
        )}
      </div>
    </PublicShell>
  );
}
