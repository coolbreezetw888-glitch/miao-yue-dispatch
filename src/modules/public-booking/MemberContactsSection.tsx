// 客戶端第 4 批 4-B(#1041,C4-H03 / H05 / H08~H10):「我的資料」裡的「聯絡人」區塊。
//
// ・一位會員(例如一間公司)底下可以有好幾個 LINE 帳號當聯絡人。
// ・主要聯絡人:看全部聯絡人(含電話)、邀請聯絡人(複製連結 / 用 LINE 傳送)、撤銷邀請、
//   處理申請(同意 / 拒絕)、每位第二聯絡人「設為主要聯絡人」「移除」。
// ・第二聯絡人:只看清單(看不到別人的電話)、自己那列「退出」、「我的電話」編輯(C4-H08)。
// ・只有自己一位 ⇒「目前只有你一位聯絡人」+「邀請聯絡人」(個人客戶感覺不到差別)。
// ・移除 / 退出 / 轉移主要都用確認小卡窗(ui-overlay-patterns 三);關掉後很快又打開要重新掛載(dialogSeq)。
// 🔴 LINE 顯示名、電話一律純文字(React 文字節點);頭像只接受 https://(safeImageUrl)。
// 🔴 不承諾第 5 批才有的 LINE 通知(J04)。

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  FieldInput,
  FormField,
  HelpToggle,
  LoadingSkeleton,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { customerPhoneError } from "./customerLoginLogic";
import { LineAvatar } from "./CustomerLoginScreens";
import type { MemberCenterContext } from "./MemberCenterPage";
import { MemberCenterError, memberCenterQueryKey } from "./memberCenterApi";
import { isMemberGate } from "./memberCenterLogic";
import {
  createContactInvite,
  fetchMemberContacts,
  leaveMember,
  removeContact,
  resolveContactRequest,
  revokeContactInvite,
  setMyContactPhone,
  transferPrimary,
  type ContactActionOutcome,
} from "./memberContactsApi";
import {
  contactActionMessage,
  contactErrorMessage,
  contactsSectionMode,
  formatContactDate,
  formatInviteExpiry,
  inviteBlockedReason,
  inviteShareText,
  LEAVE_CONFIRM_TEXT,
  LEAVE_PRIMARY_BLOCKED,
  lineShareUrl,
  MY_PHONE_HELP,
  MY_PHONE_IN_USE_MESSAGE,
  MY_PHONE_SAME_AS_MEMBER_NOTE,
  removeContactConfirmText,
  resolveRequestMessage,
  SOLO_CONTACT_TEXT,
  transferPrimaryConfirmText,
  type MemberContact,
  type MemberContactsView,
} from "./memberContactsLogic";

type Confirm =
  | { kind: "remove"; contact: MemberContact }
  | { kind: "transfer"; contact: MemberContact }
  | { kind: "leave" };

export function MemberContactsSection({
  ctx,
  memberName,
}: {
  ctx: MemberCenterContext;
  /** 會員姓名(邀請訊息用)。 */
  memberName: string;
}) {
  const { slug, page } = ctx;
  const queryClient = useQueryClient();
  const location = useLocation();
  const sectionRef = useRef<HTMLElement | null>(null);

  const contactsQuery = useQuery({
    queryKey: [...memberCenterQueryKey(slug), "contacts"],
    queryFn: () => fetchMemberContacts(slug),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const result = contactsQuery.data;
  const gate = result && isMemberGate(result) ? result : null;
  const view = result && !isMemberGate(result) ? result : null;

  const onSessionLost = ctx.onSessionLost;
  useEffect(() => {
    if (gate?.state === "not_linked") onSessionLost();
  }, [gate, onSessionLost]);

  // 首頁「去處理」帶 #contacts 過來 ⇒ 資料回來後捲到這一區。
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !view || location.hash !== "#contacts") return;
    scrolled.current = true;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, [view, location.hash]);

  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dialogSeq, setDialogSeq] = useState(0);
  const [dialogError, setDialogError] = useState<string | null>(null);

  async function reload() {
    await queryClient.invalidateQueries({ queryKey: memberCenterQueryKey(slug) });
  }

  /** 共用:執行一個動作 ⇒ 依結果顯示句子 / 回登入頁 / 重抓。回傳 true = 成功。 */
  async function run(
    key: string,
    fn: () => Promise<ContactActionOutcome>,
    messageFor: (state: string) => string | null,
  ): Promise<boolean> {
    if (busyKey) return false;
    setBusyKey(key);
    setNotice(null);
    try {
      const outcome = await fn();
      if (isMemberGate(outcome)) {
        if (outcome.state === "not_linked") onSessionLost();
        else setNotice("這間店目前沒有開放會員中心，請直接聯絡店家。");
        return false;
      }
      const message = messageFor(outcome.state);
      if (message) {
        setNotice(message);
        await reload();
        return false;
      }
      return true;
    } catch (err) {
      setNotice(contactErrorMessage(err instanceof MemberCenterError ? err.code : null));
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  async function handleInvite() {
    if (busyKey) return;
    setBusyKey("invite");
    setNotice(null);
    try {
      const outcome = await createContactInvite(slug);
      if (isMemberGate(outcome)) {
        if (outcome.state === "not_linked") onSessionLost();
        else setNotice("這間店目前沒有開放會員中心，請直接聯絡店家。");
        return;
      }
      if (outcome.state !== "ok") {
        setNotice(contactActionMessage(outcome.state));
        return;
      }
      setInvite({ url: outcome.url, expiresAt: outcome.expiresAt });
      await reload();
    } catch (err) {
      setNotice(contactErrorMessage(err instanceof MemberCenterError ? err.code : null));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleResolve(requestId: string, approve: boolean) {
    const ok = await run(
      `request-${requestId}`,
      () => resolveContactRequest(slug, requestId, approve),
      (state) => resolveRequestMessage(state, approve),
    );
    if (ok) {
      toast.success(approve ? "已同意，對方已加入成為聯絡人" : "已拒絕這筆申請");
      await reload();
    }
  }

  async function handleRevoke(inviteId: string) {
    const ok = await run(
      `invite-${inviteId}`,
      () => revokeContactInvite(slug, inviteId),
      contactActionMessage,
    );
    if (ok) {
      toast.success("已撤銷邀請連結");
      setInvite(null);
      await reload();
    }
  }

  function openConfirm(next: Confirm) {
    setDialogError(null);
    setDialogSeq((n) => n + 1);
    setConfirm(next);
  }

  async function runConfirm() {
    if (!confirm || busyKey) return;
    setDialogError(null);
    setBusyKey("confirm");
    let outcome: ContactActionOutcome;
    try {
      outcome =
        confirm.kind === "remove"
          ? await removeContact(slug, confirm.contact.id)
          : confirm.kind === "transfer"
            ? await transferPrimary(slug, confirm.contact.id)
            : await leaveMember(slug);
    } catch (err) {
      setBusyKey(null);
      setDialogError(contactErrorMessage(err instanceof MemberCenterError ? err.code : null));
      return;
    }
    setBusyKey(null);
    if (isMemberGate(outcome)) {
      setConfirm(null);
      if (outcome.state === "not_linked") onSessionLost();
      else setNotice("這間店目前沒有開放會員中心，請直接聯絡店家。");
      return;
    }
    const message = contactActionMessage(outcome.state);
    const kind = confirm.kind;
    setConfirm(null);
    if (message) {
      setNotice(message);
      await reload();
      return;
    }
    if (kind === "leave") {
      // C4-H10:退出 ⇒ 這個 LINE 已經不是這位會員的聯絡人,等於登出(回會員中心登入頁)。
      toast.success("已退出這位會員的聯絡人");
      await ctx.onLogout();
      return;
    }
    toast.success(kind === "remove" ? "已移除這位聯絡人" : "已轉移主要聯絡人");
    await reload();
  }

  let body;
  if (contactsQuery.isPending) {
    body = <LoadingSkeleton variant="lines" rows={3} />;
  } else if (contactsQuery.isError) {
    body = (
      <ErrorState
        title="讀不到聯絡人"
        reason="可能是網路不穩"
        onRetry={() => void contactsQuery.refetch()}
        retryLabel="重新整理"
      />
    );
  } else if (view) {
    body = (
      <ContactsBody
        slug={slug}
        view={view}
        busyKey={busyKey}
        invite={invite}
        shareText={(url) => inviteShareText(page.merchant.name, memberName, url)}
        onInvite={() => void handleInvite()}
        onRevoke={(id) => void handleRevoke(id)}
        onResolve={(id, approve) => void handleResolve(id, approve)}
        onConfirm={openConfirm}
        onPhoneSaved={() => void reload()}
        onSessionLost={onSessionLost}
      />
    );
  } else {
    body = null;
  }

  const confirmTitle =
    confirm?.kind === "remove"
      ? "移除聯絡人"
      : confirm?.kind === "transfer"
        ? "轉移主要聯絡人"
        : "退出聯絡人";
  const confirmText =
    confirm?.kind === "remove"
      ? removeContactConfirmText(confirm.contact.lineDisplayName)
      : confirm?.kind === "transfer"
        ? transferPrimaryConfirmText(confirm.contact.lineDisplayName)
        : LEAVE_CONFIRM_TEXT;
  const confirmAction =
    confirm?.kind === "remove" ? "移除" : confirm?.kind === "transfer" ? "確定轉移" : "確定退出";

  return (
    <section
      id="contacts"
      ref={sectionRef}
      className="flex scroll-mt-16 flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-sm"
      data-testid="member-contacts"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h2 className="text-[15px] font-bold text-foreground">聯絡人</h2>
        <HelpToggle label="說明：聯絡人是什麼">
          {
            "一位會員可以有好幾個 LINE 帳號當聯絡人（例如公司的幾位同事、家人），大家可以一起查看預約、取消預約、查看紅利點數。主要聯絡人可以修改會員資料、邀請或移除其他聯絡人。"
          }
        </HelpToggle>
      </div>
      {notice ? <AlertNote data-testid="member-contacts-notice">{notice}</AlertNote> : null}
      {body}

      <CardAlertDialog
        key={dialogSeq}
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey) setConfirm(null);
        }}
      >
        <CardAlertDialogContent
          data-testid="member-contacts-confirm"
          onEscapeKeyDown={(e) => {
            if (busyKey) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>{confirmTitle}</CardAlertDialogTitle>
            <CardAlertDialogDescription>{confirmText}</CardAlertDialogDescription>
          </CardAlertDialogHeader>
          {dialogError ? (
            <AlertNote tone="danger" data-testid="member-contacts-confirm-error">
              {dialogError}
            </AlertNote>
          ) : null}
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={busyKey !== null}>先不要</CardAlertDialogCancel>
            {/* 主腦 10/9(QA 低-3):「移除」會連帶封鎖對方 ⇒ 危險樣式(白底紅字淡紅框);退出 / 轉移維持主要。 */}
            <CardAlertDialogAction
              tone={confirm?.kind === "remove" ? "danger" : "primary"}
              disabled={busyKey !== null}
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
              data-testid="member-contacts-confirm-ok"
            >
              {busyKey === "confirm" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {confirmAction}
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </section>
  );
}

function ContactsBody({
  slug,
  view,
  busyKey,
  invite,
  shareText,
  onInvite,
  onRevoke,
  onResolve,
  onConfirm,
  onPhoneSaved,
  onSessionLost,
}: {
  slug: string;
  view: MemberContactsView;
  busyKey: string | null;
  invite: { url: string; expiresAt: string | null } | null;
  shareText: (url: string) => string;
  onInvite: () => void;
  onRevoke: (inviteId: string) => void;
  onResolve: (requestId: string, approve: boolean) => void;
  onConfirm: (confirm: Confirm) => void;
  onPhoneSaved: () => void;
  onSessionLost: () => void;
}) {
  const mode = contactsSectionMode(view);
  const blocked = inviteBlockedReason(view);
  const me = view.contacts.find((c) => c.isMe) ?? null;
  const others = view.contacts.filter((c) => !c.isMe).length;

  const inviteButton = view.isPrimary ? (
    <div className="flex flex-col gap-2">
      {blocked ? (
        <AlertNote data-testid="member-contacts-invite-blocked">{blocked}</AlertNote>
      ) : null}
      <Button
        type="button"
        variant="neutral"
        size="touch"
        className="w-full"
        disabled={blocked !== null || busyKey !== null}
        onClick={onInvite}
        data-testid="member-contacts-invite"
      >
        {busyKey === "invite" ? "產生中⋯" : "邀請聯絡人"}
      </Button>
      {invite ? <InvitePanel invite={invite} message={shareText(invite.url)} /> : null}
    </div>
  ) : null;

  if (mode === "solo") {
    return (
      <div className="flex flex-col gap-3" data-testid="member-contacts-solo">
        <p className="text-sm text-muted-foreground">{SOLO_CONTACT_TEXT}</p>
        {inviteButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`member-contacts-${mode}`}>
      <ul className="flex flex-col divide-y divide-border" data-testid="member-contacts-list">
        {view.contacts.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 py-2.5" data-testid="member-contact-row">
            <div className="flex items-center gap-3">
              <LineAvatar name={c.lineDisplayName} pictureUrl={c.linePictureUrl} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="break-words text-[15px] font-semibold text-foreground">
                    {c.lineDisplayName}
                  </span>
                  {c.isPrimary ? <StatusTag tone="success">主要聯絡人</StatusTag> : null}
                  {c.isMe ? <span className="text-xs text-muted-foreground">（你）</span> : null}
                </p>
                <p className="text-[12.5px] tabular-nums text-muted-foreground">
                  {[c.contactPhone, c.joinedAt ? `${formatContactDate(c.joinedAt)}加入` : null]
                    .filter(Boolean)
                    .join("・")}
                </p>
              </div>
            </div>
            {view.isPrimary && !c.isMe ? (
              <div className="flex gap-2 pl-12">
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="flex-1"
                  disabled={busyKey !== null}
                  onClick={() => onConfirm({ kind: "transfer", contact: c })}
                  data-testid="member-contact-transfer"
                >
                  設為主要聯絡人
                </Button>
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="flex-1"
                  disabled={busyKey !== null}
                  onClick={() => onConfirm({ kind: "remove", contact: c })}
                  data-testid="member-contact-remove"
                >
                  移除
                </Button>
              </div>
            ) : null}
            {c.isMe && !c.isPrimary ? (
              <div className="pl-12">
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  disabled={busyKey !== null}
                  onClick={() => onConfirm({ kind: "leave" })}
                  data-testid="member-contact-leave"
                >
                  退出
                </Button>
              </div>
            ) : null}
            {c.isMe && c.isPrimary && others > 0 ? (
              <div className="flex flex-col gap-2 pl-12">
                <AlertNote data-testid="member-contact-leave-blocked">
                  {LEAVE_PRIMARY_BLOCKED}
                </AlertNote>
                <Button type="button" variant="neutral" size="card" className="self-start" disabled>
                  退出
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {view.requests.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="member-contacts-requests">
          <p className="text-[13px] font-semibold text-foreground">想加入的人</p>
          {view.requests.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-warn-soft p-3"
              data-testid="member-contact-request"
            >
              <div className="flex items-center gap-3">
                <LineAvatar name={r.lineDisplayName} pictureUrl={r.linePictureUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold text-foreground">
                    {r.lineDisplayName}
                  </p>
                  <p className="text-[12.5px] tabular-nums text-muted-foreground">
                    {[r.phone, r.createdAt ? `${formatContactDate(r.createdAt)}申請` : null]
                      .filter(Boolean)
                      .join("・")}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="flex-1"
                  disabled={busyKey !== null}
                  onClick={() => onResolve(r.id, false)}
                  data-testid="member-contact-request-reject"
                >
                  拒絕
                </Button>
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="flex-1"
                  disabled={busyKey !== null}
                  onClick={() => onResolve(r.id, true)}
                  data-testid="member-contact-request-approve"
                >
                  同意
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {view.invites.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="member-contacts-invites">
          <p className="text-[13px] font-semibold text-foreground">還沒使用的邀請連結</p>
          {view.invites.map((i) => (
            <div
              key={i.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              data-testid="member-contact-invite"
            >
              <span className="min-w-0 text-[13px] tabular-nums text-muted-foreground">
                {i.expiresAt ? `${formatInviteExpiry(i.expiresAt)} 前有效` : "有效中"}
              </span>
              <Button
                type="button"
                variant="neutral"
                size="card"
                className="shrink-0"
                disabled={busyKey !== null}
                onClick={() => onRevoke(i.id)}
                data-testid="member-contact-invite-revoke"
              >
                撤銷
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {inviteButton}

      {!view.isPrimary && me ? (
        <MyContactPhone
          key={me.contactPhone ?? ""}
          slug={slug}
          current={me.contactPhone}
          onSaved={onPhoneSaved}
          onSessionLost={onSessionLost}
        />
      ) : null}
    </div>
  );
}

/** C4-H03:剛產生的邀請連結 ⇒「複製連結」「用 LINE 傳送」。 */
function InvitePanel({
  invite,
  message,
}: {
  invite: { url: string; expiresAt: string | null };
  message: string;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3"
      data-testid="member-contacts-invite-panel"
    >
      <p className="text-[13px] leading-relaxed text-foreground">
        {"把這段訊息傳給要加入的人（連結 72 小時內有效，只能用一次）："}
      </p>
      <p
        className="break-all rounded-md bg-background px-2.5 py-2 text-[13px] text-foreground"
        data-testid="member-contacts-invite-message"
      >
        {message}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="neutral"
          size="card"
          className="flex-1"
          onClick={() => void handleCopy()}
          data-testid="member-contacts-invite-copy"
        >
          {copied === "done" ? "已複製" : "複製連結"}
        </Button>
        <Button asChild variant="neutral" size="card" className="flex-1">
          <a
            href={lineShareUrl(message)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="member-contacts-invite-line"
          >
            用 LINE 傳送
          </a>
        </Button>
      </div>
      {copied === "failed" ? (
        <p className="text-[12.5px] text-muted-foreground">
          無法自動複製，請長按上面的訊息手動複製。
        </p>
      ) : null}
      {invite.expiresAt ? (
        <p className="text-[12.5px] tabular-nums text-muted-foreground">
          {`${formatInviteExpiry(invite.expiresAt)} 前有效`}
        </p>
      ) : null}
    </div>
  );
}

/** C4-H08 第二聯絡人自己的電話(空 = 清掉)。 */
function MyContactPhone({
  slug,
  current,
  onSaved,
  onSessionLost,
}: {
  slug: string;
  current: string | null;
  onSaved: () => void;
  onSessionLost: () => void;
}) {
  const [phone, setPhone] = useState(current ?? "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const changed = phone.trim() !== (current ?? "");
  const error = phone.trim() === "" ? null : customerPhoneError(phone);

  async function handleSave() {
    setTouched(true);
    if (!changed || error || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const outcome = await setMyContactPhone(slug, phone);
      if (isMemberGate(outcome)) {
        if (outcome.state === "not_linked") onSessionLost();
        return;
      }
      if (outcome.state === "phone_in_use") {
        setMessage(MY_PHONE_IN_USE_MESSAGE);
        return;
      }
      if (phone.trim() !== "" && outcome.contactPhone === null) {
        toast.success(MY_PHONE_SAME_AS_MEMBER_NOTE);
      } else {
        toast.success(phone.trim() === "" ? "已清除你的電話" : "已更新你的電話");
      }
      onSaved();
    } catch (err) {
      setMessage(contactErrorMessage(err instanceof MemberCenterError ? err.code : null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-border pt-3"
      data-testid="member-contacts-my-phone"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      noValidate
    >
      <FormField label="我的電話" htmlFor="member-contacts-my-phone" error={touched ? error : null}>
        <FieldInput
          id="member-contacts-my-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={20}
          className="tabular-nums"
          placeholder="0912-345-678"
          value={phone}
          onChange={(e) => {
            setMessage(null);
            setPhone(e.target.value);
          }}
          onBlur={() => setTouched(true)}
        />
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{MY_PHONE_HELP}</p>
      </FormField>
      {message ? (
        <AlertNote data-testid="member-contacts-my-phone-message">{message}</AlertNote>
      ) : null}
      {!changed ? (
        <AlertNote data-testid="member-contacts-my-phone-unchanged">還沒有修改電話</AlertNote>
      ) : null}
      <Button
        type="submit"
        variant="neutral"
        size="touch"
        className="w-full"
        disabled={!changed || saving}
        data-testid="member-contacts-my-phone-save"
      >
        {saving ? "儲存中⋯" : "儲存我的電話"}
      </Button>
    </form>
  );
}
