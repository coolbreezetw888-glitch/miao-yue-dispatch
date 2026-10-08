// 客戶端第 2 批(C2-E02~E04、E06、零之二):按「確定預約」之後的 ⑥ 系列畫面。
// 畫面對照 .project/notes/客戶端預覽-2026-10-08.html 的 ⑥-1、⑥-2、⑥-4。
//
//   ⑥-1 LineLoginScreen      用 LINE 登入(+「不登入，直接預約」)
//   ⑥-2 CustomerProfileScreen  登入後填電話 + 勾同意;結果「已接上」或「這支電話已經是會員」(phone_taken)
//   已登入確認 LinkedConfirmScreen(C2-E02):「已用 LINE 登入：○○（不是你？登出）」+ 停用的送出鈕
//   ⑥-4 GuestScreen          不登入預約(這批送出鈕停用)
//
// 🔴 零之二:不做簡訊、不做 ⑥-3 驗證畫面、不做「待店家確認身分」。
// 🔴 這批還不能真的送出預約(第 3 批):⑥-2 的按鈕是「完成登入」,其他畫面的送出鈕停用 + 常駐 `!` 說原因。
// 🔴 LINE 名稱、客人姓名、商家政策一律純文字顯示(React 文字節點),頭像只接受 https://(C2-F09)。

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import { AlertNote, FieldInput, FormField, HelpPanel, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { MemberPolicyDialog } from "./MemberPolicyDialog";
import { ContactButtons, LineIcon, PublicShell, SimpleHeader } from "./PublicBookingChrome";
import {
  customerPhoneError,
  hasMemberPolicy,
  lineAvatarText,
  safeImageUrl,
} from "./customerLoginLogic";
import { merchantLogoText, type ContactLinks } from "./publicBookingLogic";
import type { PublicMemberPolicy } from "./types";

/** LINE 官方綠(LINE 品牌規範的按鈕色;不是我們的主題色,刻意寫死)。 */
const LINE_GREEN_BUTTON_CLASS =
  "h-12 w-full rounded-lg border border-transparent bg-[#06C755] text-base font-semibold text-white shadow-sm hover:bg-[#06C755]/90";

/** 零之二第 3 點:電話欄說明。 */
const CUSTOMER_PHONE_HELP = "店家會用這支電話跟你聯絡服務細節（公司可填市話）。";

const SUBMIT_NOT_OPEN_REASON = "線上預約即將開放，目前請透過下方方式聯絡店家預約。";

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

/** 停用的送出鈕 + 常駐 `!` 說原因 + 聯絡按鈕(這批還不能送出,第 3 批才開放)。 */
function NotOpenFooter({ contacts, testId }: { contacts: ContactLinks; testId: string }) {
  return (
    <>
      <AlertNote data-testid={`${testId}-reason`}>{SUBMIT_NOT_OPEN_REASON}</AlertNote>
      <Button
        type="button"
        variant="primary"
        size="touch"
        className="w-full"
        disabled
        data-testid={testId}
      >
        線上預約即將開放
      </Button>
      <ContactButtons links={contacts} />
    </>
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
    <PublicShell header={<SimpleHeader title="登入會員" onBack={onBack} />}>
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
            {"之後可以在會員中心查看、取消預約，"}
            <br />
            {"預約的最新狀態也會用 LINE 通知你。"}
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

export type ProfileSubmitOutcome = "linked" | "phone_taken" | { error: string };

export function CustomerProfileScreen({
  merchantName,
  lineDisplayName,
  linePictureUrl,
  policy,
  contacts,
  allowGuest,
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
  onSubmit: (input: { phone: string; agree: boolean }) => Promise<ProfileSubmitOutcome>;
  onLogout: () => void;
  onGuest: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 送出後伺服器說「這支電話已經是會員」時,記下是哪一支(改了電話就不再顯示)。 */
  const [takenPhone, setTakenPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phoneError = customerPhoneError(phone);
  const showTaken = takenPhone !== null && takenPhone === phone;

  async function handleSubmit() {
    setPhoneTouched(true);
    setError(null);
    if (phoneError || !agree || submitting) return;
    setSubmitting(true);
    try {
      const outcome = await onSubmit({ phone, agree });
      if (outcome === "phone_taken") setTakenPhone(phone);
      else if (typeof outcome === "object") setError(outcome.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PublicShell
      header={<SimpleHeader title="完成會員資料" right={<LogoutButton onLogout={onLogout} />} />}
      footer={
        <>
          {!agree ? (
            <AlertNote data-testid="customer-profile-blocked">
              {withPolicyText(policy, "請先勾選同意", "，才能完成登入。")}
            </AlertNote>
          ) : null}
          <Button
            type="button"
            variant="primary"
            size="touch"
            className="w-full"
            disabled={!agree || submitting}
            onClick={() => void handleSubmit()}
            data-testid="customer-profile-submit"
          >
            {submitting ? "處理中⋯" : "完成登入"}
          </Button>
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

        {showTaken ? (
          <div
            className="flex flex-col gap-2.5 rounded-xl border border-destructive/40 bg-destructive-soft p-3.5"
            data-testid="customer-phone-taken"
          >
            <p className="text-sm font-semibold leading-relaxed text-destructive-strong">
              這支電話已經是會員，請改用其他電話，或聯繫店家。
            </p>
            <ContactButtons links={contacts} />
            {allowGuest ? (
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
// C2-E02 已登入(已接上會員)的確認畫面
// =========================================================================

export function LinkedConfirmScreen({
  merchantName,
  memberName,
  linkNotice,
  summary,
  contacts,
  onBack,
  onLogout,
}: {
  merchantName: string;
  memberName: string;
  /** 剛完成登入時的提示:existing = 接上原本的會員資料;created = 新加入會員;null = 之前就登入了。 */
  linkNotice: "existing" | "created" | null;
  summary: ReactNode;
  contacts: ContactLinks;
  onBack: () => void;
  onLogout: () => void;
}) {
  return (
    <PublicShell
      header={
        <SimpleHeader
          title="確認預約"
          onBack={onBack}
          right={<LogoutButton onLogout={onLogout} />}
        />
      }
      footer={<NotOpenFooter contacts={contacts} testId="customer-linked-submit" />}
    >
      <div className="flex flex-col gap-4" data-testid="customer-linked">
        {linkNotice === "existing" ? (
          <HelpPanel data-testid="customer-linked-existing">
            {`這支電話已經是「${merchantName}」的會員，已幫你接上原本的資料。`}
          </HelpPanel>
        ) : linkNotice === "created" ? (
          <HelpPanel data-testid="customer-linked-created">
            {`已完成登入，你現在是「${merchantName}」的會員。`}
          </HelpPanel>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-border bg-card px-3.5 py-3 text-sm shadow-sm">
          <span className="text-muted-foreground">已用 LINE 登入：</span>
          <span
            className="break-words font-semibold text-foreground"
            data-testid="customer-linked-name"
          >
            {memberName}
          </span>
          <span className="text-muted-foreground">（不是你？</span>
          <button
            type="button"
            onClick={onLogout}
            className="cursor-pointer font-semibold text-brand underline-offset-2 hover:underline"
          >
            登出
          </button>
          <span className="text-muted-foreground">）</span>
        </div>
        {summary}
      </div>
    </PublicShell>
  );
}

// =========================================================================
// ⑥-4 不登入預約(訪客)—— 這批送出鈕停用
// =========================================================================

export function GuestScreen({
  merchantName,
  policy,
  contacts,
  summary,
  onBack,
}: {
  merchantName: string;
  policy: PublicMemberPolicy;
  contacts: ContactLinks;
  summary: ReactNode;
  onBack: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [agree, setAgree] = useState(false);
  const phoneError = customerPhoneError(phone);
  return (
    <PublicShell
      header={<SimpleHeader title="不登入預約" onBack={onBack} />}
      footer={<NotOpenFooter contacts={contacts} testId="customer-guest-submit" />}
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
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => setPhoneTouched(true)}
            aria-required="true"
          />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {CUSTOMER_PHONE_HELP}
          </p>
        </FormField>
        <ConsentBox
          checked={agree}
          onChange={setAgree}
          policy={policy}
          merchantName={merchantName}
          lead="我同意"
          testId="customer-guest-consent"
        />
        <HelpPanel data-testid="customer-guest-note">
          不登入的預約都要等店家確認。之後想查看預約或收到通知，隨時可以用 LINE 登入加入會員。
        </HelpPanel>
      </div>
    </PublicShell>
  );
}
