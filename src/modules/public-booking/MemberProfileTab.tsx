// 客戶端第 4 批 4-A(C4-E01~E04,⚠️範圍 第 1 點):會員中心「我的資料」(預覽圖 ⑪-1,去掉 LINE 通知開關)。
//
// ・姓名、生日、地址、Email 可以自己改;手機不能改(會員的身分依據,要換請聯絡店家)。
// ・Q3 = A:生日第一次可以自己填,填了之後唯讀,要改請店家在後台改(防止反覆改生日領生日禮)。
// ・沒改任何東西時「儲存」停用,上方常駐黃色 !「還沒有修改任何資料」(ui-overlay-patterns 二之三)。
// ・第二聯絡人(4-B 才會出現)看得到但不能改:can_edit = false ⇒ 全部唯讀 + 一行說明。
// ・「LINE 帳號：王小明 已綁定」唯讀一行;第 5 批 5-A(C5-M02)在它下面放「LINE 通知」區塊
//   (MemberLineNotify.tsx;店家不能用 LINE 通知客人時整塊不顯示)。
// ・4-B(#1041):LINE 帳號那一行下面是「聯絡人」區塊(MemberContactsSection.tsx,C4-H09)。
// ・最下面:會員政策(店家有開才出現,小卡窗純文字)、隱私權政策、登出(只登出這間店的客戶 client)。
// ・這是一般頁面(不是彈窗),不需要 dirty 放棄確認;會員政策小卡窗放在 MemberPolicyDialog.tsx(檢視型)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  ErrorState,
  FieldDate,
  FieldInput,
  FormField,
  LoadingSkeleton,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { customerSessionQueryKey } from "./customerAuthApi";
import { hasMemberPolicy } from "./customerLoginLogic";
import { LineAvatar } from "./CustomerLoginScreens";
import type { MemberCenterContext } from "./MemberCenterPage";
import {
  fetchMyProfile,
  MemberCenterError,
  memberCenterQueryKey,
  updateMyProfile,
} from "./memberCenterApi";
import {
  BIRTHDAY_LOCKED_NOTE,
  isBirthdayLocked,
  isMemberGate,
  isProfileDirty,
  MEMBER_CENTER_CLOSED_MESSAGE,
  NOT_PRIMARY_NOTE,
  PHONE_READONLY_NOTE,
  PROFILE_ADDRESS_MAX,
  PROFILE_BIRTHDAY_MIN,
  PROFILE_NAME_MAX,
  PROFILE_UNCHANGED_NOTE,
  profileFormFrom,
  profileSaveErrorMessage,
  validateProfileForm,
  type MemberProfile,
  type ProfileFormErrors,
  type ProfileFormValues,
} from "./memberCenterLogic";
import { MemberContactsSection } from "./MemberContactsSection";
import { MemberLineNotifySection } from "./MemberLineNotify";
import { MemberPolicyDialog } from "./MemberPolicyDialog";
import { taipeiToday } from "./publicBookingLogic";

/** 第一次填生日、還沒存時的提醒(按下去之後就不能自己改 ⇒ 常駐 !)。 */
const BIRTHDAY_FIRST_FILL_NOTE = "生日儲存後就不能自行修改，請確認日期正確。";

export function MemberProfileTab({ ctx }: { ctx: MemberCenterContext }) {
  const { slug, page } = ctx;
  const profileQuery = useQuery({
    queryKey: [...memberCenterQueryKey(slug), "profile"],
    queryFn: () => fetchMyProfile(slug),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const result = profileQuery.data;
  const gate = result && isMemberGate(result) ? result : null;
  const profile = result && !isMemberGate(result) ? result : null;

  const onSessionLost = ctx.onSessionLost;
  useEffect(() => {
    if (gate?.state === "not_linked") onSessionLost();
  }, [gate, onSessionLost]);

  const [policyOpen, setPolicyOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const withPolicy = hasMemberPolicy(page.member_policy);

  let body;
  if (profileQuery.isPending) {
    body = (
      <div className="flex flex-col gap-3" data-testid="member-center-loading">
        <LoadingSkeleton variant="lines" rows={4} />
      </div>
    );
  } else if (profileQuery.isError) {
    body = (
      <div data-testid="member-center-error">
        <ErrorState
          honorific
          title="讀不到會員資料"
          reason="可能是網路不穩"
          onRetry={() => void profileQuery.refetch()}
          retryLabel="重新整理"
        />
      </div>
    );
  } else if (profile) {
    body = (
      <ProfileForm
        key={profileQuery.dataUpdatedAt}
        slug={slug}
        profile={profile}
        onSessionLost={onSessionLost}
      />
    );
  } else {
    body = null;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="member-profile">
      {body}

      {profile ? (
        <section
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm"
          data-testid="member-profile-line"
        >
          <LineAvatar
            name={profile.me.lineDisplayName}
            pictureUrl={profile.me.linePictureUrl}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-muted-foreground">LINE 帳號</p>
            <p className="break-words text-[15px] font-semibold text-foreground">
              {profile.me.lineDisplayName ?? "LINE 使用者"}
            </p>
          </div>
          <StatusTag tone="success" className="shrink-0">
            已綁定
          </StatusTag>
        </section>
      ) : null}

      {profile ? <MemberLineNotifySection slug={slug} onSessionLost={onSessionLost} /> : null}

      {profile ? <MemberContactsSection ctx={ctx} memberName={profile.member.name} /> : null}

      <Button
        type="button"
        variant="neutral"
        size="touch"
        className="w-full"
        disabled={loggingOut}
        onClick={() => {
          setLoggingOut(true);
          void ctx.onLogout();
        }}
        data-testid="member-profile-logout"
      >
        登出
      </Button>

      <p
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-2 text-xs text-muted-foreground"
        data-testid="member-profile-links"
      >
        {withPolicy ? (
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
            onClick={() => setPolicyOpen(true)}
            data-testid="member-profile-policy"
          >
            會員政策
          </button>
        ) : null}
        <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">
          隱私權政策
        </Link>
      </p>
      {withPolicy ? (
        <MemberPolicyDialog
          open={policyOpen}
          onOpenChange={setPolicyOpen}
          merchantName={page.merchant.name}
          content={page.member_policy.content ?? ""}
        />
      ) : null}
    </div>
  );
}

function ProfileForm({
  slug,
  profile,
  onSessionLost,
}: {
  slug: string;
  profile: MemberProfile;
  onSessionLost: () => void;
}) {
  const queryClient = useQueryClient();
  const original = profileFormFrom(profile);
  const [values, setValues] = useState<ProfileFormValues>(original);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canEdit = profile.canEdit;
  const birthdayLocked = isBirthdayLocked(profile);
  const today = taipeiToday();
  const dirty = isProfileDirty(values, original);
  const errors: ProfileFormErrors = validateProfileForm(values, {
    originalBirthday: profile.member.birthday,
    today,
  });
  const valid = Object.keys(errors).length === 0;
  const showError = (key: keyof ProfileFormValues) => (touched ? (errors[key] ?? null) : null);

  function set<K extends keyof ProfileFormValues>(key: K, value: string) {
    setSaveError(null);
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSave() {
    setTouched(true);
    if (!dirty || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const outcome = await updateMyProfile(slug, values);
      if (outcome === "not_linked") {
        onSessionLost();
        return;
      }
      if (outcome === "unavailable") {
        setSaveError(MEMBER_CENTER_CLOSED_MESSAGE);
        return;
      }
      toast.success("已儲存會員資料");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: memberCenterQueryKey(slug) }),
        queryClient.invalidateQueries({ queryKey: customerSessionQueryKey(slug) }),
      ]);
    } catch (err) {
      setSaveError(profileSaveErrorMessage(err instanceof MemberCenterError ? err.code : null));
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return (
      <section
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-sm"
        data-testid="member-profile-readonly"
      >
        <p className="text-[12.5px] text-muted-foreground">{NOT_PRIMARY_NOTE}</p>
        <ReadOnlyRow label="姓名" value={profile.member.name} />
        <ReadOnlyRow label="手機" value={profile.member.phone} />
        <ReadOnlyRow label="生日" value={profile.member.birthday} />
        <ReadOnlyRow label="地址" value={profile.member.address} />
        <ReadOnlyRow label="Email" value={profile.member.email} />
      </section>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="member-profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      noValidate
    >
      <FormField label="姓名" htmlFor="member-profile-name" required error={showError("name")}>
        <FieldInput
          id="member-profile-name"
          autoComplete="name"
          maxLength={PROFILE_NAME_MAX + 20}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          aria-required="true"
        />
      </FormField>

      <div className="flex flex-col gap-1.5" data-testid="member-profile-phone">
        <span className="text-[13px] font-semibold leading-none text-foreground">手機</span>
        <p className="rounded-md border border-border bg-muted px-3 py-2.5 text-[15px] tabular-nums text-foreground">
          {profile.member.phone ?? "未填寫"}
        </p>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{PHONE_READONLY_NOTE}</p>
      </div>

      {birthdayLocked ? (
        <div className="flex flex-col gap-1.5" data-testid="member-profile-birthday-locked">
          <span className="text-[13px] font-semibold leading-none text-foreground">生日</span>
          <p className="rounded-md border border-border bg-muted px-3 py-2.5 text-[15px] tabular-nums text-foreground">
            {profile.member.birthday}
          </p>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {BIRTHDAY_LOCKED_NOTE}
          </p>
        </div>
      ) : (
        <FormField label="生日" htmlFor="member-profile-birthday" error={showError("birthday")}>
          <FieldDate
            id="member-profile-birthday"
            min={PROFILE_BIRTHDAY_MIN}
            max={today}
            value={values.birthday}
            onChange={(e) => set("birthday", e.target.value)}
          />
          {values.birthday !== "" ? (
            <AlertNote data-testid="member-profile-birthday-note">
              {BIRTHDAY_FIRST_FILL_NOTE}
            </AlertNote>
          ) : null}
        </FormField>
      )}

      <FormField label="地址" htmlFor="member-profile-address" error={showError("address")}>
        <FieldInput
          id="member-profile-address"
          autoComplete="street-address"
          maxLength={PROFILE_ADDRESS_MAX + 20}
          value={values.address}
          onChange={(e) => set("address", e.target.value)}
        />
      </FormField>

      <FormField label="Email" htmlFor="member-profile-email" error={showError("email")}>
        <FieldInput
          id="member-profile-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="例如：name@example.com"
          value={values.email}
          onChange={(e) => set("email", e.target.value)}
        />
      </FormField>

      {saveError ? (
        <AlertNote tone="danger" data-testid="member-profile-error">
          {saveError}
        </AlertNote>
      ) : null}
      {!dirty ? (
        <AlertNote data-testid="member-profile-unchanged">{PROFILE_UNCHANGED_NOTE}</AlertNote>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="touch"
        className="w-full"
        disabled={!dirty || saving}
        data-testid="member-profile-save"
      >
        {saving ? "儲存中⋯" : "儲存"}
      </Button>
    </form>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 text-[13.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words text-foreground">{value ?? "未填寫"}</span>
    </div>
  );
}
