// 客戶端第 2 批(C2-E02~E04、E06、零之二)+ 第 3 批(C3-D02~D05):按「確定預約」之後的 ⑥ 系列畫面。
// 畫面對照 .project/notes/客戶端預覽-2026-10-08.html 的 ⑥-1、⑥-2、⑥-4。
//
//   ⑥-1 LineLoginScreen      用 LINE 登入(+「不登入，直接預約」)
//   ⑥-2 CustomerProfileScreen  登入後填電話 + 勾同意 ⇒「送出預約」(C3-D02:先接上會員、接著自動送出);
//                              ⑦-3 加入會員回來時按鈕是「加入會員」(C3-D07)
//   確認送出 LinkedConfirmScreen(C3-D03):登入列 + 預約內容摘要 +「送出預約」
//   ⑥-4 GuestScreen          不登入預約:電話 + 同意 + Cloudflare Turnstile(C3-D04)
//
// 🔴 零之二:不做簡訊、不做 ⑥-3 驗證畫面、不做「待店家確認身分」。
// 🔴 LINE 名稱、客人姓名、商家政策一律純文字顯示(React 文字節點),頭像只接受 https://(C2-F09)。
// 🔴 送出失敗只顯示前端自己的句子(bookingSubmitLogic 的 submitFailureView),不顯示伺服器原文(C3-D05)。

import { useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";

import { AlertNote, FieldInput, FormField, HelpPanel, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  externalBrowserUrl,
  GUEST_CHECK_UNAVAILABLE_MESSAGE,
  isLineInAppBrowser,
  TURNSTILE_UNSUPPORTED_MESSAGE,
  type SubmitFailureView,
} from "./bookingSubmitLogic";
import { MemberPolicyDialog } from "./MemberPolicyDialog";
import {
  ContactButtons,
  LineIcon,
  PublicShell,
  SimpleHeader,
  StepHeader,
} from "./PublicBookingChrome";
import {
  customerPhoneError,
  hasMemberPolicy,
  lineAvatarText,
  safeImageUrl,
} from "./customerLoginLogic";
import {
  merchantLogoText,
  STEP5_NAME_CONFIRM,
  STEP5_NAME_LOGIN,
  type ContactLinks,
} from "./publicBookingLogic";
import {
  TurnstileTokenError,
  TurnstileWidget,
  type TurnstileHandle,
  type TurnstileStatus,
} from "./TurnstileWidget";
import {
  JOIN_EXPIRED_MESSAGE,
  JOIN_PENDING_MESSAGE,
  JOIN_REJECTED_MESSAGE,
} from "./memberContactsLogic";
import type { PublicMemberPolicy } from "./types";

/** LINE 官方綠(LINE 品牌規範的按鈕色;不是我們的主題色,刻意寫死)。 */
export const LINE_GREEN_BUTTON_CLASS =
  "h-12 w-full rounded-lg border border-transparent bg-[#06C755] text-base font-semibold text-white shadow-sm hover:bg-[#06C755]/90";

/** 零之二第 3 點:電話欄說明。 */
const CUSTOMER_PHONE_HELP = "店家會用這支電話跟您聯絡服務細節（公司可填市話）。";

// =========================================================================
// 共用小元件
// =========================================================================

function MerchantLogo({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const safe = safeImageUrl(logoUrl);
  return safe ? (
    <img
      src={safe}
      alt={`${name}的標誌`}
      className="mx-auto h-[72px] w-[72px] rounded-[20px] bg-background object-cover shadow-sm"
    />
  ) : (
    <div
      aria-hidden="true"
      className="mx-auto flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-brand text-[22px] font-extrabold text-brand-foreground shadow-sm"
    >
      {merchantLogoText(name)}
    </div>
  );
}

export function LineAvatar({
  name,
  pictureUrl,
  size = 40,
}: {
  name: string | null;
  pictureUrl: string | null;
  size?: number;
}) {
  const safe = safeImageUrl(pictureUrl);
  const style = { width: size, height: size };
  return safe ? (
    <img
      src={safe}
      alt=""
      style={style}
      className="shrink-0 rounded-full bg-muted object-cover"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      aria-hidden="true"
      style={style}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#06C755] text-sm font-semibold text-white"
    >
      {lineAvatarText(name)}
    </span>
  );
}

/** C2-C06 同意勾選框:商家有會員政策 ⇒「會員政策 與 隱私權政策」;沒有 ⇒ 只有「隱私權政策」。 */
export function ConsentBox({
  checked,
  onChange,
  policy,
  merchantName,
  lead,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  policy: PublicMemberPolicy;
  merchantName: string;
  /** 「我已閱讀並同意」(⑥-2)/「我同意」(⑥-4),同預覽圖。 */
  lead: string;
  testId: string;
}) {
  const [policyOpen, setPolicyOpen] = useState(false);
  const withMemberPolicy = hasMemberPolicy(policy);
  const labelId = `${testId}-label`;
  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-labelledby={labelId}
          onClick={() => onChange(!checked)}
          data-testid={testId}
          className="-m-2.5 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border-2",
              checked
                ? "border-brand bg-brand text-brand-foreground"
                : "border-input bg-background",
            )}
          >
            {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3.5} /> : null}
          </span>
        </button>
        <p id={labelId} className="min-w-0 pt-px text-sm leading-relaxed text-foreground">
          {lead}{" "}
          {withMemberPolicy ? (
            <>
              <button
                type="button"
                onClick={() => setPolicyOpen(true)}
                className="cursor-pointer font-semibold text-brand underline-offset-2 hover:underline"
                data-testid={`${testId}-member-policy`}
              >
                會員政策
              </button>{" "}
              與{" "}
            </>
          ) : null}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            隱私權政策
          </a>
        </p>
      </div>
      {withMemberPolicy ? (
        <MemberPolicyDialog
          open={policyOpen}
          onOpenChange={setPolicyOpen}
          merchantName={merchantName}
          content={policy.content ?? ""}
        />
      ) : null}
    </div>
  );
}

/**
 * C3-D05:送出失敗時的說明區塊(伺服器原文一律不顯示,文字由 submitFailureView 依 state 決定)。
 * 需要時附「LINE 聯絡店家 / 撥打電話」與「用 LINE 登入」。
 */
export function SubmitErrorPanel({
  view,
  contacts,
  onLineLogin,
}: {
  view: SubmitFailureView;
  contacts: ContactLinks;
  onLineLogin?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col gap-2.5" data-testid="customer-submit-error">
      <AlertNote tone="danger" data-testid="customer-submit-error-message">
        {view.message}
      </AlertNote>
      {view.showLineLogin && onLineLogin ? (
        <Button
          type="button"
          className={LINE_GREEN_BUTTON_CLASS}
          onClick={onLineLogin}
          data-testid="customer-submit-error-line-login"
        >
          <LineIcon className="!size-6" />用 LINE 登入
        </Button>
      ) : null}
      {view.showContacts ? <ContactButtons links={contacts} /> : null}
    </div>
  );
}

/** 送出鈕上的轉圈 + 文字(送出中停用)。 */
function SubmitButton({
  busy,
  disabled,
  label,
  busyLabel,
  onClick,
  testId,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="primary"
      size="touch"
      className="w-full"
      disabled={disabled || busy}
      onClick={onClick}
      data-testid={testId}
      aria-busy={busy}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {busy ? busyLabel : label}
    </Button>
  );
}

export const SUBMITTING_LABEL = "正在送出預約…";

/**
 * C2-E02 / C3-D03 / C3-D07:「已用 LINE 登入：王小明（不是你？登出）」。
 * 確認送出畫面與 ① 店家首頁共用同一個元件(零之零 C3-D07)。
 */
export function CustomerLoginBar({
  memberName,
  onLogout,
  className,
}: {
  memberName: string;
  onLogout: () => void;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-border bg-card px-3.5 py-3 text-sm shadow-sm",
        className,
      )}
      data-testid="customer-login-bar"
    >
      <span className="text-muted-foreground">已用 LINE 登入：</span>
      <span
        className="break-words font-semibold text-foreground"
        data-testid="customer-linked-name"
      >
        {memberName}
      </span>
      <span className="text-muted-foreground">（不是您？</span>
      <button
        type="button"
        onClick={onLogout}
        className="cursor-pointer font-semibold text-brand underline-offset-2 hover:underline"
        data-testid="customer-login-bar-logout"
      >
        登出
      </button>
      <span className="text-muted-foreground">）</span>
    </div>
  );
}

function LogoutButton({ onLogout, busy }: { onLogout: () => void; busy?: boolean }) {
  return (
    <Button
      type="button"
      variant="text"
      size="card"
      className="px-2"
      onClick={onLogout}
      disabled={busy}
      data-testid="customer-logout"
    >
      登出
    </Button>
  );
}

// =========================================================================
// ⑥-1 用 LINE 登入
// =========================================================================

export function LineLoginScreen({
  merchantName,
  logoUrl,
  allowGuest,
  onBack,
  onLogin,
  onGuest,
  busy,
  error,
  notice,
}: {
  merchantName: string;
  logoUrl: string | null;
  allowGuest: boolean;
  onBack: () => void;
  onLogin: () => void;
  onGuest: () => void;
  busy: boolean;
  error: string | null;
  notice?: string | null;
}) {
  return (
    <PublicShell
      header={
        <StepHeader
          stepNumber={5}
          title="登入會員"
          onBack={onBack}
          lastStepName={STEP5_NAME_LOGIN}
        />
      }
    >
      <div
        className="mx-auto flex min-h-[60dvh] max-w-sm flex-col justify-center gap-[18px] py-6 text-center"
        data-testid="customer-line-login"
      >
        <MerchantLogo name={merchantName} logoUrl={logoUrl} />
        <div>
          <h2 className="text-xl font-bold text-foreground">最後一步：登入會員</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {"登入後預約才會送出。"}
            <br />
            {/* 主腦 10/9:不寫第 4、5 批才有的事(會員中心查看 / 取消、LINE 通知),只講現在做得到的。 */}
            {"下次預約不用再填電話，"}
            <br />
            {"店家也能用會員資料更快跟您聯絡。"}
          </p>
        </div>
        {notice ? (
          <AlertNote className="text-left" data-testid="customer-line-login-notice">
            {notice}
          </AlertNote>
        ) : null}
        {error ? (
          <AlertNote tone="danger" className="text-left" data-testid="customer-line-login-error">
            {error}
          </AlertNote>
        ) : null}
        <Button
          type="button"
          className={LINE_GREEN_BUTTON_CLASS}
          onClick={onLogin}
          disabled={busy}
          data-testid="customer-line-login-button"
        >
          <LineIcon className="!size-6" />
          {busy ? "前往 LINE⋯" : "用 LINE 登入"}
        </Button>
        <p className="text-xs text-muted-foreground">{`第一次登入會自動成為「${merchantName}」的會員`}</p>
        {allowGuest ? (
          <>
            <div className="h-px bg-border" />
            <Button
              type="button"
              variant="text"
              size="touch"
              className="mx-auto"
              onClick={onGuest}
              data-testid="customer-guest-button"
            >
              不登入，直接預約
            </Button>
          </>
        ) : null}
      </div>
    </PublicShell>
  );
}

// =========================================================================
// ⑥-2 登入後填電話
// =========================================================================

/** join_pending(C4-H04):已送出加入聯絡人申請,由上層把登入狀態重抓成 join_pending 換畫面。 */
export type ProfileSubmitOutcome = "linked" | "phone_taken" | "join_pending" | { error: string };

export function CustomerProfileScreen({
  merchantName,
  lineDisplayName,
  linePictureUrl,
  policy,
  contacts,
  allowGuest,
  mode = "booking",
  submitting = false,
  submitError = null,
  joinRequest = null,
  onSubmit,
  onLogout,
  onGuest,
}: {
  merchantName: string;
  lineDisplayName: string | null;
  linePictureUrl: string | null;
  policy: PublicMemberPolicy;
  contacts: ContactLinks;
  allowGuest: boolean;
  /**
   * C3-D02:booking = 有預約草稿,按鈕「送出預約」(先完成會員資料、接著自動送出);
   * join = ⑦-3「用 LINE 登入加入會員」回來、沒有草稿,按鈕「加入會員」。
   */
  mode?: "booking" | "join";
  /** 第二段(送出預約)進行中:由預約頁控制。 */
  submitting?: boolean;
  /** 第二段送出失敗的說明(C3-D05)。 */
  submitError?: SubmitFailureView | null;
  /** C4-H05(c4-contract B2):上一次加入聯絡人的申請被拒絕 / 過期 ⇒ 上方多一行說明。 */
  joinRequest?: "rejected" | "expired" | null | undefined;
  onSubmit: (input: { phone: string; agree: boolean }) => Promise<ProfileSubmitOutcome>;
  onLogout: () => void;
  onGuest: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [agree, setAgree] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  /** 送出後伺服器說「這支電話已經是會員」時,記下是哪一支(改了電話就不再顯示)。 */
  const [takenPhone, setTakenPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phoneError = customerPhoneError(phone);
  const showTaken = takenPhone !== null && takenPhone === phone;
  const busy = profileBusy || submitting;
  const isJoin = mode === "join";

  async function handleSubmit() {
    setPhoneTouched(true);
    setError(null);
    if (phoneError || !agree || busy) return;
    setProfileBusy(true);
    try {
      const outcome = await onSubmit({ phone, agree });
      if (outcome === "phone_taken") setTakenPhone(phone);
      else if (typeof outcome === "object") setError(outcome.error);
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <PublicShell
      header={
        // ⑦-3「加入會員」回來(沒有預約草稿)不是預約流程的一步 ⇒ 不顯示步驟條。
        isJoin ? (
          <SimpleHeader title="完成會員資料" right={<LogoutButton onLogout={onLogout} />} />
        ) : (
          <StepHeader
            stepNumber={5}
            title="完成會員資料"
            right={<LogoutButton onLogout={onLogout} />}
            lastStepName={STEP5_NAME_LOGIN}
          />
        )
      }
      footer={
        <>
          {!agree ? (
            <AlertNote data-testid="customer-profile-blocked">
              {withPolicyText(
                policy,
                "請先勾選同意",
                isJoin ? "，才能加入會員。" : "，才能送出預約。",
              )}
            </AlertNote>
          ) : null}
          <SubmitButton
            busy={busy}
            disabled={!agree}
            label={isJoin ? "加入會員" : "送出預約"}
            busyLabel={isJoin ? "處理中⋯" : SUBMITTING_LABEL}
            onClick={() => void handleSubmit()}
            testId="customer-profile-submit"
          />
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="customer-profile">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm">
          <LineAvatar name={lineDisplayName} pictureUrl={linePictureUrl} />
          <div className="min-w-0 flex-1">
            <p
              className="break-words text-[15px] font-semibold text-foreground"
              data-testid="customer-line-name"
            >
              {lineDisplayName ?? "LINE 使用者"}
            </p>
            <p className="text-xs text-muted-foreground">已用 LINE 登入</p>
          </div>
          <StatusTag tone="success" className="shrink-0">
            已綁定 LINE
          </StatusTag>
        </div>

        {joinRequest && !showTaken ? (
          <div className="flex flex-col gap-2.5" data-testid={`customer-join-${joinRequest}`}>
            <AlertNote>
              {joinRequest === "rejected" ? JOIN_REJECTED_MESSAGE : JOIN_EXPIRED_MESSAGE}
            </AlertNote>
            <ContactButtons links={contacts} />
          </div>
        ) : null}

        {showTaken ? (
          <div
            className="flex flex-col gap-2.5 rounded-xl border border-destructive/40 bg-destructive-soft p-3.5"
            data-testid="customer-phone-taken"
          >
            <p className="text-sm font-semibold leading-relaxed text-destructive-strong">
              這支電話已經是會員，請改用其他電話，或聯繫店家。
            </p>
            <ContactButtons links={contacts} />
            {allowGuest && !isJoin ? (
              <Button
                type="button"
                variant="text"
                size="touch"
                className="self-center"
                onClick={onGuest}
                data-testid="customer-phone-taken-guest"
              >
                不登入，直接預約
              </Button>
            ) : null}
          </div>
        ) : null}

        <FormField
          label="電話"
          htmlFor="customer-profile-phone"
          required
          error={phoneTouched ? phoneError : null}
        >
          <FieldInput
            id="customer-profile-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={20}
            className="tabular-nums"
            placeholder="0912-345-678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => setPhoneTouched(true)}
            aria-required="true"
          />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {`${CUSTOMER_PHONE_HELP}之後要更改請聯絡店家。`}
          </p>
        </FormField>

        <ConsentBox
          checked={agree}
          onChange={setAgree}
          policy={policy}
          merchantName={merchantName}
          lead="我已閱讀並同意"
          testId="customer-profile-consent"
        />

        {error ? (
          <AlertNote tone="danger" data-testid="customer-profile-error">
            {error}
          </AlertNote>
        ) : null}
        {submitError ? <SubmitErrorPanel view={submitError} contacts={contacts} /> : null}
      </div>
    </PublicShell>
  );
}

function withPolicyText(policy: PublicMemberPolicy, before: string, after: string): string {
  return hasMemberPolicy(policy)
    ? `${before}會員政策與隱私權政策${after}`
    : `${before}隱私權政策${after}`;
}

// =========================================================================
// C3-D03 已登入(已接上會員)的確認送出畫面
// =========================================================================

export function LinkedConfirmScreen({
  merchantName,
  memberName,
  linkNotice,
  summary,
  contacts,
  submitting,
  submitError,
  onSubmit,
  onBack,
  onLogout,
}: {
  merchantName: string;
  memberName: string;
  /** 剛完成登入時的提示:existing = 接上原本的會員資料;created = 新加入會員;null = 之前就登入了。 */
  linkNotice: "existing" | "created" | null;
  summary: ReactNode;
  contacts: ContactLinks;
  submitting: boolean;
  submitError: SubmitFailureView | null;
  onSubmit: () => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  return (
    <PublicShell
      header={
        <StepHeader
          stepNumber={5}
          lastStepName={STEP5_NAME_CONFIRM}
          title="確認預約"
          onBack={submitting ? undefined : onBack}
          right={<LogoutButton onLogout={onLogout} busy={submitting} />}
        />
      }
      footer={
        <SubmitButton
          busy={submitting}
          disabled={false}
          label="送出預約"
          busyLabel={SUBMITTING_LABEL}
          onClick={onSubmit}
          testId="customer-linked-submit"
        />
      }
    >
      <div className="flex flex-col gap-4" data-testid="customer-linked">
        {linkNotice === "existing" ? (
          <HelpPanel data-testid="customer-linked-existing">
            {`這支電話已經是「${merchantName}」的會員，已幫您接上原本的資料。`}
          </HelpPanel>
        ) : linkNotice === "created" ? (
          <HelpPanel data-testid="customer-linked-created">
            {`已完成登入，您現在是「${merchantName}」的會員。`}
          </HelpPanel>
        ) : null}
        <CustomerLoginBar memberName={memberName} onLogout={onLogout} />
        {summary}
        {submitError ? <SubmitErrorPanel view={submitError} contacts={contacts} /> : null}
      </div>
    </PublicShell>
  );
}

// =========================================================================
// ⑥-4 不登入預約(訪客)
// =========================================================================

export function GuestScreen({
  merchantName,
  policy,
  contacts,
  summary,
  phone,
  onPhoneChange,
  agree,
  onAgreeChange,
  siteKey,
  lineLoginEnabled,
  submitting,
  submitError,
  onSubmit,
  onTurnstileError,
  onLineLogin,
  onBack,
}: {
  merchantName: string;
  policy: PublicMemberPolicy;
  contacts: ContactLinks;
  summary: ReactNode;
  /** 電話與勾選放在預約頁(C3-D05:時段被約走回 ④ 時要保留)。 */
  phone: string;
  onPhoneChange: (next: string) => void;
  agree: boolean;
  onAgreeChange: (next: boolean) => void;
  /** Turnstile sitekey;null = 這個環境沒有設定 ⇒ 不能不登入預約。 */
  siteKey: string | null;
  lineLoginEnabled: boolean;
  submitting: boolean;
  submitError: SubmitFailureView | null;
  /** 拿到 Turnstile token 之後送出。 */
  onSubmit: (input: { phone: string; turnstileToken: string }) => void;
  /** Turnstile 這次沒通過 / 逾時(由預約頁顯示失敗說明)。 */
  onTurnstileError: (code: "error" | "timeout") => void;
  onLineLogin: () => void;
  onBack: () => void;
}) {
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState<TurnstileStatus>("loading");
  const [checking, setChecking] = useState(false);
  const turnstileRef = useRef<TurnstileHandle | null>(null);
  const phoneError = customerPhoneError(phone);
  const unsupported = siteKey === null || checkStatus === "unsupported";
  const busy = submitting || checking;

  // C3-D04:不能按的原因常駐在按鈕上方(ui-overlay-patterns 二之三)。
  const blockedReason = !agree
    ? withPolicyText(policy, "請先勾選同意", "，才能送出預約。")
    : phoneError
      ? phone.trim() === ""
        ? "請先填寫電話，才能送出預約。"
        : "電話格式不對，請修正後再送出預約。"
      : checkStatus === "loading"
        ? "正在準備安全檢查，請稍候。"
        : null;

  async function handleSubmit() {
    setPhoneTouched(true);
    if (blockedReason || busy || unsupported) return;
    const handle = turnstileRef.current;
    if (!handle) return;
    setChecking(true);
    try {
      const token = await handle.getToken();
      setChecking(false);
      onSubmit({ phone, turnstileToken: token });
    } catch (err) {
      setChecking(false);
      const code = err instanceof TurnstileTokenError ? err.code : "error";
      if (code === "unsupported") setCheckStatus("unsupported");
      else onTurnstileError(code);
    }
  }

  const inLine = typeof navigator !== "undefined" && isLineInAppBrowser(navigator.userAgent);

  return (
    <PublicShell
      header={
        <StepHeader
          stepNumber={5}
          title="不登入預約"
          onBack={busy ? undefined : onBack}
          lastStepName={STEP5_NAME_LOGIN}
        />
      }
      footer={
        unsupported ? (
          <ContactButtons links={contacts} />
        ) : (
          <>
            {blockedReason ? (
              <AlertNote data-testid="customer-guest-submit-reason">{blockedReason}</AlertNote>
            ) : null}
            <SubmitButton
              busy={busy}
              disabled={blockedReason !== null}
              label="送出預約"
              busyLabel={SUBMITTING_LABEL}
              onClick={() => void handleSubmit()}
              testId="customer-guest-submit"
            />
          </>
        )
      }
    >
      <div className="flex flex-col gap-4" data-testid="customer-guest">
        {summary}
        <FormField
          label="電話"
          htmlFor="customer-guest-phone"
          required
          error={phoneTouched ? phoneError : null}
        >
          <FieldInput
            id="customer-guest-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={20}
            className="tabular-nums"
            placeholder="0912-345-678"
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            onBlur={() => setPhoneTouched(true)}
            aria-required="true"
          />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {CUSTOMER_PHONE_HELP}
          </p>
        </FormField>
        <ConsentBox
          checked={agree}
          onChange={onAgreeChange}
          policy={policy}
          merchantName={merchantName}
          lead="我同意"
          testId="customer-guest-consent"
        />
        <HelpPanel data-testid="customer-guest-note">
          不登入的預約都要等店家確認。之後想加入會員，隨時可以用 LINE 登入，下次預約不用再填電話。
        </HelpPanel>

        {unsupported ? (
          <div
            className="flex flex-col gap-2.5 rounded-xl border border-destructive/40 bg-destructive-soft p-3.5"
            data-testid="customer-guest-unsupported"
          >
            <p className="text-sm font-semibold leading-relaxed text-destructive-strong">
              {siteKey === null ? GUEST_CHECK_UNAVAILABLE_MESSAGE : TURNSTILE_UNSUPPORTED_MESSAGE}
            </p>
            {siteKey !== null ? <CopyBookingUrlButton /> : null}
            {siteKey !== null && inLine ? (
              <Button asChild variant="neutral" size="touch" className="w-full">
                <a
                  href={externalBrowserUrl(window.location.href)}
                  data-testid="customer-guest-open-external"
                >
                  用瀏覽器開啟
                </a>
              </Button>
            ) : null}
            {lineLoginEnabled ? (
              <Button
                type="button"
                className={LINE_GREEN_BUTTON_CLASS}
                onClick={onLineLogin}
                data-testid="customer-guest-unsupported-line-login"
              >
                <LineIcon className="!size-6" />用 LINE 登入
              </Button>
            ) : null}
          </div>
        ) : null}

        {siteKey !== null ? (
          <div className={cn(unsupported && "hidden")}>
            {checkStatus === "interactive" ? (
              <p
                className="mb-2 text-center text-sm font-semibold text-foreground"
                data-testid="customer-guest-turnstile-hint"
              >
                請勾選，確認您不是機器人
              </p>
            ) : null}
            <TurnstileWidget ref={turnstileRef} siteKey={siteKey} onStatusChange={setCheckStatus} />
          </div>
        ) : null}

        {submitError ? (
          <SubmitErrorPanel view={submitError} contacts={contacts} onLineLogin={onLineLogin} />
        ) : null}
      </div>
    </PublicShell>
  );
}

/** C3-D04:「複製預約網址」(換瀏覽器開啟時用)。複製失敗就提示客人自己長按網址列。 */
function CopyBookingUrlButton() {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="neutral"
        size="touch"
        className="w-full"
        onClick={() => void handleCopy()}
        data-testid="customer-guest-copy-url"
      >
        {copied === "done" ? "已複製預約網址" : "複製預約網址"}
      </Button>
      {copied === "failed" ? (
        <p className="text-[12.5px] text-muted-foreground">
          {"無法自動複製，請長按網址列手動複製。"}
        </p>
      ) : null}
    </>
  );
}

// =========================================================================
// C4-H04「加入聯絡人申請已送出」(join_pending)
// =========================================================================

/**
 * 填的電話已經是別人的會員 ⇒ 伺服器送出「加入聯絡人」申請,這裡告訴客人等主要聯絡人確認。
 *   ・「改用其他電話」= 取消申請、回 ⑥-2 重新填電話。
 *   ・聯絡按鈕;允許不登入預約的店、而且是預約流程中 ⇒「不登入，直接預約」(送訪客單)。
 * 🔴 畫面不帶這位會員的任何資料(C2-F06):不顯示會員姓名、主要聯絡人是誰。
 */
export function JoinPendingScreen({
  lineDisplayName,
  linePictureUrl,
  contacts,
  allowGuest,
  onUseOtherPhone,
  onGuest,
  onLogout,
}: {
  lineDisplayName: string | null;
  linePictureUrl: string | null;
  contacts: ContactLinks;
  /** 預約流程中、店家允許不登入預約 ⇒ 顯示「不登入，直接預約」。 */
  allowGuest: boolean;
  onUseOtherPhone: () => Promise<void>;
  onGuest: () => void;
  onLogout: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOtherPhone() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUseOtherPhone();
    } catch {
      setError("操作沒有成功，請稍後再試。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell
      header={
        <SimpleHeader title="加入聯絡人申請已送出" right={<LogoutButton onLogout={onLogout} />} />
      }
    >
      <div className="flex flex-col gap-4" data-testid="customer-join-pending">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm">
          <LineAvatar name={lineDisplayName} pictureUrl={linePictureUrl} />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] font-semibold text-foreground">
              {lineDisplayName ?? "LINE 使用者"}
            </p>
            <p className="text-xs text-muted-foreground">已用 LINE 登入</p>
          </div>
          <StatusTag tone="warning" className="shrink-0">
            等待確認
          </StatusTag>
        </div>

        <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
          <p
            className="text-[15px] leading-relaxed text-foreground"
            data-testid="customer-join-pending-message"
          >
            {JOIN_PENDING_MESSAGE}
          </p>
        </div>

        {error ? (
          <AlertNote tone="danger" data-testid="customer-join-pending-error">
            {error}
          </AlertNote>
        ) : null}

        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          disabled={busy}
          onClick={() => void handleOtherPhone()}
          data-testid="customer-join-pending-other-phone"
        >
          {busy ? "處理中⋯" : "改用其他電話"}
        </Button>
        <ContactButtons links={contacts} />
        {allowGuest ? (
          <Button
            type="button"
            variant="text"
            size="touch"
            className="self-center"
            onClick={onGuest}
            data-testid="customer-join-pending-guest"
          >
            不登入，直接預約
          </Button>
        ) : null}
      </div>
    </PublicShell>
  );
}
