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
import { previewLoyaltyPoints } from "./previewCalculators";
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

  const [pointsFeatureEnabled, setPointsFeatureEnabled] = useState(true);
  const [policyEnabled, setPolicyEnabled] = useState(false);
  const [policyContent, setPolicyContent] = useState("");
  const [rewardConditionMode, setRewardConditionMode] = useState<RewardConditionMode>("none");
  const [pointsEarnRate, setPointsEarnRate] = useState("0");
  const [referralBonusPoints, setReferralBonusPoints] = useState("0");
  const [birthdayBonusPoints, setBirthdayBonusPoints] = useState("0");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingPoints, setSavingPoints] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setPointsFeatureEnabled(settings.points_feature_enabled);
    setPolicyEnabled(settings.policy_enabled);
    setPolicyContent(settings.policy_content ?? "");
    setRewardConditionMode(settings.reward_condition_mode as RewardConditionMode);
    setPointsEarnRate(String(settings.points_earn_rate));
    setReferralBonusPoints(String(settings.referral_bonus_points));
    setBirthdayBonusPoints(String(settings.birthday_bonus_points));
  }, [settings]);

  const numericRate = Number(pointsEarnRate);
  const numericReferral = Number(referralBonusPoints);
  const numericBirthday = Number(birthdayBonusPoints);

  async function saveSettings(overrides: Partial<Parameters<typeof upsertMerchantMemberSettings>[1]>) {
    await upsertMerchantMemberSettings(merchantId, {
      pointsEarnRate: numericRate,
      referralBonusPoints: numericReferral,
      birthdayBonusPoints: numericBirthday,
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
      await saveSettings({});
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">會員系統設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的會員政策、核發獎勵資格條件、消費點數比例、推薦與生日獎勵、會員等級。
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

      <Card>
        <CardHeader>
          <CardTitle>紅利點數</CardTitle>
          <CardDescription>
            啟用開關、消費點數比例、推薦獎勵、生日贈點——完整的餘額檢視/兌換/手動調整操作,見
            「功能」選單的「紅利點數管理」獨立頁面(
            <Link to="/app/member-points" className="text-brand hover:underline">
              前往紅利點數管理
            </Link>
            )。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <>
              {/* #617(.project/specs/會員與紅利.md §10.5):商家決定要不要啟用紅利點數功能。
                  關閉後建單表單/會員詳情頁不再顯示任何點數相關的操作入口與數字,既有的點數餘額
                  資料不受影響,只是隱藏,重新開啟後完整還原顯示。 */}
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">啟用紅利點數功能</p>
                  <p className="text-xs text-muted-foreground">
                    關閉後,會員詳情頁跟紅利點數管理頁不再顯示任何點數相關的操作入口與數字,既有的
                    點數餘額/異動歷史資料不會被清空,重新開啟後會完整還原顯示。
                  </p>
                </div>
                <Switch checked={pointsFeatureEnabled} onCheckedChange={setPointsFeatureEnabled} />
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

              <Button type="button" size="sm" disabled={savingPoints} onClick={handleSavePoints}>
                {savingPoints ? "儲存中⋯" : "儲存"}
              </Button>
            </>
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
