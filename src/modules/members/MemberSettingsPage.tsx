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
// - 2026-09-24 使用者裁決(#642 的延續收尾):「核發獎勵資格條件」(reward_condition_mode)整個區塊
//   ——下拉選單、說明文字、儲存邏輯——也搬到 MemberPointsPage.tsx 的「點數設定」區塊上方,理由是
//   這個欄位控制的是「什麼樣的會員才拿得到點數」,只跟點數有關,#617 把紅利點數獨立成一頁時漏掉了。
//   這頁因此只剩「會員政策」「會員等級」兩個區塊,頁面描述文字一併照實改寫。rewardConditionMode
//   在這頁降級成跟上述三個欄位一樣的「只讀回填用」state,確保儲存會員政策時不會把它覆蓋掉。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架(二之八)。
//   - 🔴「預覽效果」改成**全頁層**:skill 三「使用者已裁決的個案」表格裡點名
//     「會員系統設定 > 會員政策 > 預覽效果 = 全頁層」,不要有人照「內容很短」把它改回小卡窗。
//   - 🔴「新增 / 編輯會員等級」只有 2 個欄位 ⇒ **小卡窗**(三「📐 分類原則」第 3 點)。
//   - 兩個開關改 SwitchRow(二之七);欄位改 FormField + FieldInput / FieldTextarea。
//   - 顯示順序的 `type="number"` 改成文字輸入 + inputMode(手機滑動 / 桌機滾輪經過都會誤改數字,
//     比照 skill 二之七金額欄位的同一個理由)。驗證沒變(仍然是 `Number(sortOrder) || 0`)。
//   - 會員等級清單改 ListCard(二之五)+ StatusTag(二之四);右側只放「一顆主要動作 + 一個 ⋯」:
//     「編輯」永遠是主要動作,已下架的換成「重新上架」;「下架」收進 ⋯ 且**不標紅**(可逆)。
//   - 🔴 2026-09-30 修正(品管第二次打回,必修-2):原本寫「新增等級」「儲存」分別是各自卡片的
//     ① 主要按鈕 —— **那是錯的**。「會員政策」卡跟 `MemberTiersCard` 同時渲染在同一個 `<main>`
//     (沒有分頁、沒有條件分支),所以這是**同一個畫面上兩顆 primary**,違反二之三。
//     使用者裁決:「儲存」留 primary,「新增等級」改 ② 次要(neutral);「預覽效果」也是 ② 次要。
//     📌 通則:「一個畫面只能有一顆主要按鈕」的判斷單位是**整個畫面**,不是單張卡片。
//     (等級編輯小卡窗裡那顆 primary 是 overlay 內部,不算同一個畫面,維持 primary。)
//   - 沒有任何等級時改 EmptyState(二之八);**刻意不放下一步按鈕** —— 下一步就在空狀態正上方的
//     卡片標題列,再放一顆是同一個動作的兩個實例,改在文案裡指路(見 createTrigger 的註解)。
//
// **只動外觀,不動行為**:整列 upsert 的 saveSettings(把這頁沒有 UI 的欄位原樣回填)、
// 等級的新增 / 編輯 / 下架 / 重新上架 API、政策內容的自動長高、toast 文案全部照舊。
//
// 🔴 紅利系統重構 批次 6(2026-10-01,規格書 §3.14):上面那段「整列 upsert + 只讀回填 state」**已改掉**。
//   原因:紅利設定多了 13 個欄位,這頁如果繼續把「自己手上讀到的值」整列送回去,只要漏帶一欄就會把
//   紅利點數管理頁存的設定默默寫回預設值(或拿到過時的值蓋回去)。現在這頁只送「會員政策」兩個欄位
//   (saveMerchantMemberSettings 局部 patch),其他欄位資料庫原樣保留 —— 那些只讀回填的 state 全部拿掉。

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  CardDialogTrigger,
  EmptyState,
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  FullPageLayer,
  FullPageLayerContent,
  FullPageLayerTrigger,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  SwitchRow,
  type ListCardMenuItem,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addMemberTier,
  fetchMerchantMemberTiers,
  reactivateMemberTier,
  removeMemberTier,
  updateMemberTier,
  saveMerchantMemberSettings,
  useMerchantMemberSettings,
  type UpsertMemberTierInput,
} from "./api";
import { RequireMemberSettingsAccess } from "./RequireMemberSettingsAccess";
import { type MerchantMemberTier } from "./types";

const memberSettingsQueryKey = (merchantId: string) =>
  ["members-module", "merchant-member-settings", merchantId] as const;
const memberTiersQueryKey = (merchantId: string) =>
  ["members-module", "member-tiers", merchantId, false] as const;

/** 小卡窗的按鈕列在 <form> 外面(位置由殼決定),送出鈕用 form= 指回來。 */
const TIER_FORM_ID = "member-tier-form";

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
    <FieldTextarea
      ref={ref}
      id="policy-content"
      className="min-h-24 resize-none overflow-hidden"
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
    <FullPageLayer open={open} onOpenChange={setOpen}>
      <FullPageLayerTrigger asChild>
        {/* ② 次要:同一列的主要動作是「儲存」(skill 二之三,一個畫面只能有一顆主要)。 */}
        <Button type="button" variant="neutral" size="touch">
          預覽效果
        </Button>
      </FullPageLayerTrigger>
      {/* 🔴 全頁層:skill 三「使用者已裁決的個案」點名這個畫面歸全頁層,不要因為內容短就改回小卡窗。
          政策內容可以很長(點數規則 + 退換貨 + 個資聲明),一定要能捲。 */}
      <FullPageLayerContent
        title="會員政策(客戶端預覽)"
        subtitle="這是模擬客戶未來在客戶端看到的排版樣子,不是真的串接客戶端頁面(客戶端尚未開發)。"
      >
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="break-words text-sm font-semibold text-foreground">
            {merchantName}・會員政策
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {policyContent.trim() ? policyContent : "(尚未填寫政策內容)"}
          </p>
        </div>
      </FullPageLayerContent>
    </FullPageLayer>
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
    <CardDialog open={open} onOpenChange={setOpen}>
      <CardDialogTrigger asChild>{trigger}</CardDialogTrigger>
      {/* 2 個欄位 ⇒ 小卡窗(skill 三「📐 分類原則」第 3 點)。 */}
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>{isEdit ? "編輯會員等級" : "新增會員等級"}</CardDialogTitle>
          <CardDialogDescription>
            純分類標籤用途,不跟紅利點數倍率或其他權益掛勾。
          </CardDialogDescription>
        </CardDialogHeader>
        <form onSubmit={handleSubmit} id={TIER_FORM_ID} className="flex flex-col gap-3.5">
          <FormField label="等級名稱" htmlFor="tier-name" required>
            <FieldInput
              id="tier-name"
              placeholder="例如:一般會員、VIP 會員"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField
            label="顯示順序"
            htmlFor="tier-sort-order"
            help="數字小的排前面,例如一般會員 0、VIP 1。留空或填不是數字的東西會當成 0。"
            helpLabel="說明:顯示順序的數字怎麼填"
          >
            <FieldInput
              id="tier-sort-order"
              type="text"
              inputMode="numeric"
              className="tabular-nums sm:w-32"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
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
            form={TIER_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "儲存中⋯" : "儲存"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

function MemberTiersCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  // 🔴 2026-09-30(🟡 第 3 項):查詢失敗時 tiers 是 undefined ⇒ 畫成「還沒有任何會員等級」,
  // 商家以為自己設過的等級不見了,可能重新建一份重複的。isError 分支排在空狀態之前。
  const {
    data: tiers,
    isLoading,
    isError,
    refetch: refetchTiers,
  } = useQuery({
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

  /** 新增等級的按鈕(只放在卡片右上角一處)。
   *  📌 空狀態刻意**不再放一顆**:EmptyState.action 的例外條款 —— 下一步就在空狀態正上方的
   *     卡片標題列、一眼看得到,再放一顆會變成同一張卡片上兩顆 primary(違反 skill 二之三),
   *     而且是同一個動作的兩個實例。改在空狀態文案裡指路。
   *
   *  🔴 2026-09-30(品管第二次打回,必修-2):這顆從 ① 主要改成 ② 次要(neutral)。
   *     原因:`MemberTiersCard` 跟上面的「會員政策」卡**同時渲染在同一個 `<main>` 裡**
   *     (沒有分頁、也沒有條件分支),所以整個畫面會同時出現兩顆 primary
   *     ——會員政策的「儲存」+ 這顆「新增等級」,違反 skill 二之三「一個畫面只能有一顆」。
   *     **使用者裁決:「儲存」留 primary,「新增等級」改次要。**
   *     使用者原話:「如果一定必須選一個,我會選儲存」。
   *     ⚠️ 不要因為「它是這張卡片的主要動作」就改回 primary —— 判斷單位是**整個畫面**,
   *     不是單張卡片(同一批的 LineEventSettingsPage 5 張卡、PushEventSettingsPage 4 張卡
   *     都是照這條做的)。等級編輯小卡窗裡那顆 primary 是 overlay 內部、不算同一個畫面,
   *     維持 primary。 */
  const createTrigger = (
    <TierFormDialog
      merchantId={merchantId}
      tier={null}
      trigger={
        <Button type="button" variant="neutral" size="touch">
          新增等級
        </Button>
      }
      onSaved={refetch}
    />
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle>會員等級</CardTitle>
          <CardDescription>
            商家自訂等級名稱(例如一般/VIP/超級VIP),純分類標籤用途,不跟紅利點數倍率或其他權益掛勾。
          </CardDescription>
        </div>
        <div className="shrink-0 [&>*]:w-full sm:[&>*]:w-auto">{createTrigger}</div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingSkeleton variant="cards" rows={2} />
        ) : isError ? (
          <ErrorState
            title="讀不到會員等級"
            reason="可能是網路斷了;現在先不顯示等級清單,避免你把空白當成「等級都不見了」而重新建一份"
            onRetry={() => void refetchTiers()}
          />
        ) : !tiers || tiers.length === 0 ? (
          <EmptyState
            title="還沒有任何會員等級"
            description="按上方的「新增等級」建立第一個。建立之後,會員卡片上會顯示等級標籤,LINE 再行銷通知也可以依等級整批挑人。"
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {tiers.map((tier) => {
              const isRemoved = tier.status !== "active";
              // 🔴 二之三:「編輯」永遠是主要動作(已下架的換成「重新上架」),其餘收進 ⋯;
              //    「下架」是可逆的 ⇒ 一般項目、不標紅。
              const menuItems: ListCardMenuItem[] | undefined = isRemoved
                ? undefined
                : [{ label: "下架", onSelect: () => void handleRemove(tier.id) }];
              return (
                <li key={tier.id}>
                  <ListCard
                    state={isRemoved ? "inactive" : "default"}
                    title={tier.name}
                    tags={
                      isRemoved ? (
                        <StatusTag tone="neutral">已下架</StatusTag>
                      ) : (
                        <StatusTag tone="success">上架中</StatusTag>
                      )
                    }
                    primaryAction={
                      isRemoved ? (
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => void handleReactivate(tier.id)}
                        >
                          重新上架
                        </Button>
                      ) : (
                        <TierFormDialog
                          merchantId={merchantId}
                          tier={tier}
                          trigger={
                            <Button type="button" variant="neutral" size="card">
                              編輯
                            </Button>
                          }
                          onSaved={refetch}
                        />
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
  );
}

function MemberSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  // 🔴 2026-09-30(🟡 第 3 項):讀不到設定時,表單會顯示元件的預設值(開關關閉 + 內容空白),
  // 商家以為那就是自己存過的設定,一按儲存就把真實設定覆寫掉。出錯就不給表單
  // (跟 PaymentMethodsPage 稅金設定卡、BusinessHoursPage 同一個處理方式)。
  const {
    data: settings,
    isLoading,
    isError: isSettingsError,
    refetch: refetchSettings,
  } = useMerchantMemberSettings(merchantId);

  // 紅利系統重構批次 6:這頁只編輯「會員政策」兩個欄位,也**只送這兩個欄位**(局部 patch)。
  // 原本那幾個「讀出來原樣回填」的紅利欄位 state 已移除 —— 不送就不會蓋掉紅利點數管理頁的設定。
  const [policyEnabled, setPolicyEnabled] = useState(false);
  const [policyContent, setPolicyContent] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setPolicyEnabled(settings.policy_enabled);
    setPolicyContent(settings.policy_content ?? "");
  }, [settings]);

  async function saveSettings() {
    await saveMerchantMemberSettings(merchantId, {
      policyEnabled,
      policyContent: policyContent.trim() ? policyContent : null,
    });
    await queryClient.invalidateQueries({ queryKey: memberSettingsQueryKey(merchantId) });
  }

  async function handleSavePolicy() {
    setSavingPolicy(true);
    try {
      await saveSettings();
      toast.success("已更新會員政策");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="會員系統設定"
        description={`「${merchant!.name}」的會員政策與會員等級設定。`}
      />

      {/* #618 §10.6 第 3 點:「基本政策」改名「會員政策」,啟用開關 + 政策內容欄位(自動調整高度)
          + 儲存按鈕 + 按鈕下方「預覽效果」。 */}
      <Card>
        <CardHeader>
          <CardTitle>會員政策</CardTitle>
          <CardDescription>
            啟用後,這段內容之後會顯示給客戶端(模組 13 之後串接)看到,例如點數使用規則、隱私聲明等。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <LoadingSkeleton variant="lines" rows={3} />
          ) : isSettingsError ? (
            <ErrorState
              title="讀不到會員政策設定"
              reason="可能是網路斷了;現在先不顯示欄位,避免你把畫面上的預設值當成自己的設定存回去"
              onRetry={() => void refetchSettings()}
            />
          ) : (
            <>
              {/* skill 二之七:開關做成一整列。 */}
              <SwitchRow
                id="policy-enabled"
                title="啟用會員政策"
                description="關閉時,即使填了內容,客戶端也不會顯示。"
                checked={policyEnabled}
                onCheckedChange={setPolicyEnabled}
              />

              <FormField label="政策內容" htmlFor="policy-content">
                <AutoHeightTextarea
                  value={policyContent}
                  onChange={setPolicyContent}
                  placeholder="例如:會員點數不可折抵現金、退換貨規則、個資使用聲明⋯"
                />
              </FormField>

              <div className="flex flex-wrap items-center gap-2">
                {/* 🔴 這**整個畫面**唯一的 ① 主要動作(2026-09-30 使用者裁決:「如果一定必須
                    選一個,我會選儲存」)。下面的「會員等級」卡跟這張卡同時顯示在同一個 <main>,
                    所以那張卡的「新增等級」是 ② 次要,不要兩邊都做成 primary。 */}
                <Button
                  type="button"
                  variant="primary"
                  size="touch"
                  disabled={savingPolicy}
                  onClick={handleSavePolicy}
                >
                  {savingPolicy ? "儲存中⋯" : "儲存"}
                </Button>
                <PolicyPreviewDialog merchantName={merchant!.name} policyContent={policyContent} />
              </div>
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
