// 對應模組 10(會員與紅利)規格書 §4.3:會員系統設定頁(新路由 /app/member-settings)。
// 表單:建立會員是否強制電話必填、核發獎勵是否要求電話已驗證、消費點數比例、推薦獎勵點數、
// 生日贈點。即時預覽計算機(比照模組 8 §4.1 的既有精神):填入消費點數比例時,旁邊即時顯示
// 白話試算,純前端函式,不是任何寫入依據。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import { upsertMerchantMemberSettings, useMerchantMemberSettings } from "./api";
import { previewLoyaltyPoints } from "./previewCalculators";
import { RequireMemberSettingsAccess } from "./RequireMemberSettingsAccess";

const memberSettingsQueryKey = (merchantId: string) =>
  ["members-module", "merchant-member-settings", merchantId] as const;

function MemberSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useMerchantMemberSettings(merchantId);

  const [phoneRequired, setPhoneRequired] = useState(true);
  const [requireVerifiedPhone, setRequireVerifiedPhone] = useState(false);
  const [pointsFeatureEnabled, setPointsFeatureEnabled] = useState(true);
  const [pointsEarnRate, setPointsEarnRate] = useState("0");
  const [referralBonusPoints, setReferralBonusPoints] = useState("0");
  const [birthdayBonusPoints, setBirthdayBonusPoints] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setPhoneRequired(settings.phone_required_to_create);
    setRequireVerifiedPhone(settings.require_verified_phone_for_rewards);
    setPointsFeatureEnabled(settings.points_feature_enabled);
    setPointsEarnRate(String(settings.points_earn_rate));
    setReferralBonusPoints(String(settings.referral_bonus_points));
    setBirthdayBonusPoints(String(settings.birthday_bonus_points));
  }, [settings]);

  const numericRate = Number(pointsEarnRate);
  const numericReferral = Number(referralBonusPoints);
  const numericBirthday = Number(birthdayBonusPoints);

  async function handleSave() {
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

    setSaving(true);
    try {
      await upsertMerchantMemberSettings(merchantId, {
        phoneRequiredToCreate: phoneRequired,
        requireVerifiedPhoneForRewards: requireVerifiedPhone,
        pointsEarnRate: numericRate,
        referralBonusPoints: numericReferral,
        birthdayBonusPoints: numericBirthday,
        pointsFeatureEnabled,
      });
      await queryClient.invalidateQueries({ queryKey: memberSettingsQueryKey(merchantId) });
      toast.success("已更新會員系統設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
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
          「{merchant!.name}」的電話驗證政策、消費點數比例、推薦與生日獎勵。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本政策</CardTitle>
          <CardDescription>建立會員時的電話必填規則,以及紅利核發是否要求電話已驗證</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">建立會員時電話必填</p>
                  <p className="text-xs text-muted-foreground">
                    關閉後客服可以建立沒有電話的會員(例如只留 Email 的顧客)。
                  </p>
                </div>
                <Switch checked={phoneRequired} onCheckedChange={setPhoneRequired} />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">核發獎勵要求電話已驗證</p>
                  <p className="text-xs text-muted-foreground">
                    啟用後,只有已標記「電話已驗證」的會員才能拿到消費點數/推薦獎勵/生日贈點。
                    <strong className="text-warn">
                      提醒:這次的「已驗證」只是客服人工標記,不是真的簡訊驗證,無法擋住用假電話
                      註冊的人。
                    </strong>
                  </p>
                </div>
                <Switch checked={requireVerifiedPhone} onCheckedChange={setRequireVerifiedPhone} />
              </div>
            </>
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

              <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
                {saving ? "儲存中⋯" : "儲存"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
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
