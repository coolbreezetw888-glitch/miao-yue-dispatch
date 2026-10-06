// 這頁目前(SPECS-INDEX #830 之後)只剩紅利點數的「規則設定」。紅利系統重構批次 6(#836~#841)之後的
// 結構見本段最後的「紅利系統重構 批次 6」說明(核發獎勵資格條件 → 啟用開關獨立區塊 → 四個分頁)。個別會員的點數餘額、異動歷史、手動調整、登記兌換這些「交易」
// 操作都不在這頁,在「會員管理 > 點擊某位會員」的詳情頁(MemberDetailPage.tsx + MemberPointsPanel.tsx)。
// 下面依時間順序保留這頁演變的來龍去脈,方便理解為什麼權限守衛跟卡片是現在這個樣子。
//
// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」):紅利點數功能從會員詳情頁移出,
// 在「功能」選單新開一張獨立卡片(新路由 /app/member-points),當時集中管理跟點數相關的操作:
//   1. 各會員點數餘額總覽清單(搜尋姓名/電話,顯示目前餘額)——#830 已移除。
//   2. 點擊個別會員可以看到完整點數異動歷史——#830 已搬回會員詳情頁。
//   3. 「手動調整」入口(維持「僅商家管理員」的既有權限邊界)——#830 已搬回會員詳情頁。
//   4. 「登記兌換」入口——#830 已搬回會員詳情頁。
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
// SPECS-INDEX #830(2026-09-29 使用者巡檢回報第 6 項,裁決 Q2,見 .project/notes/2026-09-29-使用者
// 調整清單.md):使用者認為「會員點數餘額總覽」跟會員名單每列的點數 Badge 重複,決定移除。但那張
// 卡片是這頁唯一的會員選擇器,點了才會展開 MemberPointsDetail(異動歷史/手動調整/登記兌換),
// 直接刪會讓那三個功能沒有入口,所以裁決是整組搬到「會員管理 > 點擊某位會員」的詳情頁
// (元件抽成 MemberPointsPanel.tsx,由 MemberDetailPage.tsx 掛載)。搬走之後:
//   ・這頁只剩「規則」那一半:核發獎勵資格條件 + 點數設定,權限判斷(canManagePointsRules)沒動。
//   ・原本的 ?member=<id> 深連結、RedeemPointsDialog/AdjustPointsDialog/MemberPointsDetail 都從
//     這個檔案移除(#617 當初是從 MemberDetailPage.tsx 搬過來的,現在等於搬回去)。
//   ・整頁守衛 RequireMemberPointsAccess 仍然只認 members 這把鑰匙,**刻意不改**——改成認
//     member_points 等於收緊「誰能打開這頁」,違反 #830「權限不能因搬家而放寬或收緊」的要求。
//     代價是只有 members、沒有 member_points 的客服打開這頁會看到一個沒有卡片的畫面,所以補了
//     一段說明文字告訴他規則設定需要什麼權限、交易功能現在在哪裡。要不要連守衛/功能卡片一起改,
//     屬於權限調整,留給主腦/使用者另外裁決。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架(二之八)。
//   - 🔴「目前紅利點數功能已關閉…」改成 🟡 常駐 `!`(AlertNote)。skill 二的表格裡,
//     「功能已關閉,資料不會被清空」就是「現在的狀態跟使用者以為的不一樣」這一類的原始例子。
//   - 🔴「電話已驗證只是人工標記,不是真的簡訊驗證」也改成常駐 `!`:商家會以為這個選項能擋掉
//     用假電話註冊的人,那正是「現在的狀態跟使用者以為的不一樣」。原本只是 CardDescription 裡
//     一段黃色粗體字,混在說明裡很容易被跳過。
//   - 「啟用紅利點數功能」改 SwitchRow(二之七),長說明拆成一行摘要 + 一條常駐 `!`
//     (「關閉後系統不再自動給點數」是 skill 二點名的第二類:按下去會發生什麼不可逆的事)。
//   - 三個數字欄位改 FormField + FieldInput;🔴 拿掉 `type="number"`(手機滑動與桌機滾輪經過
//     都會誤改數字,比照 skill 二之七金額欄位的同一個理由),改成文字輸入 + inputMode + tabular-nums。
//   - 🔴 2026-09-30 修正:上面這條當初寫的是「驗證完全沒變(仍然是原本那套 Number.isNaN /
//     Number.isInteger 判斷)」—— **那句話本身就是這個 bug 的自白**。拿掉 `type="number"` 就等於
//     拿掉原生的 min / step 約束,驗證「沒變」的意思其實是「沒有補上」。實測後果:消費點數比例
//     填 `Infinity` 可以存進資料庫(`Number.isNaN(Infinity)` 是 false、`Infinity < 0` 也是 false),
//     三欄的 `1e3` 都靜默變 1000、`0x10` 變 16、清空欄位靜默存成 0。
//     現在三欄一律走 parseAmountInput(點數傳 integerOnly),錯誤即時顯示在欄位下面 +
//     儲存鈕 disabled + 一條常駐 `!` 說明原因。
//     📌 教訓:**換掉輸入元件的 type 就是改行為**,不是純外觀改動。
//   - 欄位的說明文字(每消費 N 元累積 1 點、被推薦人完成第一筆才發、生日以月為單位容錯)收進 `?`,
//     範例試算維持常駐的預覽框(那是即時回饋,不是可以收起來的補充)。
//   - 核發獎勵資格條件的下拉改 FieldSelect,guardPhantomEmptyChange 白名單版**原樣保留**。
//   - 「儲存」是這一頁唯一的 ① 主要按鈕;沒有規則權限時的說明改 EmptyState(二之八)。
//
// 🔴 2026-09-30(使用者實機巡檢批,QA D-2「假成功」):這頁原本只取 useMerchantMemberSettings 的
// data + isLoading,**沒有 isError**。查詢失敗時三個欄位停在初始值「0」、開關顯示成「已啟用」,
// 按儲存實際上什麼都沒寫(saveSettingsRow 的 `if (!settings) return`),但外層照樣跳
// toast.success("已更新紅利點數設定") ⇒ **畫面說已更新,其實一個字都沒存**。
// 兩處一起修:① 讀不到設定時不顯示表單,改 ErrorState;② saveSettingsRow 沒有 settings 時丟錯
// 而不是靜默 return(不寫入這件事本身是對的,要保留;錯的是「沒寫卻報成功」)。
// 📌 教訓:**只取 data + isLoading 的查詢,等於把「失敗」偽裝成「成功但是空的」**。
//    只要那份 data 之後會被拿去當表單初始值或當成「目前設定」顯示,就一定要接 isError。
//
// **只動外觀,不動行為**:兩段權限的判斷(canManagePointsRules)、整列 upsert 的 saveSettingsRow、
// 選了就直接存的核發資格條件、三個數字欄位的驗證與儲存、所有文案的意思全部照舊。
//
// 🔴 紅利系統重構 批次 6(2026-10-01,規格書 .project/specs/紅利系統重構.md §4.1,#836):
//   - 原本的「點數設定」卡片**整張移除**,內容分散到四個橫向分頁(MemberPointsSettingsTabs.tsx):
//     紅利計算 / 點數使用 / 推薦系統 / 生日獎勵。舊的「消費點數比例(元/點)」欄位已 drop,
//     它的語意由「紅利計算」(怎麼賺點)與「點數使用」(怎麼折抵)兩個分頁取代。
//   - 「啟用紅利點數功能」從點數設定卡片搬出,**自成獨立區塊**,放在「核發獎勵資格條件」正下方;開關文案沿用。
//   - 四個分頁只在 points_feature_enabled = true 時渲染;關閉時只剩黃色常駐提醒(skill 二 `!`)。
//   - 權限判斷 canManagePointsRules 一個字都沒動;整頁守衛 RequireMemberPointsAccess 也沒動(#830 裁決)。
//   - 寫入改走 saveMerchantMemberSettings 局部 patch(只送這次要改的欄位),不再整列 upsert(§3.14)。
//   - ⚠️ 這頁本來就在 members / member_points 鑰匙底下,所以用 useMerchantMemberSettings 判斷開關是安全的;
//     **建單頁、帳務報表頁不能照抄**(規格書 §〇.3 判斷 13:沒有鑰匙時 hook 會靜默回 true)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  EmptyState,
  ErrorState,
  FieldSelect,
  FormField,
  LoadingSkeleton,
  PageHeader,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  saveMerchantMemberSettings,
  useMerchantMemberSettings,
  type MerchantMemberSettingsPatch,
} from "./api";
import { shouldRenderPointsTabs } from "./memberPointsSettingsLogic";
import { MemberPointsSettingsTabs } from "./MemberPointsSettingsTabs";
import { RequireMemberPointsAccess } from "./RequireMemberPointsAccess";
import { REWARD_CONDITION_MODE_LABELS, type RewardConditionMode } from "./types";

function MemberPointsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const [savingFeatureToggle, setSavingFeatureToggle] = useState(false);

  // 2026-09-24 使用者裁決:「核發獎勵資格條件」從 MemberSettingsPage.tsx 搬過來。這個 state 是
  // 「顯示用 + 立即回饋用」的本地值——下拉選單改值後要馬上反映在畫面上,不能等 invalidateQueries
  // 重新抓回 settings 才更新,否則使用者會看到選單彈回舊值。
  const [rewardConditionMode, setRewardConditionMode] = useState<RewardConditionMode>("none");
  const [savingRewardCondition, setSavingRewardCondition] = useState(false);

  // =======================================================================
  // 2026-09-24 使用者裁決(紅利點數管理頁分成「交易」與「規則」兩段權限)。使用者原文:
  //   餘額總覽、手動調整、登記兌換、異動歷史 = 會員管理(members)
  //   核發獎勵資格條件、點數設定(啟用開關/比例/推薦/生日) = 紅利點數管理(member_points)
  // (#830 之後「交易」那四項已經不在這頁、搬到會員詳情頁,這頁只剩「規則」;鑰匙歸屬沒變。)
  // 判斷寫法沿用專案既有慣例:merchantRole === 'admin' 一律放行,agent 才需要 useAgentPermission 為 true。
  // ⚠️ admin 直接短路,完全不看 member_points 開關(使用者交代「商家管理員一定要全部看得到」)。
  // ✅ 資料庫端另有 private.can_manage_member_points() 與規則欄位的寫入鎖(migration
  //    20260924040400 / 紅利重構批次 1、6 的 trigger),前後端兩層防線都在。前端這一半 fail-closed:
  //    查不到權限列時 useAgentPermission 是 false。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageMemberPointsRules } = useAgentPermission("member_points");
  const canManagePointsRules =
    merchantRole === "admin" || (merchantRole === "agent" && canManageMemberPointsRules === true);

  // 🔴 2026-09-30(QA D-2「假成功」):一定要接 isError。讀不到設定時整組表單都不顯示,改 ErrorState;
  // 否則欄位會停在預設值、開關顯示「已啟用」,商家會把預設值當成自己的設定。
  const {
    data: settings,
    isLoading: settingsLoading,
    isError: isSettingsError,
    refetch: refetchSettings,
  } = useMerchantMemberSettings(merchantId);

  useEffect(() => {
    if (!settings) return;
    setRewardConditionMode(settings.reward_condition_mode as RewardConditionMode);
  }, [settings]);

  // 紅利系統重構批次 6:改成局部 patch(只送這次要改的欄位)。沒有 settings(讀不到)時仍然**丟錯**
  // 而不是靜默 return —— 那會讓呼叫端跳出「已更新」的假成功 toast(2026-09-30 QA D-2)。
  async function saveSettingsPatch(patch: MerchantMemberSettingsPatch) {
    if (!settings) {
      throw new Error(
        "目前讀不到這間商家的會員設定，為了不覆寫原本的設定，這次沒有儲存。請重新載入再試一次。",
      );
    }
    await saveMerchantMemberSettings(merchantId, patch);
    await queryClient.invalidateQueries({
      queryKey: ["members-module", "merchant-member-settings", merchantId],
    });
  }

  async function handleToggleFeatureEnabled(next: boolean) {
    setSavingFeatureToggle(true);
    try {
      await saveSettingsPatch({ pointsFeatureEnabled: next });
      toast.success(next ? "已啟用紅利點數功能" : "已停用紅利點數功能");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingFeatureToggle(false);
    }
  }

  // 「選了就直接存」的既有行為;存檔失敗時把選單退回資料庫目前的值。
  async function handleSaveRewardCondition(next: RewardConditionMode) {
    setRewardConditionMode(next);
    setSavingRewardCondition(true);
    try {
      await saveSettingsPatch({ rewardConditionMode: next });
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

  const showTabs = shouldRenderPointsTabs({ canManagePointsRules, settings });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="紅利點數"
        // #974(2026-10-06):說明收進 `?`,一律同一句。沒有「紅利點數」權限的客服看不到規則時,
        // 下方 EmptyState(「你目前的權限看不到這頁的規則設定」)會常駐說明原因並指路,不靠這段說明。
        description={`「${merchant!.name}」的紅利點數是否開啟以及規則設定。`}
      />

      {settings && settings.points_feature_enabled === false ? (
        // 🟡 常駐 `!`:skill 二的表格裡「功能已關閉,資料不會被清空」就是這一類的原始例子。
        <AlertNote>
          <strong>目前紅利點數功能已關閉</strong>
          ，系統不會再自動給任何新點數(客人消費、推薦朋友、生日都不發)，
          建單表單與會員詳情頁也不再顯示任何點數相關的內容與入口。既有的點數餘額與異動歷史不會被清空，
          重新開啟後會完整還原顯示。
          {canManagePointsRules
            ? "要重新開啟，請到下方「啟用紅利點數功能」切換開關。"
            : "要重新開啟這個功能需要「紅利點數」權限，請找商家管理員處理。"}
        </AlertNote>
      ) : null}

      {/* 規則那一半整組需要 member_points 權限;沒有權限時整張卡片不渲染(專案既有慣例:條件式不渲染,
          不是灰掉 —— 灰掉的欄位會讓客服以為「這個值就是目前設定」)。 */}
      {canManagePointsRules && isSettingsError ? (
        <Card>
          <CardContent className="pt-6">
            <ErrorState
              title="讀不到紅利點數的設定"
              reason="可能是網路斷了;現在先不顯示欄位，避免你把畫面上的預設值(0 點、功能已啟用)當成自己的設定存回去"
              onRetry={() => void refetchSettings()}
            />
          </CardContent>
        </Card>
      ) : canManagePointsRules ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>核發獎勵資格條件</CardTitle>
              <CardDescription>
                消費紅利/推薦獎勵/生日贈點核發前，是否要求會員符合特定資格。選了就直接存，沒有另外的儲存按鈕。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {settingsLoading ? (
                <LoadingSkeleton variant="lines" rows={1} />
              ) : (
                <>
                  <FormField label="資格條件" htmlFor="reward-condition-mode">
                    {/* guardPhantomEmptyChange:value 是掛載後才由 useEffect 從 settings 灌進來的,
                        不套防護會被 Radix 隱藏原生 select 補發的空字串事件洗掉(src/lib/radixSelectGuard.ts)。 */}
                    <FieldSelect<RewardConditionMode>
                      id="reward-condition-mode"
                      value={rewardConditionMode}
                      disabled={savingRewardCondition}
                      onValueChange={guardPhantomEmptyChange<RewardConditionMode>(
                        (v) => void handleSaveRewardCondition(v),
                        (v) => v in REWARD_CONDITION_MODE_LABELS,
                      )}
                      options={(
                        Object.keys(REWARD_CONDITION_MODE_LABELS) as RewardConditionMode[]
                      ).map((mode) => ({
                        value: mode,
                        label: REWARD_CONDITION_MODE_LABELS[mode],
                      }))}
                    />
                  </FormField>
                  <AlertNote>
                    「電話已驗證」只是<strong>客服人工標記</strong>
                    ，不是真的簡訊驗證，無法擋住用假電話註冊的人。
                  </AlertNote>
                </>
              )}
            </CardContent>
          </Card>

          {/* §4.1 第 3 點(#836):「啟用紅利點數功能」自成獨立區塊,放在核發獎勵資格條件正下方。
              開關文案沿用(含「要結清剩餘點數請先重新開啟」那段)。 */}
          <Card>
            <CardContent className="pt-6">
              {settingsLoading ? (
                <LoadingSkeleton variant="lines" rows={1} />
              ) : (
                <SwitchRow
                  id="points-feature-enabled"
                  title="啟用紅利點數功能"
                  description="控制整間店要不要跑紅利點數。開啟後下方會出現四個設定分頁。"
                  checked={settings ? settings.points_feature_enabled : false}
                  disabled={savingFeatureToggle || !settings}
                  onCheckedChange={(next) => void handleToggleFeatureEnabled(next)}
                >
                  <AlertNote>
                    關閉後<strong>系統就不再自動給點數了</strong>
                    ：客人消費不再累點、推薦朋友不發獎勵、生日也不送點。建單表單與會員詳情頁也不再
                    顯示任何點數相關的數字與入口(要結清某位會員剩下的點數，請先重新開啟功能、
                    結清後再關閉);既有的點數餘額與異動歷史不會被清空，重新開啟後會完整還原顯示。
                  </AlertNote>
                </SwitchRow>
              )}
            </CardContent>
          </Card>

          {showTabs && settings ? (
            <MemberPointsSettingsTabs
              merchantId={merchantId}
              merchantName={merchant!.name}
              settings={settings}
            />
          ) : null}
        </>
      ) : (
        /* SPECS-INDEX #830:只有 members、沒有 member_points 權限的客服打開這頁會什麼卡片都看不到
           (守衛刻意不改)。這裡補一段說明,避免看起來像壞掉。 */
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="你目前的權限看不到這頁的規則設定"
              description="個別會員的點數餘額、登記兌換與異動歷史，在「會員管理」點進該位會員就能操作;要調整點數核發規則，請找商家管理員開放「紅利點數」權限。"
              action={
                <Button asChild variant="primary" size="touch">
                  <Link to="/app/members">去會員管理</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}
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
