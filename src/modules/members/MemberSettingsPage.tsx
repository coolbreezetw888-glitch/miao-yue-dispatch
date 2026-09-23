// 對應模組 10(會員與紅利)規格書 §4.3,SPECS-INDEX #615/#618/#619 重新設計(2026-09-22):
// - #618:移除「建立會員時電話必填」開關(phone_required_to_create,已查證既有 bug 根因,見
//   20260922160200 migration 開頭註解)、「基本政策」改名「會員政策」+ 重新設計(啟用開關+
//   內容欄位+預覽效果)。
// - #619:移除「核發獎勵要求電話已驗證」開關,改用 reward_condition_mode 五選一下拉選單。
// - #615:新增「會員等級」管理區塊(清單 + 新增/編輯/下架/重新上架,比照 PaymentMethodsPage.tsx
//   的既有模式)。
// - #617(合併分支「底部選單改版與功能頁卡片」疊加):「紅利點數」卡片新增「啟用紅利點數功能」
//   開關(points_feature_enabled),連動 MemberDetailPage.tsx/建單表單/MemberPointsPage.tsx
//   是否顯示點數相關入口,關閉不清空既有點數資料。
// - #639(.project/specs/會員與紅利.md §10.5,推翻 #617 當初「開關維持放這頁」的判斷):
//   「啟用紅利點數功能」開關搬到 MemberPointsPage.tsx 自己的「點數設定」區塊,這頁的「紅利
//   點數」卡片只保留消費點數比例/推薦獎勵/生日贈點三個欄位。points_feature_enabled 欄位本身、
//   讀寫 API(upsertMerchantMemberSettings 整列 upsert)完全沒變,這裡的 pointsFeatureEnabled
//   state 只是讀出來原樣回填進 saveSettings 的 payload,避免這頁儲存其他欄位時把開關值覆蓋掉。
// - #642(.project/specs/會員與紅利.md §10.5,#639 的延續收尾):消費點數比例/推薦獎勵/生日贈點
//   這三個欄位跟儲存邏輯,這次也整個搬到 MemberPointsPage.tsx 的「點數設定」區塊,跟 #639 已經
//   搬過去的啟用開關放在一起。這頁的「紅利點數」卡片(原本只剩三個欄位+一個連回自己的連結)
//   因此已無殘留內容,整張卡片一併移除。pointsEarnRate/referralBonusPoints/birthdayBonusPoints
//   在這頁保留成「只讀回填用」的 state(比照既有 pointsFeatureEnabled 的做法):從 settings 讀出來
//   原樣帶回 saveSettings() 的 payload,確保這頁儲存「會員政策」「核發獎勵資格條件」時不會把
//   這三個欄位覆蓋掉,但這頁本身完全沒有 UI 讓人編輯這三個值。

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient, useQuery } from "@tanstack/react-query";
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

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addMemberTier,
  fetchMerchantMemberTiers,
  reactivateMemberTier,
  removeMemberTier,
  updateMemberTier,
  upsertMerchantMemberSettings,
  useMerchantMemberSettings,
  type UpsertMemberTierInput,
} from "./api";
import { RequireMemberSettingsAccess } from "./RequireMemberSettingsAccess";
import { REWARD_CONDITION_MODE_LABELS, type MerchantMemberTier, type RewardConditionMode } from "./types";

const memberSettingsQueryKey = (merchantId: string) =>
  ["members-module", "merchant-member-settings", merchantId] as const;
const memberTiersQueryKey = (merchantId: string) =>
  ["members-module", "member-tiers", merchantId, false] as const;

// ---------------------------------------------------------------------------
// 「會員政策」自動依內容調整高度的文字區域(#618 §10.6 第 3 點)。不需要複雜的富文本編輯器,
// 純文字即可——用一個小 effect,值變動時把 height 先歸零再設成 scrollHeight,達到隨內容
// 自動長高的效果。
// ---------------------------------------------------------------------------
function AutoHeightTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <Textarea
      ref={ref}
      className="mt-2 min-h-24 resize-none overflow-hidden"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// 「預覽效果」彈窗:模擬客戶端(模組 13 之後)看到這段政策內容的樣子。這次還沒有真正的客戶端
// 介面,用一個簡單的彈窗模擬排版即可(§10.6 第 3 點,不用串接還不存在的頁面)。
// ---------------------------------------------------------------------------
function PolicyPreviewDialog({
  merchantName,
  policyContent,
}: {
  merchantName: string;
  policyContent: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          預覽效果
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>會員政策(客戶端預覽)</DialogTitle>
          <DialogDescription>
            這是模擬客戶未來在客戶端看到的排版樣子,不是真的串接客戶端頁面(客戶端尚未開發)。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <p className="text-sm font-semibold text-foreground">{merchantName}・會員政策</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {policyContent.trim() ? policyContent : "(尚未填寫政策內容)"}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// #615:會員等級新增/編輯表單。
// ---------------------------------------------------------------------------
function TierFormDialog({
  merchantId,
  tier,
  trigger,
  onSaved,
}: {
  merchantId: string;
  tier: MerchantMemberTier | null;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const isEdit = Boolean(tier);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(tier?.name ?? "");
  const [sortOrder, setSortOrder] = useState(String(tier?.sort_order ?? 0));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(tier?.name ?? "");
      setSortOrder(String(tier?.sort_order ?? 0));
    }
  }, [open, tier]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫等級名稱");
      return;
    }
    const input: UpsertMemberTierInput = {
      name: name.trim(),
      sortOrder: Number(sortOrder) || 0,
    };
    setSaving(true);
    try {
      if (isEdit && tier) {
        await updateMemberTier(tier.id, input);
        toast.success("已更新會員等級");
      } else {
        await addMemberTier(merchantId, input);
        toast.success("已新增會員等級");
      }
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯會員等級" : "新增會員等級"}</DialogTitle>
          <DialogDescription>純分類標籤用途,不跟紅利點數倍率或其他權益掛勾。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="tier-name">等級名稱 *</Label>
            <Input
              id="tier-name"
              className="mt-2"
              placeholder="例如:一般會員、VIP 會員"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tier-sort-order">顯示順序</Label>
            <Input
              id="tier-sort-order"
              type="number"
              className="mt-2 w-32"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">數字小的排前面,例如一般會員 0、VIP 1。</p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberTiersCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: tiers, isLoading } = useQuery({
    queryKey: memberTiersQueryKey(merchantId),
    queryFn: () => fetchMerchantMemberTiers(merchantId, false),
  });

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: ["members-module", "member-tiers"] });
  }

  async function handleRemove(id: string) {
    try {
      await removeMemberTier(id);
      await refetch();
      toast.success("已下架這個等級");
    } catch (err) {
      toast.error("下架失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivate(id: string) {
    try {
      await reactivateMemberTier(id);
      await refetch();
      toast.success("已重新上架這個等級");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>會員等級</CardTitle>
          <CardDescription>
            商家自訂等級名稱(例如一般/VIP/超級VIP),純分類標籤用途,不跟紅利點數倍率或其他權益掛勾。
          </CardDescription>
        </div>
        <TierFormDialog
          merchantId={merchantId}
          tier={null}
          trigger={<Button variant="cta">新增等級</Button>}
          onSaved={refetch}
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : !tiers || tiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前還沒有任何會員等級,點右上角新增一項。</p>
        ) : (
          <ul className="space-y-2">
            {tiers.map((tier) => (
              <li
                key={tier.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{tier.name}</p>
                  <Badge variant={tier.status === "active" ? "default" : "secondary"} className="mt-1">
                    {tier.status === "active" ? "上架中" : "已下架"}
                  </Badge>
                </div>
                <div className="flex shrink-0 gap-2">
                  {tier.status === "active" ? (
                    <>
                      <TierFormDialog
                        merchantId={merchantId}
                        tier={tier}
                        trigger={
                          <Button variant="outline" size="sm">
                            編輯
                          </Button>
                        }
                        onSaved={refetch}
                      />
                      <Button variant="outline" size="sm" onClick={() => handleRemove(tier.id)}>
                        下架
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => handleReactivate(tier.id)}>
                      重新上架
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MemberSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useMerchantMemberSettings(merchantId);

  // #642:這三個欄位這頁已經沒有任何 UI 可以編輯,只保留「讀出來原樣回填」的 state,
  // 避免這頁儲存「會員政策」「核發獎勵資格條件」時,把 MemberPointsPage.tsx 那邊維護的
  // 消費點數比例/推薦獎勵/生日贈點覆蓋掉(upsertMerchantMemberSettings 是整列 upsert)。
  const [pointsFeatureEnabled, setPointsFeatureEnabled] = useState(true);
  const [pointsEarnRate, setPointsEarnRate] = useState(0);
  const [referralBonusPoints, setReferralBonusPoints] = useState(0);
  const [birthdayBonusPoints, setBirthdayBonusPoints] = useState(0);
  const [policyEnabled, setPolicyEnabled] = useState(false);
  const [policyContent, setPolicyContent] = useState("");
  const [rewardConditionMode, setRewardConditionMode] = useState<RewardConditionMode>("none");
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setPointsFeatureEnabled(settings.points_feature_enabled);
    setPointsEarnRate(settings.points_earn_rate);
    setReferralBonusPoints(settings.referral_bonus_points);
    setBirthdayBonusPoints(settings.birthday_bonus_points);
    setPolicyEnabled(settings.policy_enabled);
    setPolicyContent(settings.policy_content ?? "");
    setRewardConditionMode(settings.reward_condition_mode as RewardConditionMode);
  }, [settings]);

  async function saveSettings(overrides: Partial<Parameters<typeof upsertMerchantMemberSettings>[1]>) {
    await upsertMerchantMemberSettings(merchantId, {
      pointsEarnRate,
      referralBonusPoints,
      birthdayBonusPoints,
      pointsFeatureEnabled,
      rewardConditionMode,
      policyEnabled,
      policyContent: policyContent.trim() ? policyContent : null,
      ...overrides,
    });
    await queryClient.invalidateQueries({ queryKey: memberSettingsQueryKey(merchantId) });
  }

  async function handleSavePolicy() {
    setSavingPolicy(true);
    try {
      await saveSettings({});
      toast.success("已更新會員政策");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function handleSaveRewardCondition(next: RewardConditionMode) {
    setRewardConditionMode(next);
    try {
      await saveSettings({ rewardConditionMode: next });
      toast.success("已更新核發獎勵資格條件");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">會員系統設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的會員政策、核發獎勵資格條件、會員等級。紅利點數(啟用開關、消費
          點數比例、推薦獎勵、生日贈點)請到「功能」選單的「紅利點數管理」獨立頁面調整。
        </p>
      </div>

      {/* #618 §10.6 第 3 點:「基本政策」改名「會員政策」,啟用開關 + 政策內容欄位(自動調整高度)
          + 儲存按鈕 + 按鈕下方「預覽效果」。 */}
      <Card>
        <CardHeader>
          <CardTitle>會員政策</CardTitle>
          <CardDescription>
            啟用後,這段內容之後會顯示給客戶端(模組 13 之後串接)看到,例如點數使用規則、隱私聲明等。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">啟用會員政策</p>
                  <p className="text-xs text-muted-foreground">
                    關閉時,即使填了內容,客戶端也不會顯示。
                  </p>
                </div>
                <Switch checked={policyEnabled} onCheckedChange={setPolicyEnabled} />
              </div>

              <div>
                <Label htmlFor="policy-content">政策內容</Label>
                <AutoHeightTextarea
                  value={policyContent}
                  onChange={setPolicyContent}
                  placeholder="例如:會員點數不可折抵現金、退換貨規則、個資使用聲明⋯"
                />
              </div>

              <div className="flex items-center gap-2">
                <Button type="button" size="sm" disabled={savingPolicy} onClick={handleSavePolicy}>
                  {savingPolicy ? "儲存中⋯" : "儲存"}
                </Button>
                <PolicyPreviewDialog merchantName={merchant!.name} policyContent={policyContent} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* #619 §10.7:核發獎勵資格條件,取代原本單一的「核發獎勵要求電話已驗證」開關。 */}
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
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <Select
              value={rewardConditionMode}
              onValueChange={(v) => handleSaveRewardCondition(v as RewardConditionMode)}
            >
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REWARD_CONDITION_MODE_LABELS) as RewardConditionMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {REWARD_CONDITION_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <MemberTiersCard merchantId={merchantId} />
    </main>
  );
}

export default function MemberSettingsPage() {
  return (
    <RequireMemberSettingsAccess>
      <MemberSettingsPageInner />
    </RequireMemberSettingsAccess>
  );
}
