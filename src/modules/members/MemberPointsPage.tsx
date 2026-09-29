// 這頁目前(SPECS-INDEX #830 之後)只剩紅利點數的「規則設定」:核發獎勵資格條件 + 點數設定(啟用開關
// /消費點數比例/推薦獎勵/生日贈點)。個別會員的點數餘額、異動歷史、手動調整、登記兌換這些「交易」
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
// **只動外觀,不動行為**:兩段權限的判斷(canManagePointsRules)、整列 upsert 的 saveSettingsRow、
// 選了就直接存的核發資格條件、三個數字欄位的驗證與儲存、所有文案的意思全部照舊。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  EmptyState,
  FieldInput,
  FieldSelect,
  FormField,
  LoadingSkeleton,
  PageHeader,
  parseAmountInput,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  upsertMerchantMemberSettings,
  useMerchantMemberSettings,
  type UpsertMerchantMemberSettingsInput,
} from "./api";
import { previewLoyaltyPoints } from "./previewCalculators";
import { RequireMemberPointsAccess } from "./RequireMemberPointsAccess";
import { REWARD_CONDITION_MODE_LABELS, type RewardConditionMode } from "./types";

function MemberPointsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
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
  // 當時是同一頁由兩把鑰匙共管:交易歸既有的 members,規則歸新增的 member_points。
  // (#830 之後「交易」那四項已經不在這頁、搬到會員詳情頁,這頁只剩「規則」;鑰匙歸屬沒變。)
  // 整頁的進入守衛(RequireMemberPointsAccess)刻意「維持只認 members」——否則只有交易權限的
  // 客服連這一頁都進不去,就違反使用者「客服可以處理會員管理內的資料包含紅利點數異動等等」的裁決。
  // (SPECS-INDEX #830 之後「交易」那一半已搬到會員詳情頁,這頁只剩規則;守衛仍維持不變的理由
  //  改見檔案開頭的 #830 說明。下面 canManagePointsRules 的判斷本身一個字都沒動。)
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

  const { data: settings, isLoading: settingsLoading } = useMerchantMemberSettings(merchantId);

  useEffect(() => {
    if (!settings) return;
    setPointsEarnRate(String(settings.points_earn_rate));
    setReferralBonusPoints(String(settings.referral_bonus_points));
    setBirthdayBonusPoints(String(settings.birthday_bonus_points));
    setRewardConditionMode(settings.reward_condition_mode as RewardConditionMode);
  }, [settings]);

  // 🔴 2026-09-30(品管第二次打回,🟡 第 1 項):這三欄原本是 `Number(x)` + `Number.isNaN` /
  // `Number.isInteger`,實測放行了:
  //   ・消費點數比例填 `Infinity` ⇒ `Number.isNaN(Infinity)` 是 false、`Infinity < 0` 也是 false
  //     ⇒ **比例被存成 Infinity**
  //   ・`1e3` ⇒ 靜默變 1000、`0x10` ⇒ 靜默變 16(三欄都會)
  //   ・清空欄位 ⇒ `Number("")` = 0 ⇒ 靜默存成 0
  // 改走全站共用的 parseAmountInput(規則與白話錯誤訊息都在那支函式裡)。
  // 推薦獎勵 / 生日贈點是**點數**,一定是整數 ⇒ 傳 integerOnly;消費點數比例是「幾元換 1 點」,
  // 本來就允許小數(原本用的是 Number.isNaN 而不是 Number.isInteger),所以不傳。
  // 錯誤訊息從目前輸入內容即時算出來 ⇒ 改成正確的數字就會自己消失。
  const parsedRate = parseAmountInput(pointsEarnRate);
  const parsedReferral = parseAmountInput(referralBonusPoints, { integerOnly: true });
  const parsedBirthday = parseAmountInput(birthdayBonusPoints, { integerOnly: true });
  const hasPointsFieldError = !parsedRate.ok || !parsedReferral.ok || !parsedBirthday.ok;

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
    // 🔴 2026-09-30:三欄的錯誤已經即時顯示在各自欄位下面、儲存鈕也 disabled,這裡是防呆。
    if (!parsedRate.ok || !parsedReferral.ok || !parsedBirthday.ok) {
      toast.error("有欄位填錯了", { description: "請看標紅的欄位,只能填數字。" });
      return;
    }
    setSavingPoints(true);
    try {
      await saveSettingsRow({
        pointsEarnRate: parsedRate.value,
        referralBonusPoints: parsedReferral.value,
        birthdayBonusPoints: parsedBirthday.value,
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
      {/* 2026-09-24 使用者裁決:這頁分成「交易」與「規則」兩段權限之後,頁面描述也要跟著分流。
          SPECS-INDEX #830 之後「交易」那一半已搬到會員管理的會員詳情頁,這頁只剩規則,描述照實改寫:
          有規則權限的人看到的是規則說明;沒有的人要被明確告知這頁沒有他能操作的東西、以及點數
          交易現在去哪裡做,不要讓他在頁面上找一個看不到的東西。 */}
      <PageHeader
        backTo="/app/manage"
        title="紅利點數管理"
        description={
          canManagePointsRules
            ? `「${merchant!.name}」的紅利點數核發規則:核發獎勵資格條件、點數設定(啟用開關、消費點數比例、推薦獎勵、生日贈點)。個別會員的點數餘額、手動調整、登記兌換與異動歷史,請到「會員管理」點進該位會員操作。`
            : `這頁是「${merchant!.name}」的紅利點數核發規則(核發獎勵資格條件、啟用開關、消費點數比例、推薦獎勵、生日贈點),需要另外的「紅利點數管理」權限才能查看與調整,請找商家管理員。個別會員的點數餘額、登記兌換與異動歷史,請到「會員管理」點進該位會員操作。`
        }
      />

      {settings && settings.points_feature_enabled === false ? (
        // 🟡 常駐 `!`:skill 二的表格裡「功能已關閉,資料不會被清空」就是這一類的原始例子。
        <AlertNote>
          <strong>目前紅利點數功能已關閉</strong>
          ,系統不會再自動給任何新點數(客人消費、推薦朋友、生日都不發),
          建單表單與會員詳情頁也不再顯示任何點數相關的內容與入口。既有的點數餘額與異動歷史不會被清空,
          重新開啟後會完整還原顯示。
          {/* 2026-09-29 第三輪使用者裁決(#830 修正):功能關閉時會員詳情頁的「點數」卡片整張隱藏,
              所以這裡不能再寫「你仍然可以到會員管理點進某位會員手動調整/登記兌換」——那個入口關閉
              期間不存在,寫了就是說謊。要結清點數請先重新開啟功能。後端關閉時仍放行 adjust/redeem
              的設計(migration 20260924030000)不動,只是前端沒有入口。 */}
          {/* 2026-09-24 使用者裁決:這句「要重新開啟請到下方點數設定」只有看得到那張卡片的人適用。
              沒有 member_points 權限的客服看不到那張卡片,對他們說「去下方切換開關」等於叫他們去找
              一個畫面上不存在的東西,所以改成告訴他們該找誰。 */}
          {canManagePointsRules
            ? "要重新開啟,請到下方「點數設定」切換開關。"
            : "要重新開啟這個功能需要「紅利點數管理」權限,請找商家管理員處理。"}
        </AlertNote>
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
                消費紅利/推薦獎勵/生日贈點核發前,是否要求會員符合特定資格。選了就直接存,沒有另外的儲存按鈕。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {settingsLoading ? (
                <LoadingSkeleton variant="lines" rows={1} />
              ) : (
                <>
                  <FormField label="資格條件" htmlFor="reward-condition-mode">
                    {/* guardPhantomEmptyChange:這個 value 是掛載後才由上面的 useEffect 從 settings
                    灌進來的,不套防護會被 Radix 隱藏原生 select 補發的空字串事件洗掉
                    (見 src/lib/radixSelectGuard.ts)。合法值是 REWARD_CONDITION_MODE_LABELS
                    這份固定列舉,所以判斷條件用白名單。 */}
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
                  {/* 🟡 常駐 `!`:現在的狀態跟使用者以為的不一樣 —— 商家會以為這個選項能擋掉
                      用假電話註冊的人(skill 二,第三類)。 */}
                  <AlertNote>
                    「電話已驗證」只是<strong>客服人工標記</strong>
                    ,不是真的簡訊驗證,無法擋住用假電話註冊的人。
                  </AlertNote>
                </>
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
            <CardContent className="flex flex-col gap-5">
              {settingsLoading ? (
                <LoadingSkeleton variant="lines" rows={4} />
              ) : (
                <>
                  {/* skill 二之七:開關做成一整列;長說明拆成一行摘要 + 一條常駐 `!`
                      (「關閉後系統不再自動給點數」是 skill 二點名的第二類)。 */}
                  <SwitchRow
                    id="points-feature-enabled"
                    title="啟用紅利點數功能"
                    description="控制整間店要不要跑紅利點數。"
                    checked={settings ? settings.points_feature_enabled : true}
                    disabled={savingFeatureToggle}
                    onCheckedChange={handleToggleFeatureEnabled}
                  >
                    <AlertNote>
                      關閉後<strong>系統就不再自動給點數了</strong>
                      :客人消費不再累點、推薦朋友不發獎勵、生日也不送點。建單表單與會員詳情頁也不再
                      顯示任何點數相關的數字與入口(要結清某位會員剩下的點數,請先重新開啟功能、
                      結清後再關閉);既有的點數餘額與異動歷史不會被清空,重新開啟後會完整還原顯示。
                    </AlertNote>
                  </SwitchRow>

                  <FormField
                    label="消費點數比例(元/點)"
                    htmlFor="points-earn-rate"
                    error={parsedRate.ok ? null : parsedRate.error}
                    help="每消費 N 元累積 1 點。目前是 0,代表還沒設定——請填入實際比例,系統不會自動幫你套用任何數字。只能填數字和小數點。"
                    helpLabel="說明:消費點數比例怎麼設定"
                  >
                    <FieldInput
                      id="points-earn-rate"
                      type="text"
                      inputMode="decimal"
                      className="tabular-nums sm:w-40"
                      value={pointsEarnRate}
                      onChange={(e) => setPointsEarnRate(e.target.value)}
                    />
                  </FormField>
                  {parsedRate.ok ? (
                    // 即時回饋(不是可以收起來的補充)⇒ 常駐的預覽框,不收進 `?`。
                    // 🔴 2026-09-30:守門從 `!Number.isNaN(numericRate)` 換成 parsedRate.ok ——
                    // 舊條件在填 `Infinity` 時是 true,試算框會照著算出一個沒有意義的數字。
                    <p className="-mt-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                      範例試算:一筆 1000 元的訂單,這位會員可以拿到{" "}
                      <strong className="tabular-nums">
                        {previewLoyaltyPoints(1000, parsedRate.value)}
                      </strong>{" "}
                      點(僅供參考,實際點數以訂單完成時系統計算為準,計算基準是含稅總額)。
                    </p>
                  ) : null}

                  <FormField
                    label="推薦獎勵點數"
                    htmlFor="referral-bonus-points"
                    error={parsedReferral.ok ? null : parsedReferral.error}
                    help="被推薦人完成第一筆訂單時,推薦人可以拿到的點數。填 0 就是不發推薦獎勵。點數只能填整數。"
                    helpLabel="說明:推薦獎勵什麼時候發"
                  >
                    <FieldInput
                      id="referral-bonus-points"
                      type="text"
                      inputMode="numeric"
                      className="tabular-nums sm:w-40"
                      value={referralBonusPoints}
                      onChange={(e) => setReferralBonusPoints(e.target.value)}
                    />
                  </FormField>

                  <FormField
                    label="生日贈點"
                    htmlFor="birthday-bonus-points"
                    error={parsedBirthday.ok ? null : parsedBirthday.error}
                    help="生日當月核發的點數(以月為單位容錯,不是精確當天準時發放——商家下次打開會員管理列表頁時系統才會補發)。填 0 就是不發生日贈點。點數只能填整數。"
                    helpLabel="說明:生日贈點什麼時候發"
                  >
                    <FieldInput
                      id="birthday-bonus-points"
                      type="text"
                      inputMode="numeric"
                      className="tabular-nums sm:w-40"
                      value={birthdayBonusPoints}
                      onChange={(e) => setBirthdayBonusPoints(e.target.value)}
                    />
                  </FormField>

                  {/* 🔴 2026-09-30:有欄位填錯時擋住儲存,不能只顯示紅字。按鈕變灰就要說明原因
                      (skill 二之三),所以配一條常駐 `!`。 */}
                  {hasPointsFieldError ? (
                    <AlertNote>
                      上面有欄位填錯了(標紅的那幾格),修好之後才能儲存。點數只能填整數,比例可以有小數點。
                    </AlertNote>
                  ) : null}
                  {/* 這一頁唯一的 ① 主要按鈕(核發資格條件是選了就直接存,沒有按鈕)。 */}
                  <Button
                    type="button"
                    variant="primary"
                    size="touch"
                    className="self-start"
                    disabled={savingPoints || hasPointsFieldError}
                    onClick={handleSavePoints}
                  >
                    {savingPoints ? "儲存中⋯" : "儲存"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        /* SPECS-INDEX #830:交易那一半搬走之後,只有 members、沒有 member_points 權限的客服打開這頁
           會什麼卡片都看不到(守衛刻意不改,見檔案開頭)。這裡補一段說明,避免看起來像壞掉。 */
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="你目前的權限看不到這頁的規則設定"
              description="個別會員的點數餘額、登記兌換與異動歷史,在「會員管理」點進該位會員就能操作;要調整點數核發規則,請找商家管理員開放「紅利點數管理」權限。"
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
