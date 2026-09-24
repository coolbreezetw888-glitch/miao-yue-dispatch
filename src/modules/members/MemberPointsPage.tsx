// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」):紅利點數功能從會員詳情頁移出,
// 在「功能」選單新開一張獨立卡片(新路由 /app/member-points),集中管理跟點數相關的操作:
//   1. 各會員點數餘額總覽清單(搜尋姓名/電話,顯示目前餘額)。
//   2. 點擊個別會員可以看到完整點數異動歷史(複用既有 get_member_point_history)。
//   3. 「手動調整」入口(複用既有 adjust_member_points,維持「僅商家管理員」的既有權限邊界)。
//   4. 「登記兌換」入口(複用既有 redeem_member_points)。
//   5. 點數設定(消費點數比例/推薦獎勵/生日贈點)——此項描述已被下方 #642 取代,見該段說明。
//
// #639(.project/specs/會員與紅利.md §10.5,推翻 #617 當初這條判斷):使用者實測後認為「啟用
// 開關留在會員系統設定頁、這裡只放連結」體驗不好,改成「啟用紅利點數功能」開關(讀寫
// merchant_member_settings.points_feature_enabled)搬進這頁的「點數設定」卡片直接操作。資料庫
// 欄位、upsertMerchantMemberSettings() 這個 API 完全沒變,upsert 是整列覆蓋,所以這裡切換開關時
// 要把 settings 目前其他欄位原樣帶回去,不能只送 pointsFeatureEnabled。停用時這頁本身仍可操作
// (查看/調整既有點數資料方便帳務校正)的既有行為不受影響。
// ⚠️ #639 當初這段還寫著「停用只有隱藏建單表單/會員詳情頁的點數入口,這條規則維持不變」——
//    那句話在 2026-09-24 已經**不再正確**,被下方「開關語意升級」那段取代,見該段說明。
//
// #642(.project/specs/會員與紅利.md §10.5,#639 的延續收尾):消費點數比例/推薦獎勵/生日贈點
// 三個數字欄位(含說明文字、範例試算、儲存按鈕)這次也從會員系統設定頁整個搬過來這頁的「點數
// 設定」卡片,跟 #639 已經搬過去的啟用開關放在一起,不再有連回會員系統設定頁的連結——「點數
// 設定」卡片現在一次管理 4 個欄位(啟用開關+消費點數比例+推薦獎勵+生日贈點),共用同一套
// saveSettingsRow() 整列 upsert helper,啟用開關切換跟三個數字欄位的「儲存」按鈕各自都會把
// settings 目前其他欄位原樣帶回去,避免互相覆蓋。
//
// 2026-09-24 使用者裁決(#642 的延續收尾):「核發獎勵資格條件」(reward_condition_mode)整個區塊
// 從 MemberSettingsPage.tsx 搬到這頁,放在「點數設定」卡片**上方**。理由:這個欄位控制的是「什麼樣
// 的會員才拿得到點數」,只跟點數有關,#617 把紅利點數獨立成一頁時是被漏掉的。搬過來後這頁的儲存
// 一律走同一套 saveSettingsRow() 整列 upsert helper,所以下拉選單改值時也會把 settings 目前其他
// 欄位(含會員政策)原樣帶回去,不會互相覆蓋。下拉選單套上 guardPhantomEmptyChange 白名單版防護
// ——這頁的 value 正是「掛載後才由 useEffect 從資料庫灌進來」的典型情境,不套會被幽靈空值洗掉。
//
// 2026-09-24 使用者裁決(「啟用紅利點數功能」開關語意升級,後端由 migration
// 20260924030000_points_feature_enabled_backend_enforcement 落實):使用者裁決原文「關閉後就不
// 計算點數了。」points_feature_enabled 從「純前端顯示開關」升級成「後端會不會自動產生新點數」的
// 真正開關。這頁**沒有任何程式邏輯要跟著改**(開關的讀寫方式完全沒變),要改的是說明文字——
// 原本開關說明跟「功能已關閉」警示條都只講「畫面會隱藏」,沒講會真的停止累積,那是商家最需要
// 知道的一件事(關掉之後客人消費就真的拿不到點數了),兩處都已改寫。新行為:
//   ・關閉後會停止(系統自動發點,商家沒機會逐筆確認):消費累點、推薦獎勵、生日贈點。
//   ・關閉後仍然可用(商家主動操作、要填原因/用途):手動調整點數、登記兌換——刻意不擋,
//     否則商家關掉功能後反而卡在一堆清不掉的既有餘額上,無法收尾。
//   ・既有的點數餘額與異動歷史一律不清空,重新開啟後完整還原顯示(#617 當初的決定沒變)。
// 這也是為什麼這頁停用時「本身仍可操作」的既有行為依然正確:手動調整/登記兌換就是後端刻意
// 放行的兩條路徑,跟這頁不隱藏任何操作入口的既有 UI 行為是一致的,不需要改。
//
// 支援 ?member=<id> query 參數直接帶入某位會員(會員詳情頁「查看完整點數紀錄」連結會這樣用)。
//
// RedeemPointsDialog/AdjustPointsDialog 這兩個 Dialog 元件是從 MemberDetailPage.tsx 搬過來的
// (該頁面的「點數」卡片這次簡化成摘要 + 連結,完整操作集中到這裡,避免兩邊重複維護)。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  adjustMemberPoints,
  redeemMemberPoints,
  upsertMerchantMemberSettings,
  useMember,
  useMemberPointHistory,
  useMerchantMemberSettings,
  useMerchantMembersList,
  type UpsertMerchantMemberSettingsInput,
} from "./api";
import { previewLoyaltyPoints } from "./previewCalculators";
import { RequireMemberPointsAccess } from "./RequireMemberPointsAccess";
import {
  MEMBER_POINT_TRANSACTION_TYPE_LABELS,
  REWARD_CONDITION_MODE_LABELS,
  type Member,
  type MemberSummary,
  type RewardConditionMode,
} from "./types";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function RedeemPointsDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const numericPoints = Number(points);
    if (!Number.isInteger(numericPoints) || numericPoints <= 0) {
      toast.error("兌換點數必須是大於 0 的整數");
      return;
    }
    if (!note.trim()) {
      toast.error("請說明這次兌換的用途");
      return;
    }
    setSaving(true);
    try {
      await redeemMemberPoints(member.id, numericPoints, note.trim());
      toast.success("已登記兌換");
      setOpen(false);
      setPoints("");
      setNote("");
      onSaved();
    } catch (err) {
      toast.error("兌換失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          登記兌換
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>登記兌換點數</DialogTitle>
          <DialogDescription>
            目前餘額 {member.points_balance}{" "}
            點。這裡只登記點數異動紀錄,不會自動反映在任何訂單金額上。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="redeem-points">兌換點數 *</Label>
            <Input
              id="redeem-points"
              type="number"
              min={1}
              className="mt-2"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="redeem-note">用途說明 *</Label>
            <Textarea
              id="redeem-note"
              className="mt-2"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "處理中⋯" : "確認兌換"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 規則 2.6(核心):這個按鈕只有商家管理員看得到,依 merchantRole==='admin' 判斷,不是依
 * useAgentPermission——這個操作本來就不透過 section_key 開放。 */
function AdjustPointsDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const numericDelta = Number(delta);
    if (!Number.isInteger(numericDelta) || numericDelta === 0) {
      toast.error("調整點數必須是不為 0 的整數(正數增加、負數扣除)");
      return;
    }
    if (!note.trim()) {
      toast.error("請填寫調整原因");
      return;
    }
    setSaving(true);
    try {
      await adjustMemberPoints(member.id, numericDelta, note.trim());
      toast.success("已調整點數");
      setOpen(false);
      setDelta("");
      setNote("");
      onSaved();
    } catch (err) {
      toast.error("調整失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          手動調整
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>手動調整點數</DialogTitle>
          <DialogDescription>
            目前餘額 {member.points_balance} 點,不能調整成負數。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="adjust-delta">調整點數 *</Label>
            <Input
              id="adjust-delta"
              type="number"
              className="mt-2"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="正數增加、負數扣除"
            />
          </div>
          <div>
            <Label htmlFor="adjust-note">調整原因 *</Label>
            <Textarea
              id="adjust-note"
              className="mt-2"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "處理中⋯" : "確認調整"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 點擊清單裡某位會員之後顯示的完整點數異動歷史 + 兌換/調整入口。 */
function MemberPointsDetail({ memberId }: { memberId: string }) {
  const queryClient = useQueryClient();
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";

  const { data: member, isLoading } = useMember(memberId);
  const { data: pointHistory } = useMemberPointHistory(memberId);

  function refetch() {
    void queryClient.invalidateQueries({ queryKey: ["members-module", "member-detail", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "point-history", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }
  if (!member) {
    return <p className="text-sm text-muted-foreground">找不到這位會員(可能已被移除)。</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{member.name}</CardTitle>
          <CardDescription>{member.phone ?? "未填寫電話"}</CardDescription>
        </div>
        <Link to={`/app/members/${member.id}`} className="text-sm text-brand hover:underline">
          查看會員基本資料 →
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-3xl font-bold text-foreground">{member.points_balance} 點</p>
        <div className="flex flex-wrap gap-2">
          <RedeemPointsDialog member={member} onSaved={refetch} />
          {isAdmin ? <AdjustPointsDialog member={member} onSaved={refetch} /> : null}
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">異動歷史</p>
          {!pointHistory || pointHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有任何點數異動紀錄。</p>
          ) : (
            <ul className="space-y-1.5">
              {pointHistory.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="text-foreground">
                      {MEMBER_POINT_TRANSACTION_TYPE_LABELS[entry.transactionType]}
                      {entry.relatedMemberName ? `(${entry.relatedMemberName})` : ""}
                    </p>
                    {entry.note ? <p className="text-muted-foreground">{entry.note}</p> : null}
                    <p className="text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={entry.pointsDelta > 0 ? "text-cta" : "text-destructive"}>
                      {entry.pointsDelta > 0 ? "+" : ""}
                      {entry.pointsDelta}
                    </p>
                    <p className="text-muted-foreground">餘額 {entry.balanceAfter}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MemberPointsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [savingFeatureToggle, setSavingFeatureToggle] = useState(false);

  // #642:消費點數比例/推薦獎勵/生日贈點三個欄位的編輯 state,從 MemberSettingsPage.tsx 搬過來。
  const [pointsEarnRate, setPointsEarnRate] = useState("0");
  const [referralBonusPoints, setReferralBonusPoints] = useState("0");
  const [birthdayBonusPoints, setBirthdayBonusPoints] = useState("0");
  const [savingPoints, setSavingPoints] = useState(false);

  // 2026-09-24 使用者裁決:「核發獎勵資格條件」從 MemberSettingsPage.tsx 搬過來。這個 state 是
  // 「顯示用 + 立即回饋用」的本地值——下拉選單改值後要馬上反映在畫面上,不能等 invalidateQueries
  // 重新抓回 settings 才更新,否則使用者會看到選單彈回舊值。
  const [rewardConditionMode, setRewardConditionMode] = useState<RewardConditionMode>("none");
  const [savingRewardCondition, setSavingRewardCondition] = useState(false);

  // =======================================================================
  // 2026-09-24 使用者裁決(紅利點數管理頁分成「交易」與「規則」兩段權限)。使用者原文:
  //   餘額總覽、手動調整、登記兌換、異動歷史 = 會員管理(members)
  //   核發獎勵資格條件、點數設定(啟用開關/比例/推薦/生日) = 紅利點數管理(member_points)
  // 也就是同一頁由兩把鑰匙共管:交易歸既有的 members,規則歸新增的 member_points。
  // 整頁的進入守衛(RequireMemberPointsAccess)刻意「維持只認 members」——否則只有交易權限的
  // 客服連這一頁都進不去,就違反使用者「客服可以處理會員管理內的資料包含紅利點數異動等等」的裁決。
  //
  // 判斷寫法沿用專案既有慣例(CalendarPage.tsx canManageDayOverride、LeaveTypesPage.tsx
  // showDeductionRuleButton 這兩處「頁面層一把鑰匙、區塊層另一把鑰匙」的先例),不自創新寫法:
  // merchantRole === 'admin' 一律放行,agent 才需要 useAgentPermission 為 true。
  // ⚠️ 這行就是使用者特別交代「商家管理員一定要全部看得到」那一點的落實處:admin 直接短路,
  //    完全不看 member_points 開關(客服權限開關只對 agent 生效);merchantRole === 'staff' 或
  //    null 的人本來就過不了頁面守衛,到不了這裡。
  //
  // ✅ 資料庫端已上線(migration 20260924040400_member_points_permission_and_rules_guard,
  //    private.can_manage_member_points() 與規則欄位的寫入鎖),所以前後端兩層防線都在。
  //    但這裡仍然刻意「不」依賴那支函式——useAgentPermission() 讀的是 merchant_agent_permissions
  //    這張表(section_key = 'member_points'),那張表今天就已經存在、也沒有 section_key 白名單
  //    約束,所以前端這一半是獨立成立的。查不到權限列時 useAgentPermission 的
  //    既有行為是 `data?.granted ?? false`,也就是 fail-closed(預設關閉):在商家管理員實際去
  //    勾選這把新鑰匙之前,客服只看得到交易那一半。刻意選 fail-closed 而不是 fail-open,理由是
  //    「規則」會直接影響之後每一筆訂單發出去的點數,寧可讓商家多勾一次開關,也不要讓從來沒被
  //    明確授權過的客服默默保有改規則的能力。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageMemberPointsRules } = useAgentPermission("member_points");
  const canManagePointsRules =
    merchantRole === "admin" || (merchantRole === "agent" && canManageMemberPointsRules === true);

  const selectedMemberId = searchParams.get("member");
  const { data: settings, isLoading: settingsLoading } = useMerchantMemberSettings(merchantId);
  const { data: members, isLoading } = useMerchantMembersList(merchantId, search);
  const activeMembers: MemberSummary[] = (members ?? []).filter((m) => m.status === "active");

  useEffect(() => {
    if (!settings) return;
    setPointsEarnRate(String(settings.points_earn_rate));
    setReferralBonusPoints(String(settings.referral_bonus_points));
    setBirthdayBonusPoints(String(settings.birthday_bonus_points));
    setRewardConditionMode(settings.reward_condition_mode as RewardConditionMode);
  }, [settings]);

  const numericRate = Number(pointsEarnRate);
  const numericReferral = Number(referralBonusPoints);
  const numericBirthday = Number(birthdayBonusPoints);

  function selectMember(memberId: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("member", memberId);
      return next;
    });
  }

  // #639/#642(.project/specs/會員與紅利.md §10.5):「點數設定」卡片現在一次管理 4 個欄位(啟用
  // 開關+消費點數比例+推薦獎勵+生日贈點),但 upsertMerchantMemberSettings 是整列 upsert,不是
  // 局部更新——不管改的是哪一格,都要把 settings 目前其他欄位(含核發資格條件/會員政策)原樣
  // 帶回去,只換有異動的那幾格,否則會把其他設定值覆蓋掉。
  async function saveSettingsRow(overrides: Partial<UpsertMerchantMemberSettingsInput>) {
    if (!settings) return;
    await upsertMerchantMemberSettings(merchantId, {
      pointsEarnRate: settings.points_earn_rate,
      referralBonusPoints: settings.referral_bonus_points,
      birthdayBonusPoints: settings.birthday_bonus_points,
      pointsFeatureEnabled: settings.points_feature_enabled,
      rewardConditionMode: settings.reward_condition_mode as RewardConditionMode,
      policyEnabled: settings.policy_enabled,
      policyContent: settings.policy_content,
      ...overrides,
    });
    await queryClient.invalidateQueries({
      queryKey: ["members-module", "merchant-member-settings", merchantId],
    });
  }

  async function handleToggleFeatureEnabled(next: boolean) {
    setSavingFeatureToggle(true);
    try {
      await saveSettingsRow({ pointsFeatureEnabled: next });
      toast.success(next ? "已啟用紅利點數功能" : "已停用紅利點數功能");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingFeatureToggle(false);
    }
  }

  // 2026-09-24 使用者裁決:核發獎勵資格條件的儲存邏輯,從 MemberSettingsPage.tsx 的
  // handleSaveRewardCondition() 搬過來,改接這頁既有的 saveSettingsRow() 整列 upsert helper
  // (原本在會員系統設定頁走的是那頁自己的 saveSettings())。沿用「選了就直接存」的既有行為,
  // 這張卡片不另外放儲存按鈕。存檔失敗時把選單退回資料庫目前的值,避免畫面停在沒存進去的選項。
  async function handleSaveRewardCondition(next: RewardConditionMode) {
    setRewardConditionMode(next);
    setSavingRewardCondition(true);
    try {
      await saveSettingsRow({ rewardConditionMode: next });
      toast.success("已更新核發獎勵資格條件");
    } catch (err) {
      setRewardConditionMode(
        (settings?.reward_condition_mode as RewardConditionMode | undefined) ?? "none",
      );
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingRewardCondition(false);
    }
  }

  // #642:消費點數比例/推薦獎勵/生日贈點三個欄位的驗證+儲存邏輯,從 MemberSettingsPage.tsx 的
  // handleSavePoints() 原樣搬過來。
  async function handleSavePoints() {
    if (Number.isNaN(numericRate) || numericRate < 0) {
      toast.error("消費點數比例不可為負數");
      return;
    }
    if (!Number.isInteger(numericReferral) || numericReferral < 0) {
      toast.error("推薦獎勵點數必須是不小於 0 的整數");
      return;
    }
    if (!Number.isInteger(numericBirthday) || numericBirthday < 0) {
      toast.error("生日贈點必須是不小於 0 的整數");
      return;
    }
    setSavingPoints(true);
    try {
      await saveSettingsRow({
        pointsEarnRate: numericRate,
        referralBonusPoints: numericReferral,
        birthdayBonusPoints: numericBirthday,
      });
      toast.success("已更新紅利點數設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingPoints(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">紅利點數管理</h1>
        {/* 2026-09-24 使用者裁決:這頁分成「交易」與「規則」兩段權限之後,頁面描述也要跟著分流
            ——只有交易權限的客服看到的畫面裡根本沒有那兩張規則卡片,如果還寫「核發獎勵資格條件、
            點數設定也在這裡操作」,對方會一直在頁面上找一個他看不到的東西。 */}
        <p className="mt-1 text-sm text-muted-foreground">
          {canManagePointsRules
            ? `「${merchant!.name}」會員的點數餘額總覽、手動調整、登記兌換與異動歷史,以及核發獎勵資格條件、點數設定(啟用開關、消費點數比例、推薦獎勵、生日贈點),一站式在這裡操作。`
            : `「${merchant!.name}」會員的點數餘額總覽、手動調整、登記兌換與異動歷史。點數的核發規則(核發獎勵資格條件、啟用開關、消費點數比例、推薦獎勵、生日贈點)需要另外的「紅利點數管理」權限才能調整,請找商家管理員。`}
        </p>
      </div>

      {settings && settings.points_feature_enabled === false ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-foreground">
          目前紅利點數功能已關閉,系統不會再自動給任何新點數(客人消費、推薦朋友、生日都不發),
          建單表單跟會員詳情頁也不顯示點數相關內容給客戶/服務人員看。你仍然可以在這裡查看、手動
          調整、登記兌換既有的點數。
          {/* 2026-09-24 使用者裁決:這句「要重新開啟請到下方點數設定」只有看得到那張卡片的人適用。
              沒有 member_points 權限的客服看不到那張卡片,對他們說「去下方切換開關」等於叫他們去找
              一個畫面上不存在的東西,所以改成告訴他們該找誰。 */}
          {canManagePointsRules
            ? "要重新開啟,請到下方「點數設定」切換開關。"
            : "要重新開啟這個功能需要「紅利點數管理」權限,請找商家管理員處理。"}
        </div>
      ) : null}

      {/* 2026-09-24 使用者裁決(交易/規則權限分離):下面這兩張卡片就是「規則」那一半,整組需要
          member_points 權限。
          呈現方式選「整張卡片不渲染」而不是「渲染成 disabled」:這是專案既有慣例——
          LeaveTypesPage.tsx 的「扣款規則」按鈕(需要 commission_settings)、CalendarPage.tsx 的
          「開啟/關閉時段」選項(需要 business_hours)、AgentPermissionsPage 描述文字裡寫的
          「關掉的區塊會直接看不到對應的入口」,全部都是條件式不渲染,專案裡沒有任何一處是把
          沒權限的區塊留在畫面上灰掉。一致性之外也比較不會誤導:灰掉的欄位會讓客服以為「這個值
          就是目前設定」而據此回答客人,不渲染則不會產生這種誤解。 */}
      {canManagePointsRules ? (
        <>
          {/* 2026-09-24 使用者裁決:「核發獎勵資格條件」從 MemberSettingsPage.tsx 整塊搬過來,放在
          「點數設定」卡片上方——這個欄位決定的是「什麼樣的會員才拿得到點數」,本質上屬於點數
          設定的一部分,留在會員系統設定頁本來就不合理。 */}
          <Card>
            <CardHeader>
              <CardTitle>核發獎勵資格條件</CardTitle>
              <CardDescription>
                消費紅利/推薦獎勵/生日贈點核發前,是否要求會員符合特定資格。
                <strong className="text-warn">
                  提醒:「電話已驗證」只是客服人工標記,不是真的簡訊驗證,無法擋住用假電話註冊的人。
                </strong>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {settingsLoading ? (
                <p className="text-sm text-muted-foreground">載入中⋯</p>
              ) : (
                /* guardPhantomEmptyChange:這個 value 是掛載後才由上面的 useEffect 從 settings 灌進來的,
               不套防護會被 Radix 隱藏原生 select 補發的空字串事件洗掉(見 src/lib/radixSelectGuard.ts)。
               合法值是 REWARD_CONDITION_MODE_LABELS 這份固定列舉,所以判斷條件用白名單。 */
                <Select
                  value={rewardConditionMode}
                  disabled={savingRewardCondition}
                  onValueChange={guardPhantomEmptyChange<RewardConditionMode>(
                    (v) => void handleSaveRewardCondition(v),
                    (v) => v in REWARD_CONDITION_MODE_LABELS,
                  )}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REWARD_CONDITION_MODE_LABELS) as RewardConditionMode[]).map(
                      (mode) => (
                        <SelectItem key={mode} value={mode}>
                          {REWARD_CONDITION_MODE_LABELS[mode]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>

          {/* #639/#642(.project/specs/會員與紅利.md §10.5):「啟用紅利點數功能」開關,以及消費點數
          比例/推薦獎勵/生日贈點三個數字欄位,都從 MemberSettingsPage.tsx 搬過來這裡一次操作,
          不再需要連結導去會員系統設定頁調整。 */}
          <Card>
            <CardHeader>
              <CardTitle>點數設定</CardTitle>
              <CardDescription>
                啟用/停用紅利點數功能,以及消費點數比例、推薦獎勵、生日贈點,都在這裡一次設定。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {settingsLoading ? (
                <p className="text-sm text-muted-foreground">載入中⋯</p>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">啟用紅利點數功能</p>
                      <p className="text-xs text-muted-foreground">
                        關閉後系統就不再自動給點數了:客人消費不再累點、推薦朋友不發獎勵、生日也不
                        送點。你仍然可以在這一頁手動調整點數、登記兌換,把會員手上剩下的點數結清;
                        既有的點數餘額與異動歷史不會被清空,建單表單跟會員詳情頁則不再顯示點數相關
                        的數字與入口,重新開啟後會完整還原顯示。
                      </p>
                    </div>
                    <Switch
                      checked={settings ? settings.points_feature_enabled : true}
                      disabled={savingFeatureToggle}
                      onCheckedChange={handleToggleFeatureEnabled}
                    />
                  </div>

                  <div>
                    <Label htmlFor="points-earn-rate">消費點數比例(元/點)</Label>
                    <Input
                      id="points-earn-rate"
                      className="mt-2 w-40"
                      type="number"
                      min={0}
                      step="0.01"
                      value={pointsEarnRate}
                      onChange={(e) => setPointsEarnRate(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      每消費 N 元累積 1 點。目前是 0,代表還沒設定——請填入實際比例,系統不會自動幫你
                      套用任何數字。
                    </p>
                    {!Number.isNaN(numericRate) ? (
                      <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        範例試算:一筆 1000 元的訂單,這位會員可以拿到{" "}
                        <strong>{previewLoyaltyPoints(1000, numericRate)}</strong> 點(僅供參考,實際
                        點數以訂單完成時系統計算為準,計算基準是含稅總額)。
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <Label htmlFor="referral-bonus-points">推薦獎勵點數</Label>
                    <Input
                      id="referral-bonus-points"
                      className="mt-2 w-40"
                      type="number"
                      min={0}
                      step="1"
                      value={referralBonusPoints}
                      onChange={(e) => setReferralBonusPoints(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      被推薦人完成第一筆訂單時,推薦人可以拿到的點數。
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="birthday-bonus-points">生日贈點</Label>
                    <Input
                      id="birthday-bonus-points"
                      className="mt-2 w-40"
                      type="number"
                      min={0}
                      step="1"
                      value={birthdayBonusPoints}
                      onChange={(e) => setBirthdayBonusPoints(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      生日當月核發的點數(以月為單位容錯,不是精確當天準時發放——商家下次打開會員
                      管理列表頁時系統才會補發)。
                    </p>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    disabled={savingPoints}
                    onClick={handleSavePoints}
                  >
                    {savingPoints ? "儲存中⋯" : "儲存"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* 以下是「交易」那一半(餘額總覽/手動調整/登記兌換/異動歷史),維持只認 members 權限,
          也就是能進到這一頁的人一律看得到,不受 member_points 這把新鑰匙影響。 */}
      <Card>
        <CardHeader>
          <CardTitle>會員點數餘額總覽</CardTitle>
          <CardDescription>
            搜尋姓名/電話,點擊某位會員查看完整異動歷史與兌換/調整入口
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            className="max-w-xs"
            placeholder="搜尋姓名/電話"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : activeMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有符合條件的會員。</p>
          ) : (
            <ul className="space-y-1.5">
              {activeMembers.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => selectMember(m.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      selectedMemberId === m.id
                        ? "border-brand bg-brand-soft/40"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {m.name}
                      {m.phone ? `・${m.phone}` : ""}
                    </span>
                    <Badge variant="outline">{m.pointsBalance} 點</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selectedMemberId ? <MemberPointsDetail memberId={selectedMemberId} /> : null}
    </main>
  );
}

export default function MemberPointsPage() {
  return (
    <RequireMemberPointsAccess>
      <MemberPointsPageInner />
    </RequireMemberPointsAccess>
  );
}
