// 對應模組 10(會員與紅利)規格書 §4.2:會員詳情頁(新路由 /app/members/:id)。
// 基本資料 + 電話驗證 + 點數摘要 + 相關訂單 + 推薦名單。
//
// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」):點數區塊當時不再是完整的
// 兌換/手動調整/異動歷史操作面板——那些操作搬到新的獨立頁面 MemberPointsPage.tsx
// (/app/member-points),這裡只保留精簡摘要(目前餘額 + 「查看完整點數紀錄」連結導到獨立頁面
// 並帶入這位會員),避免兩邊各維護一份幾乎一樣的點數操作 UI。points_feature_enabled 關閉時
// 整個「點數」卡片不顯示。
//
// SPECS-INDEX #830(2026-09-29 使用者裁決 Q2,推翻上面 #617 那段):紅利點數管理頁的「會員點數餘額
// 總覽」被移除,而它是那頁唯一的選人入口,所以「異動歷史 / 手動調整 / 登記兌換」整組搬回這頁的
// 「點數」卡片(元件抽在 MemberPointsPanel.tsx,權限邊界逐項對照見該檔案開頭)。這頁不再有
// 「查看完整點數紀錄」連結,/app/member-points 也不再支援 ?member= 深連結。
// ⚠️ #830 第一版曾把「點數」卡片改成 points_feature_enabled 關閉時仍然顯示(卡片內多一條「功能已
//    關閉」提示),理由是後端關閉後仍放行「手動調整 / 登記兌換」、要留一條結清餘額的路。
//    **2026-09-29 第三輪使用者裁決推翻這個判斷**,恢復 #617 原本的行為:關閉時整張卡片隱藏。
//    使用者原話:「關閉後其實隱藏也可以,因為開啟功能時才可以使用,隱藏後紅利也不再計點,而且也
//    不再能使用折抵,所以隱藏沒問題。」
//    連帶結果(使用者已知悉並接受):功能關閉期間前端沒有任何結清點數的入口;商家要結清某位會員的
//    剩餘點數,必須先到「紅利點數管理」把功能重新開啟 → 到這裡結清 → 再關閉。後端在關閉時仍放行
//    adjust/redeem(migration 20260924030000)刻意不動,只是前端不再提供入口。
//    ⚠️ 下一個人若又覺得「這樣沒辦法結清」而想改回顯示,請先看上面那句使用者原話,不要再改回去。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader,狀態標籤改 StatusTag;「編輯」是這一頁唯一的 ① 主要按鈕(二之三)。
//   - 🔴「編輯會員資料」有 7 個欄位 ⇒ 依 skill 三「📐 分類原則」改成**全頁層**(超過 3 欄、要捲);
//     「列入黑名單」只有 1 欄 ⇒ **小卡窗**。兩個殼都不再自己寫 max-w-*。
//   - 基本資料改用明細列 DetailRows(二之六):分組 + 11px 小標、標籤淡值粗、數字 tabular-nums,
//     兩側都能折行(兩側都可能是使用者自己填的文字)。
//   - 🔴 電話改成可點擊的 DetailPhoneRow(tel: 直接撥號,右側標「撥號」)—— 二之六點名要求的。
//   - 🔴 會員備註改成 InternalNote(灰底 + 🔒 標記「客戶看不到,服務人員看得到」)。二之六明寫
//     兩種備註要分開,而會員備註就是「自己人看的」那一種;不講清楚誰看得到,商家會把不該讓
//     服務人員知道的事寫進去。
//   - 🔴「列入黑名單」原本是實心紅(variant="destructive"),改成 ② 次要:黑名單是**可逆**的
//     (旁邊就有「解除黑名單」),而且它不刪任何資料。紅色只留給真正不可逆的刪除
//     (第 1 / 2 批已定案的裁決);實心紅還會讓最危險的動作變成視覺上最好按的那一顆(二之三)。
//     「解除黑名單」同理維持次要。
//   - 相關訂單 / 推薦名單改 ListCard(二之五),推薦名單的「查看」做成真正的 <Link>(可右鍵開新分頁)。
//   - 載入中改灰色骨架;找不到會員改 ErrorState(講什麼壞了 / 可能原因 / 下一步 +「資料沒有遺失」)。
//
// 📌 相關訂單 / 推薦名單的空狀態刻意**不放下一步按鈕**(EmptyState.action 的例外條款):
//    這兩塊是「這位會員目前的事實」,不是待辦。真正的下一步(建一張單)在行事曆,從會員詳情頁
//    放一顆跳走的按鈕,只會把正在看這位會員的人帶離現場。已列入回報請主腦裁決。
//
// **只動外觀,不動行為**:編輯 / 黑名單 / 電話驗證標記 / 解除黑名單的 API 呼叫與驗證、
// points_feature_enabled 關閉時整張點數卡片隱藏、推薦人唯讀、複製推薦碼的 1.5 秒回饋全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AttributeTag,
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  CardDialogTrigger,
  DetailPhoneRow,
  DetailRow,
  DetailSection,
  EmptyState,
  ErrorState,
  FieldDate,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  FullPageLayerTrigger,
  InternalNote,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// 2026-09-24 稽核修正(問題 3):Radix Select 幽靈空值事件的共用防護,見該檔案開頭的完整說明。
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { isValidTaiwanPhone, TW_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { MemberLineBindingSection } from "@/modules/line-notifications/MemberLineBindingSection";

import {
  setMemberBlacklistStatus,
  setMemberPhoneVerified,
  updateMember,
  useMember,
  useMemberReferrals,
  useMemberRelatedBookings,
  useMerchantMemberSettings,
  useMerchantMemberTiers,
} from "./api";
import { MemberPointsPanel } from "./MemberPointsPanel";
import { RequireMembersAccess } from "./RequireMembersAccess";
import { MEMBER_STATUS_LABELS, type Member } from "./types";

const UNASSIGNED_TIER_VALUE = "__unassigned__";

/** 全頁層 / 小卡窗的按鈕列在 form 外面(位置由殼決定),送出鈕用 form= 指回來。 */
const EDIT_MEMBER_FORM_ID = "edit-member-form";
const BLACKLIST_FORM_ID = "blacklist-member-form";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

// ---------------------------------------------------------------------------
// 編輯基本資料 Dialog。推薦人只能唯讀顯示,不可編輯(判斷:推薦關係只在建立當下決定)。
// ---------------------------------------------------------------------------
function EditMemberDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: tiers } = useMerchantMemberTiers(member.merchant_id, true);
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone ?? "");
  const [email, setEmail] = useState(member.email ?? "");
  const [birthday, setBirthday] = useState(member.birthday ?? "");
  const [notes, setNotes] = useState(member.notes ?? "");
  const [tierId, setTierId] = useState(member.tier_id ?? UNASSIGNED_TIER_VALUE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(member.name);
      setPhone(member.phone ?? "");
      setEmail(member.email ?? "");
      setBirthday(member.birthday ?? "");
      setNotes(member.notes ?? "");
      setTierId(member.tier_id ?? UNASSIGNED_TIER_VALUE);
    }
  }, [open, member]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫會員姓名");
      return;
    }
    // SPECS-INDEX #822:會員電話是選填,留空放行;填了就套客戶電話規則(手機或市話,見 validation.ts)。
    // 舊會員如果留著不合規的舊電話,編輯時會被要求先改正(舊資料本身依使用者裁決不主動清)。
    if (phone.trim() && !isValidTaiwanPhone(phone)) {
      toast.error(TW_PHONE_ERROR_MESSAGE);
      return;
    }
    setSaving(true);
    try {
      await updateMember(member.id, {
        name: name.trim(),
        phone: phone.trim() ? phone.trim() : null,
        email: email.trim() ? email.trim() : null,
        birthday: birthday.trim() ? birthday.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        tierId: tierId === UNASSIGNED_TIER_VALUE ? null : tierId,
      });
      toast.success("已更新會員資料");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={setOpen}>
      <FullPageLayerTrigger asChild>
        {/* 「編輯」永遠是主要動作(skill 二之三),這一頁只有這一顆 ① 主要按鈕。 */}
        <Button type="button" variant="primary" size="touch">
          編輯
        </Button>
      </FullPageLayerTrigger>
      {/* 7 個欄位、一定要捲 ⇒ 全頁層(skill 三「📐 分類原則」)。 */}
      <FullPageLayerContent
        title="編輯會員資料"
        subtitle="只有姓名是必填的。推薦人不能改 —— 推薦獎勵是依建立當下那筆關係核發的。"
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={EDIT_MEMBER_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </ActionBar>
        }
      >
        <form onSubmit={handleSubmit} id={EDIT_MEMBER_FORM_ID} className="flex flex-col gap-4">
          <FormField label="姓名" htmlFor="edit-member-name" required>
            <FieldInput
              id="edit-member-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField
            label="電話"
            htmlFor="edit-member-phone"
            help="電話是選填,留空也可以。它只是用來在建單時查出這位客戶,不是會員的唯一身分。要填的話手機或市話都可以。"
            helpLabel="說明:會員電話要不要填、有什麼用"
          >
            <FieldInput
              id="edit-member-phone"
              type="tel"
              inputMode="tel"
              className="tabular-nums"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </FormField>
          <FormField label="Email" htmlFor="edit-member-email">
            <FieldInput
              id="edit-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <FormField
            label="生日"
            htmlFor="edit-member-birthday"
            help="填了生日,系統才會在生日當月自動核發生日獎勵(依台北時區比對生日的月、日)。"
            helpLabel="說明:填生日會發生什麼事"
          >
            <FieldDate
              id="edit-member-birthday"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </FormField>
          {/* #615(SPECS-INDEX):會員等級,選填,可隨時重新指派。 */}
          <FormField label="會員等級" htmlFor="edit-member-tier">
            {/* 2026-09-24 稽核修正(問題 3):tierId 是在 useEffect 裡等 member 資料回來之後
                才重設的(見上面 setTierId(member.tier_id ?? UNASSIGNED_TIER_VALUE)),
                正是會觸發幽靈空值事件的時序——被洗成空字串的話,會員等級會顯示成空白,
                存檔就把使用者原本設好的等級清掉。
                合法值是 UNASSIGNED_TIER_VALUE 這個 sentinel 加上資料庫來的動態等級 id,
                沒有固定白名單,判斷條件是「不是空字串」。 */}
            <FieldSelect
              id="edit-member-tier"
              value={tierId}
              onValueChange={guardPhantomEmptyChange(setTierId)}
              options={[
                { value: UNASSIGNED_TIER_VALUE, label: "未分級" },
                ...(tiers ?? []).map((tier) => ({ value: tier.id, label: tier.name })),
              ]}
            />
          </FormField>
          <FormField label="推薦人">
            {/* 🟡 這是「為什麼這一格不能改」⇒ 常駐說明,不收進 `?`(skill 二,第一類)。 */}
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
              推薦人只能在建立會員時設定,之後無法變更。
            </p>
          </FormField>
          <FormField label="備註" htmlFor="edit-member-notes">
            <FieldTextarea
              id="edit-member-notes"
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

/** #616(SPECS-INDEX §10.4):列入黑名單需要輸入原因(必填,函式層檢查)。解除黑名單不需要
 * 額外輸入,直接呼叫。這不是最高權限敏感操作,依既有 members 權限判斷,管理員跟被授權的客服
 * 都可以操作(規則 2.10 既有分類原則)。 */
function BlacklistDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error("請輸入列入黑名單的原因");
      return;
    }
    setSaving(true);
    try {
      await setMemberBlacklistStatus(member.id, true, reason.trim());
      toast.success("已列入黑名單");
      setOpen(false);
      setReason("");
      onSaved();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog open={open} onOpenChange={setOpen}>
      <CardDialogTrigger asChild>
        {/* 🔴 不標紅:黑名單是可逆的(旁邊就有「解除黑名單」),而且不刪任何資料 ⇒ ② 次要。
            原本是實心紅(variant="destructive"),那違反 skill 二之三「危險動作不做實心紅」
            與第 1 / 2 批「可逆動作不標紅」的裁決。 */}
        <Button type="button" variant="neutral" size="card">
          列入黑名單
        </Button>
      </CardDialogTrigger>
      {/* 只有 1 個欄位 ⇒ 小卡窗(skill 三「📐 分類原則」第 3 點)。 */}
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>列入黑名單</CardDialogTitle>
          <CardDialogDescription>
            純警告用途,不會阻擋這位客戶之後的建單。這個狀態不會顯示給客戶端看見。
          </CardDialogDescription>
        </CardDialogHeader>
        <form onSubmit={handleSubmit} id={BLACKLIST_FORM_ID}>
          <FormField
            label="原因"
            htmlFor="blacklist-reason"
            required
            help="之後有人在建單時選到這位客戶,系統會把這個原因一起顯示出來提醒他,所以寫得越具體越有用(例:多次預約未到)。"
            helpLabel="說明:黑名單原因會顯示在哪裡"
          >
            <FieldTextarea
              id="blacklist-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={BLACKLIST_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "處理中⋯" : "確認列入黑名單"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

function MemberDetailInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { merchant } = useCurrentMerchant();
  const { data: memberSettings } = useMerchantMemberSettings(merchant?.id ?? null);
  const pointsFeatureEnabled = memberSettings?.points_feature_enabled !== false;

  const { data: member, isLoading } = useMember(id);
  const { data: relatedBookings } = useMemberRelatedBookings(id);
  const { data: referrals } = useMemberReferrals(id);
  // #615(SPECS-INDEX):會員等級名稱顯示,查詢範圍是「這位會員所屬商家」的等級清單(含已下架的,
  // 因為這位會員目前指派的等級可能剛好已被下架,下架不會連帶清空既有會員的 tier_id)。
  const { data: tiers } = useMerchantMemberTiers(member?.merchant_id, false);
  const tierNameById = new Map((tiers ?? []).map((t) => [t.id, t.name]));

  const [verifying, setVerifying] = useState(false);
  const [copyLabel, setCopyLabel] = useState("複製");

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["members-module", "member-detail", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "related-bookings", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "referrals", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  async function handleToggleVerified() {
    if (!member) return;
    setVerifying(true);
    try {
      await setMemberPhoneVerified(member.id, !member.phone_verified);
      toast.success(member.phone_verified ? "已取消驗證標記" : "已標記為已驗證");
      refetchAll();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setVerifying(false);
    }
  }

  async function handleUnblacklist() {
    if (!member) return;
    try {
      await setMemberBlacklistStatus(member.id, false);
      toast.success("已解除黑名單");
      refetchAll();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleCopyReferralCode() {
    if (!member) return;
    try {
      await navigator.clipboard.writeText(member.referral_code);
      setCopyLabel("已複製");
      setTimeout(() => setCopyLabel("複製"), 1500);
    } catch {
      toast.error("複製失敗,請手動抄寫推薦碼");
    }
  }

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架,不要用「載入中⋯」四個字。
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
        <LoadingSkeleton variant="lines" rows={3} />
        <LoadingSkeleton variant="cards" rows={3} />
      </main>
    );
  }

  if (!member) {
    // skill 二之八:出錯要講三件事(什麼壞了 / 可能原因 / 下一步)+「你的資料沒有遺失」
    //(那句由 ErrorState 固定加上)。
    return (
      <main className="mx-auto max-w-2xl px-5 py-12">
        <ErrorState
          title="找不到這位會員"
          reason="可能已經被下架、或是這位會員不屬於你目前選的這間商家"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app/members">回到會員管理</Link>
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/members"
        backLabel="返回會員管理"
        title={member.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {member.status === "active" ? (
              <StatusTag tone="success">{MEMBER_STATUS_LABELS.active}</StatusTag>
            ) : (
              <StatusTag tone="neutral">{MEMBER_STATUS_LABELS.removed}</StatusTag>
            )}
            {member.is_blacklisted ? <StatusTag tone="danger">黑名單</StatusTag> : null}
          </span>
        }
        action={<EditMemberDialog member={member} onSaved={refetchAll} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>基本資料</CardTitle>
        </CardHeader>
        {/* skill 二之六 明細列:分組 + 小標、標籤淡值粗、兩側都能折行、數字 tabular-nums。 */}
        <CardContent className="flex flex-col gap-5 text-sm">
          <DetailSection label="聯絡方式">
            {/* 🔴 二之六:電話做成可點擊(tel: 直接撥號),各佔一行不要並排。 */}
            {member.phone ? (
              <DetailPhoneRow phone={member.phone} />
            ) : (
              <DetailRow label="電話">未填寫</DetailRow>
            )}
            <DetailRow label="Email">{member.email ?? "未填寫"}</DetailRow>
            <DetailRow label="生日">{member.birthday ?? "未填寫"}</DetailRow>
          </DetailSection>

          <DetailSection label="會員資訊">
            <DetailRow label="推薦碼">
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums">
                  {member.referral_code}
                </code>
                <Button type="button" variant="text" size="card" onClick={handleCopyReferralCode}>
                  {copyLabel}
                </Button>
              </span>
            </DetailRow>
            {/* #615(SPECS-INDEX):會員等級顯示(唯讀,編輯入口在上方「編輯」按鈕的表單裡)。 */}
            <DetailRow label="會員等級">
              {member.tier_id && tierNameById.has(member.tier_id)
                ? tierNameById.get(member.tier_id)
                : "未分級"}
            </DetailRow>
          </DetailSection>

          <DetailSection label="標記">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] text-muted-foreground">電話驗證狀態</p>
                <p className="text-xs text-muted-foreground">此為人工標記,非簡訊驗證</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {member.phone_verified ? (
                  <StatusTag tone="success">已驗證</StatusTag>
                ) : (
                  <StatusTag tone="neutral">未驗證</StatusTag>
                )}
                {/* 可逆動作(隨時可以取消 / 重新標記)⇒ 不標紅,用 ② 次要。 */}
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  disabled={verifying}
                  onClick={handleToggleVerified}
                >
                  {member.phone_verified ? "取消驗證標記" : "標記為已驗證"}
                </Button>
              </div>
            </div>
            {/* #616(SPECS-INDEX §10.4):黑名單狀態,純警告用途,不擋建單,不顯示給客戶端看見。 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] text-muted-foreground">黑名單狀態</p>
                {member.is_blacklisted && member.blacklist_reason ? (
                  <p className="break-words text-xs text-muted-foreground">
                    原因:{member.blacklist_reason}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {member.is_blacklisted ? (
                  <>
                    <StatusTag tone="danger">黑名單</StatusTag>
                    {/* 可逆動作 ⇒ 不標紅,用 ② 次要。 */}
                    <Button type="button" variant="neutral" size="card" onClick={handleUnblacklist}>
                      解除黑名單
                    </Button>
                  </>
                ) : (
                  <BlacklistDialog member={member} onSaved={refetchAll} />
                )}
              </div>
            </div>
          </DetailSection>

          {member.notes ? (
            <DetailSection label="備註">
              {/* 🔴 二之六:兩種備註要分開。會員備註是「自己人看的」那一種 ⇒ InternalNote
                  (灰底 + 🔒 標記「客戶看不到,服務人員看得到」)。不講清楚誰看得到,
                  商家會把不該讓服務人員知道的事寫進去。 */}
              <InternalNote>{member.notes}</InternalNote>
            </DetailSection>
          ) : null}
        </CardContent>
      </Card>

      {/* 模組 11(LINE 通知)§4.7:會員詳情頁疊加「LINE 綁定」區塊,歸在既有 members 權限底下
          (第〇節判斷 3/5),不是本模組新增的權限項目。 */}
      <Card>
        <CardHeader>
          <CardTitle>LINE 綁定</CardTitle>
        </CardHeader>
        <CardContent>
          <MemberLineBindingSection memberId={member.id} />
        </CardContent>
      </Card>

      {/* SPECS-INDEX #830:點數卡片改成完整的操作面板(餘額 + 登記兌換 / 手動調整 + 異動歷史),
          從 MemberPointsPage.tsx 搬回來,見檔案開頭說明。
          points_feature_enabled 關閉時整張卡片隱藏(#617 原行為;#830 第一版改成仍顯示,
          2026-09-29 使用者裁決推翻、改回隱藏,原話與連帶結果見檔案開頭)。連帶:關閉期間要結清點數
          必須先重新開啟功能 → 結清 → 再關閉,這是使用者知悉並接受的,不要為了「沒地方結清」再改回顯示。 */}
      {pointsFeatureEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>點數</CardTitle>
          </CardHeader>
          <CardContent>
            <MemberPointsPanel member={member} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>相關訂單</CardTitle>
        </CardHeader>
        <CardContent>
          {!relatedBookings || relatedBookings.length === 0 ? (
            // 📌 這是「這位會員目前的事實」,不是待辦 ⇒ 不放跳走的下一步按鈕(見檔頭說明)。
            <EmptyState
              title="這位會員目前沒有連結任何訂單"
              description="在行事曆建單時,輸入這位會員的電話並選到他,那張單就會出現在這裡。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {relatedBookings.map((booking) => (
                <li key={booking.id}>
                  <ListCard
                    title={<span className="tabular-nums">{formatDateTime(booking.startAt)}</span>}
                    tags={
                      <>
                        <AttributeTag className="tabular-nums">
                          ${Number(booking.finalAmountSnapshot).toFixed(0)}
                        </AttributeTag>
                        <AttributeTag className="tabular-nums">
                          {booking.earnedPoints !== null
                            ? `已核發 ${booking.earnedPoints} 點`
                            : "未核發點數"}
                        </AttributeTag>
                      </>
                    }
                    meta={booking.serviceItemNames.join("、") || "—"}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>推薦名單</CardTitle>
        </CardHeader>
        <CardContent>
          {!referrals || referrals.length === 0 ? (
            // 📌 同上:這是事實不是待辦,不放跳走的下一步按鈕。
            <EmptyState
              title="這位會員目前還沒有推薦過任何人"
              description="把他的推薦碼給新客戶,新客戶建立會員時填上,就會出現在這裡並自動核發推薦獎勵。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {referrals.map((r) => (
                <li key={r.id}>
                  <ListCard
                    state={r.status === "active" ? "default" : "inactive"}
                    title={r.name}
                    tags={
                      <>
                        {r.status === "active" ? (
                          <StatusTag tone="success">{MEMBER_STATUS_LABELS.active}</StatusTag>
                        ) : (
                          <StatusTag tone="neutral">{MEMBER_STATUS_LABELS.removed}</StatusTag>
                        )}
                        <AttributeTag wrap>
                          {r.referralRewardedAt ? "已核發推薦獎勵" : "尚未核發推薦獎勵"}
                        </AttributeTag>
                      </>
                    }
                    onClick={() => navigate(`/app/members/${r.id}`)}
                    primaryAction={
                      // 會跳頁 ⇒ 真正的 <a href>,可以右鍵 / 中鍵開新分頁(第 1 / 2 批已定案的裁決)。
                      <Button asChild variant="neutral" size="card">
                        <Link to={`/app/members/${r.id}`}>查看</Link>
                      </Button>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function MemberDetailPage() {
  return (
    <RequireMembersAccess>
      <MemberDetailInner />
    </RequireMembersAccess>
  );
}
