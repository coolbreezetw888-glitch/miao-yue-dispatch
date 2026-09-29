// 對應模組 10(會員與紅利)規格書 §4.1:會員管理列表頁(新路由 /app/members)。
// 頁面載入時先呼叫 grant_pending_birthday_bonuses(規則 2.5),有核發時顯示提示條。
// 清單:搜尋(姓名/電話/推薦碼)+ 篩選(狀態)。「新增會員」開啟全頁層表單。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;「新增會員」是這一頁唯一的 ① 主要按鈕(原本是 variant="cta")。
//   - 🔴「新增會員」表單有 7 個欄位(姓名 / 電話 / Email / 生日 / 等級 / 推薦人 / 備註)⇒ 依
//     skill 三「📐 分類原則」第 2、3 點改成**全頁層**(超過 3 欄、而且一定要捲),不是小卡窗。
//     標題列與底部「取消 / 建立」固定不動,只有中間捲(殼統一處理);頁面不再自己寫 max-w-md。
//   - 狀態篩選(上架中 / 已下架 / 全部)改底線式**篩選列**(variant="filter":必須一眼全部看到,
//     不捲不換行),不再是三顆灰底/實心按鈕(那會被誤以為是動作按鈕,二之四末段)。
//   - 等級篩選與黑名單篩選選項多、而且等級是動態清單 ⇒ 維持下拉,改 FieldSelect;
//     🔴 等級下拉套 guardPhantomEmptyChange(動態清單),黑名單下拉用白名單版。
//   - 每一位會員改 ListCard(二之五);標籤依 skill 二之四分三類:
//     狀態(上架中 / 已下架 / 黑名單)用 StatusTag、屬性(點數 / 等級)用 AttributeTag。
//   - 🔴 右側只放「一顆主要動作 + 一個 ⋯」(二之三):「編輯」永遠是主要動作(這一頁的「編輯」
//     就是進會員詳情頁,做成真正的 <Link> 可以右鍵開新分頁);已下架的人主要動作換成「恢復」。
//     「下架」收進 ⋯,而且**不標紅** —— 它是可逆的(有「恢復」),紅色只留給真正不可逆的刪除
//     (第 1 / 2 批已定案的裁決)。
//   - 載入中改灰色骨架、沒有符合條件的會員改 EmptyState(二之八)。
//
// ⚠️ e2e 影響(#849 要用):狀態篩選從 button 變成 role="tab";「下架」從卡片上的按鈕搬進 ⋯ 選單
//    (選單 portal 到 body,不在 <li> 裡面);表單欄位改 FormField 之後 `getByLabel("姓名 *")`
//    的可存取名稱會變成「姓名」(紅色 `*` 是 aria-hidden)。已在回報中逐條列出。
//
// **只動外觀,不動行為**:搜尋 / 三種篩選的判斷、生日獎勵的被動核發、建立會員的驗證與送出欄位、
// 下架 / 恢復的 API 呼叫、toast 文案全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users } from "lucide-react";

import {
  ActionBar,
  AttributeTag,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  EmptyState,
  FieldDate,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  FullPageLayerTrigger,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
  type ListCardMenuItem,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { isValidTaiwanPhone, TW_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  createMember,
  deactivateMember,
  fetchMerchantMembersList,
  grantPendingBirthdayBonuses,
  reactivateMember,
  useMerchantMemberTiers,
} from "./api";
import { RequireMembersAccess } from "./RequireMembersAccess";
import { MEMBER_STATUS_LABELS, type MemberStatus, type MemberSummary } from "./types";

const UNASSIGNED_TIER_VALUE = "__unassigned__";

/** 全頁層的按鈕列在 form 外面(位置由殼決定),送出鈕用 form= 指回來。 */
const NEW_MEMBER_FORM_ID = "new-member-form";

const membersListQueryKey = (merchantId: string, search: string) =>
  ["members-module", "members-list", merchantId, search] as const;

// ---------------------------------------------------------------------------
// 推薦人搜尋輸入框(簡易版本):輸入姓名/電話/推薦碼即時查詢既有會員,選中後帶出 memberId。
// ---------------------------------------------------------------------------
function ReferrerPicker({
  merchantId,
  value,
  onChange,
}: {
  merchantId: string;
  value: { id: string; name: string } | null;
  onChange: (member: { id: string; name: string } | null) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [open, setOpen] = useState(false);

  const { data: candidates } = useQuery({
    queryKey: ["members-module", "referrer-picker", merchantId, keyword],
    queryFn: () => fetchMerchantMembersList(merchantId, keyword),
    enabled: open && keyword.trim().length > 0,
  });

  if (value) {
    return (
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        <span className="min-w-0 break-words">{value.name}</span>
        {/* 可逆動作 ⇒ 不標紅,用 ② 次要。 */}
        <Button
          type="button"
          variant="neutral"
          size="card"
          className="shrink-0"
          onClick={() => onChange(null)}
        >
          清除
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <FieldInput
        aria-label="輸入姓名、電話或推薦碼搜尋推薦人"
        placeholder="輸入姓名/電話/推薦碼搜尋"
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && keyword.trim() && candidates && candidates.length > 0 ? (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
          {candidates
            .filter((c) => c.status === "active")
            .map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="block min-h-11 w-full cursor-pointer break-words px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  onClick={() => {
                    onChange({ id: c.id, name: c.name });
                    setOpen(false);
                    setKeyword("");
                  }}
                >
                  {c.name}
                  {c.phone ? ` ・ ${c.phone}` : ""}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

function NewMemberDialog({ merchantId, onSaved }: { merchantId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: tiers } = useMerchantMemberTiers(merchantId, true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [birthday, setBirthday] = useState("");
  const [notes, setNotes] = useState("");
  const [referrer, setReferrer] = useState<{ id: string; name: string } | null>(null);
  const [tierId, setTierId] = useState(UNASSIGNED_TIER_VALUE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setPhone("");
      setEmail("");
      setBirthday("");
      setNotes("");
      setReferrer(null);
      setTierId(UNASSIGNED_TIER_VALUE);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫會員姓名");
      return;
    }
    // SPECS-INDEX #822:會員電話是選填,留空放行;填了就套客戶電話規則(手機或市話,見 validation.ts)。
    if (phone.trim() && !isValidTaiwanPhone(phone)) {
      toast.error(TW_PHONE_ERROR_MESSAGE);
      return;
    }
    setSaving(true);
    try {
      await createMember({
        merchantId,
        name: name.trim(),
        phone: phone.trim() ? phone.trim() : null,
        email: email.trim() ? email.trim() : null,
        birthday: birthday.trim() ? birthday.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        referredByMemberId: referrer?.id ?? null,
        tierId: tierId === UNASSIGNED_TIER_VALUE ? null : tierId,
      });
      toast.success("已建立會員");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("建立失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={setOpen}>
      <FullPageLayerTrigger asChild>
        {/* 這一頁唯一的 ① 主要按鈕(skill 二之三)。 */}
        <Button type="button" variant="primary" size="touch">
          新增會員
        </Button>
      </FullPageLayerTrigger>
      {/* 7 個欄位、一定要捲 ⇒ 全頁層(skill 三「📐 分類原則」)。 */}
      <FullPageLayerContent
        title="新增會員"
        subtitle="會員由商家建立,不是消費者自己註冊。只有姓名是必填的。"
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={NEW_MEMBER_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "儲存中⋯" : "建立"}
            </Button>
          </ActionBar>
        }
      >
        <form onSubmit={handleSubmit} id={NEW_MEMBER_FORM_ID} className="flex flex-col gap-4">
          <FormField label="姓名" htmlFor="member-name" required>
            <FieldInput id="member-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          {/* #614(SPECS-INDEX):電話這次只當查詢索引,不是必填的唯一鍵,不再依 merchant_member_
              settings 的任何開關判斷是否必填(該開關已於 #618 移除)。 */}
          <FormField
            label="電話"
            htmlFor="member-phone"
            help="電話是選填,留空也可以建立會員 —— 它只是用來在建單時查出這位客戶,不是會員的唯一身分。要填的話手機或市話都可以。"
            helpLabel="說明:會員電話要不要填、有什麼用"
          >
            <FieldInput
              id="member-phone"
              type="tel"
              inputMode="tel"
              className="tabular-nums"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </FormField>
          <FormField label="Email" htmlFor="member-email">
            <FieldInput
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <FormField
            label="生日"
            htmlFor="member-birthday"
            help="填了生日,系統才會在生日當月自動核發生日獎勵(依台北時區比對生日的月、日)。"
            helpLabel="說明:填生日會發生什麼事"
          >
            <FieldDate
              id="member-birthday"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </FormField>
          {/* #615(SPECS-INDEX):會員等級,選填。 */}
          <FormField label="會員等級(選填)" htmlFor="member-tier">
            <FieldSelect
              id="member-tier"
              value={tierId}
              // 選項是資料庫來的動態清單 ⇒ 只擋空字串的那一種 guard 用法。
              onValueChange={guardPhantomEmptyChange(setTierId)}
              options={[
                { value: UNASSIGNED_TIER_VALUE, label: "未分級" },
                ...(tiers ?? []).map((tier) => ({ value: tier.id, label: tier.name })),
              ]}
            />
          </FormField>
          <FormField
            label="推薦人(選填)"
            help="推薦人只能在建立當下設定,建立完成之後就無法再變更了 —— 因為推薦獎勵是依這筆關係核發的。"
            helpLabel="說明:推薦人為什麼之後不能改"
          >
            <ReferrerPicker merchantId={merchantId} value={referrer} onChange={setReferrer} />
          </FormField>
          <FormField label="備註" htmlFor="member-notes">
            <FieldTextarea
              id="member-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
        </form>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

function MembersListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MemberStatus | "all">("active");
  // #615(SPECS-INDEX):會員等級篩選,"all" 顯示全部。
  const [tierFilter, setTierFilter] = useState<string>("all");
  // #643(SPECS-INDEX):黑名單篩選,比照上面會員等級篩選的既有模式(Select,"all" 顯示全部)。
  const [blacklistFilter, setBlacklistFilter] = useState<"all" | "blacklisted" | "not_blacklisted">(
    "all",
  );
  const [birthdayNotice, setBirthdayNotice] = useState<number | null>(null);
  // ui-v1-full:「下架」搬進 ⋯ 選單之後,確認窗改成整頁一顆的受控實例(比照第 1 批服務人員頁的做法)。
  const [deactivatingMember, setDeactivatingMember] = useState<MemberSummary | null>(null);

  const { data: members, isLoading } = useQuery({
    queryKey: membersListQueryKey(merchantId, search),
    queryFn: () => fetchMerchantMembersList(merchantId, search),
  });
  const { data: tiers } = useMerchantMemberTiers(merchantId, false);
  const tierNameById = new Map((tiers ?? []).map((t) => [t.id, t.name]));

  // 規則 2.5:頁面載入時被動檢查並核發生日獎勵,不是背景排程。
  useEffect(() => {
    grantPendingBirthdayBonuses(merchantId)
      .then((count) => {
        if (count > 0) {
          setBirthdayNotice(count);
          void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
        }
      })
      .catch(() => {
        // 靜默失敗即可,不影響列表頁本身的顯示(這不是使用者主動觸發的操作)。
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  async function handleDeactivate(memberId: string) {
    try {
      await deactivateMember(memberId);
      await refetch();
      toast.success("已下架會員");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivate(memberId: string) {
    try {
      await reactivateMember(memberId);
      await refetch();
      toast.success("已重新上架會員");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  const allMembers: MemberSummary[] = members ?? [];
  const visibleMembers: MemberSummary[] = allMembers.filter((m) => {
    if (statusFilter !== "all" && m.status !== statusFilter) return false;
    if (blacklistFilter === "blacklisted" && !m.isBlacklisted) return false;
    if (blacklistFilter === "not_blacklisted" && m.isBlacklisted) return false;
    if (tierFilter === "all") return true;
    if (tierFilter === UNASSIGNED_TIER_VALUE) return m.tierId === null;
    return m.tierId === tierFilter;
  });

  /** 篩選列的數量:照整份名單算(跟目前選了哪一顆無關),這樣切換前就知道各有幾位。 */
  const statusCounts = {
    active: allMembers.filter((m) => m.status === "active").length,
    removed: allMembers.filter((m) => m.status === "removed").length,
    all: allMembers.length,
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="會員管理"
        description={`「${merchant!.name}」的會員名錄與紅利點數`}
        action={<NewMemberDialog merchantId={merchantId} onSaved={refetch} />}
      />

      {birthdayNotice ? (
        <div className="rounded-md border border-brand/40 bg-brand-soft/40 px-3 py-2 text-sm tabular-nums text-foreground">
          🎂 今天有 {birthdayNotice} 位會員收到生日獎勵
        </div>
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>會員名單</CardTitle>
          <FieldInput
            aria-label="搜尋姓名、電話或推薦碼"
            placeholder="搜尋姓名/電話/推薦碼"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* 狀態篩選 = 切換看名單的哪一批 ⇒ 底線式篩選列,必須一眼全部看到(二之四末段)。 */}
          <Tabs
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as MemberStatus | "all")}
          >
            <UnderlineTabsList variant="filter">
              <UnderlineTabsTrigger value="active" count={statusCounts.active}>
                {MEMBER_STATUS_LABELS.active}
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="removed" count={statusCounts.removed}>
                {MEMBER_STATUS_LABELS.removed}
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="all" count={statusCounts.all}>
                全部
              </UnderlineTabsTrigger>
            </UnderlineTabsList>
          </Tabs>
          <div className="grid gap-2 sm:grid-cols-2">
            {/* #615(SPECS-INDEX):會員等級篩選。選項多又是動態清單 ⇒ 維持下拉。 */}
            <FieldSelect
              aria-label="依會員等級篩選"
              value={tierFilter}
              onValueChange={guardPhantomEmptyChange(setTierFilter)}
              options={[
                { value: "all", label: "全部等級" },
                { value: UNASSIGNED_TIER_VALUE, label: "未分級" },
                ...(tiers ?? []).map((tier) => ({ value: tier.id, label: tier.name })),
              ]}
            />
            {/* #643(SPECS-INDEX):黑名單篩選,方便商家查看自己之前標記過哪些黑名單客戶。 */}
            <FieldSelect<"all" | "blacklisted" | "not_blacklisted">
              aria-label="依黑名單狀態篩選"
              value={blacklistFilter}
              // 固定白名單 ⇒ 最嚴格的那一種 guard 用法。
              onValueChange={guardPhantomEmptyChange<"all" | "blacklisted" | "not_blacklisted">(
                setBlacklistFilter,
                (v) => v === "all" || v === "blacklisted" || v === "not_blacklisted",
              )}
              options={[
                { value: "all", label: "全部會員" },
                { value: "blacklisted", label: "只看黑名單" },
                { value: "not_blacklisted", label: "不含黑名單" },
              ]}
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={4} />
          ) : visibleMembers.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden="true" />}
              title={allMembers.length === 0 ? "還沒有任何會員" : "沒有符合條件的會員"}
              // EmptyState.action 的例外條款:下一步(「新增會員」)就在這一頁的頁首、一眼看得到,
              // 所以不在空狀態再放一顆 —— 再放一顆會變成同一個畫面上兩顆 primary
              // (違反 skill 二之三),而且是同一個動作的兩個實例。改在文案裡指路。
              description={
                allMembers.length === 0
                  ? "按右上角的「新增會員」建立第一位。建立之後,建單時輸入電話就能查到這位客戶、累積紅利點數、發生日獎勵與 LINE 行銷通知。"
                  : "換一個篩選條件或清空搜尋關鍵字再看看。"
              }
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {visibleMembers.map((member) => {
                const isRemoved = member.status !== "active";
                const detailPath = `/app/members/${member.id}`;
                // 🔴 二之三:「編輯」永遠是主要動作(已下架的人換成「恢復」),其餘收進 ⋯。
                //    「下架」是可逆的(有「恢復」)⇒ 一般項目、不標紅。
                const menuItems: ListCardMenuItem[] = isRemoved
                  ? [{ label: "會員詳情", to: detailPath }]
                  : [{ label: "下架", onSelect: () => setDeactivatingMember(member) }];
                return (
                  <li key={member.id}>
                    <ListCard
                      state={isRemoved ? "inactive" : "default"}
                      title={member.name}
                      tags={
                        <>
                          {/* 狀態標籤一個人只有一個:已下架優先。 */}
                          {isRemoved ? (
                            <StatusTag tone="neutral">{MEMBER_STATUS_LABELS.removed}</StatusTag>
                          ) : (
                            <StatusTag tone="success">{MEMBER_STATUS_LABELS.active}</StatusTag>
                          )}
                          {/* 黑名單是「出事」的狀態,但它跟上架狀態同時存在 ⇒ 獨立一顆紅系標籤。 */}
                          {member.isBlacklisted ? (
                            <StatusTag tone="danger">黑名單</StatusTag>
                          ) : null}
                          {/* 屬性(靜態分類):方角、灰底、安靜。 */}
                          <AttributeTag className="tabular-nums">
                            {member.pointsBalance} 點
                          </AttributeTag>
                          {member.tierId && tierNameById.has(member.tierId) ? (
                            <AttributeTag wrap>{tierNameById.get(member.tierId)}</AttributeTag>
                          ) : null}
                        </>
                      }
                      meta={
                        <>
                          {member.phone ? <span>{member.phone}</span> : null}
                          {member.phone ? <span> ・ </span> : null}
                          <span>推薦碼 {member.referralCode}</span>
                        </>
                      }
                      onClick={() => navigate(detailPath)}
                      primaryAction={
                        isRemoved ? (
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => handleReactivate(member.id)}
                          >
                            恢復
                          </Button>
                        ) : (
                          // 會跳頁 ⇒ 真正的 <a href>,可以右鍵 / 中鍵開新分頁。
                          <Button asChild variant="neutral" size="card">
                            <Link to={detailPath}>編輯</Link>
                          </Button>
                        )
                      }
                      menuItems={menuItems}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 整頁一顆的下架確認窗(觸發點在 ⋯ 選單裡)。🔴 可逆動作 ⇒ 不標紅。 */}
      <CardAlertDialog
        open={deactivatingMember !== null}
        onOpenChange={(next) => {
          if (!next) setDeactivatingMember(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定要下架「{deactivatingMember?.name}」嗎?</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              這是軟刪除,資料不會不見,之後隨時可以重新上架恢復。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              onClick={() => {
                if (deactivatingMember) void handleDeactivate(deactivatingMember.id);
                setDeactivatingMember(null);
              }}
            >
              確定下架
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </main>
  );
}

export default function MembersListPage() {
  return (
    <RequireMembersAccess>
      <MembersListInner />
    </RequireMembersAccess>
  );
}
