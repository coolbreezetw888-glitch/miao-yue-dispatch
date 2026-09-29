// 對應規格書 4.2(商家設定頁)、4.3(唯讀管理員清單)、4.7(主題色系)、4.8(公告開關與內容)。
//
// 2026-09-16 主腦複查補上的既有缺口:這個頁面從模組 1 上線以來就沒有套用任何路由守衛
// (後台導覽外殼重構時才被發現——當時「功能」分頁籤的卡片本身已經只對 isAdmin 顯示這個入口,
// 但直接輸入網址 `/app/settings` 深層連結不受影響)。這次比照 `StaffListPage.tsx`/
// `AgentListPage.tsx`/`AgentPermissionsPage.tsx` 既有用法,直接用專案既有的
// `RequireMerchantAdmin`(見 `src/modules/staff-agent/RequireMerchantAdmin.tsx`)把整個頁面包起來,
// 不重新設計判斷邏輯——非管理員(含客服、或還沒選定商家)一律導回 `/app`,不顯示這個頁面存在。
//
// 建單與訂單管理介面優化 §十(SPECS-INDEX #633):把訂單狀態顏色設定卡片(原本 #620/#621
// 掛在 OrdersPage.tsx)搬來這裡——使用者實際用過後認為顏色屬於商家層級設定,不是訂單管理頁該有
// 的日常操作項目。資料表(merchant_booking_status_colors)/RLS/RPC 完全不動,純粹是 UI 搬家,
// 讀寫都透過 booking 模組既有的對外介面(`@/modules/booking/context` 的
// useMerchantBookingStatusColors/updateMerchantBookingStatusColors、`@/modules/booking/types`
// 的 BookingStatusColorMap/DEFAULT_BOOKING_STATUS_COLORS),不直接碰 booking 模組內部實作,
// 比照 `StaffListPage.tsx` 既有的跨模組 import 慣例(該檔案也是這樣呼叫 booking 模組的
// api.ts/context.tsx/types.ts)。
// 這裡刻意獨立於下面「基本資料/主題色系/公告」共用的那個 <form onSubmit>,自己有自己的
// 「儲存」按鈕、自己呼叫 updateMerchantBookingStatusColors——因為它寫入的是完全不同的一張表
// (merchant_booking_status_colors,不是 merchants 表),跟主表單的 updateMerchantSettings
// 混在同一次送出反而會讓「這次到底存了什麼」變得不直覺,獨立儲存跟原本在 OrdersPage.tsx 的
// 行為一致(那裡本來就是自己一顆按鈕)。
//
// 權限備註(待主腦/使用者確認):這個頁面整頁套用 RequireMerchantAdmin(只有商家管理員能進來);
// 搬家前,顏色設定卡片是掛在 OrdersPage.tsx,守衛是 OrdersTabAccessGate——admin 或「有 orders
// 權限的客服(agent)」都看得到、能改。搬到這裡之後,沒有 orders 權限、但原本能調顏色的客服
// 帳號會失去這個設定的存取權(只剩商家管理員能改)。這是移動到「商家設定」頁面後的自然結果
// (這個頁面本來就整頁只開放管理員),沒有另外新增或收緊任何權限判斷邏輯,但如果之前有客服
// 帳號依賴這個功能,需要請他們改請商家管理員代為設定。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架;找不到商家改 ErrorState(二之八)。
//   - 所有欄位改 FormField + FieldInput / FieldTextarea / FieldSelect;說明文字收進 `?`(二 / 二之七)。
//   - 🔴 產業模組的下拉:原本是手寫的「不在白名單就 return」防護(那其實就是
//     guardPhantomEmptyChange 白名單版的手寫版本),改成直接用共用 helper,行為完全相同、
//     原本那段踩坑說明原樣保留(skill 第 1/2 批裁決:FieldSelect 的 guard 一律保留)。
//   - 「啟用公告」改 SwitchRow(二之七)。
//   - 兩張顏色設定卡的原生色彩選擇器改用新補的共用元件 FieldColor(44px 見方,原本只有 32px,
//     不到 skill 二之三的觸控目標);色碼文字框改 FieldInput + 等寬字 + 大寫。
//   - 按鈕階層(二之三):主表單的「儲存變更」與底部固定提示列的那一顆是**同一個動作**⇒ ① 主要;
//     兩張顏色卡各自的「儲存」寫入的是別張表、屬於子區塊的動作 ⇒ ② 次要(否則一個畫面上會出現
//     三顆互相競爭的主要按鈕);「新增分店」是跳頁 ⇒ ② 次要。
//   - 「預約網址」那一塊是唯讀的事實,不是欄位,改成明細列樣式的唯讀區塊 + `?` 說明。
//
// **只動外觀,不動行為**:主表單一次送出哪些欄位、兩張顏色卡各自獨立儲存、hasUnsavedChanges
// 的判斷與底部固定提示列的層級(BOTTOM_LAYER_ACTION_BAR)、LOGO 選完即上傳全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ErrorState,
  FieldColor,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
  LoadingSkeleton,
  PageHeader,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { acquireBottomActionBarSlot, BOTTOM_LAYER_ACTION_BAR } from "@/lib/bottomFixedLayers";
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { cn } from "@/lib/utils";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import {
  updateMerchantBookingStatusColors,
  useMerchantBookingStatusColors,
  updateMerchantCalendarStateStyles,
  useMerchantCalendarStateStyles,
} from "@/modules/booking/context";
import {
  DEFAULT_BOOKING_STATUS_COLORS,
  DEFAULT_CALENDAR_STATE_STYLES,
  calendarStateBlockStyle,
  type BookingStatusColorMap,
  type CalendarStateStyleMap,
  type CalendarStateType,
} from "@/modules/booking/types";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

import { updateMerchantSettings, uploadMerchantLogo } from "./api";
import { useCurrentMerchant, useRefetchAccessibleMerchants } from "./context";
import { LogoUploader } from "./LogoUploader";
import { MerchantAdminList } from "./MerchantAdminList";
import { ThemePresetPicker } from "./ThemePresetPicker";
import { INDUSTRY_TYPES, INDUSTRY_TYPE_LABELS } from "./types";
import type { IndustryType } from "./types";

/** 「基本資料/主題色系/公告」那一份主表單的 id——頁面底部固定提示列裡的儲存按鈕用 form 屬性
 * 指向它,兩顆按鈕送出的是同一份表單。 */
const MERCHANT_SETTINGS_FORM_ID = "merchant-settings-form";

function MerchantSettingsPageInner() {
  const { merchant, isLoading } = useCurrentMerchant();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();

  const [name, setName] = useState("");
  const [industryType, setIndustryType] = useState<IndustryType>("on_site_dispatch");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [intro, setIntro] = useState("");
  const [themePreset, setThemePreset] = useState<string | null>(null);
  const [themeCustomColor, setThemeCustomColor] = useState<string | null>(null);
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcementContent, setAnnouncementContent] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次切換到不同商家時，把表單狀態重新灌成該商家目前的資料。
  useEffect(() => {
    if (!merchant) return;
    setName(merchant.name);
    setIndustryType(merchant.industry_type as IndustryType);
    setAddress(merchant.address ?? "");
    setPhone(merchant.phone ?? "");
    setContactEmail(merchant.contact_email ?? "");
    setIntro(merchant.intro ?? "");
    setThemePreset(merchant.theme_preset);
    setThemeCustomColor(merchant.theme_custom_color);
    setAnnouncementEnabled(merchant.announcement_enabled);
    setAnnouncementContent(merchant.announcement_content ?? "");
  }, [merchant?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 使用者回報(2026-09-24):「儲存變更」按鈕在頁面最下方(要捲過地址/電話/主題色/公告/管理員
  // 名單才看得到),而上方的「產業模組」下拉選單改完之後沒有任何提示,使用者以為選了就生效,
  // 結果根本沒存到。這裡比對表單目前的值跟資料庫存的值,只要有任何一項不一樣就顯示一條固定在
  // 畫面底部的提示列(見下方 render),讓「你還沒儲存」這件事不可能被忽略。
  // LOGO 不列入比對——它在上傳成功的當下就已經自己存檔了(見 handleLogoUpload),不走這個表單。
  //
  // 2026-09-24 深夜巡檢修正:這段計算刻意放在下面兩個提早 return(載入中/找不到商家)之前,
  // 因為緊接著的 useEffect 必須在每一次 render 都被呼叫到,不能被提早 return 跳過(React Hooks
  // 規則)。還沒載到商家資料時一律當作「沒有未儲存變更」。
  const hasUnsavedChanges = merchant
    ? name !== merchant.name ||
      industryType !== merchant.industry_type ||
      address !== (merchant.address ?? "") ||
      phone !== (merchant.phone ?? "") ||
      contactEmail !== (merchant.contact_email ?? "") ||
      intro !== (merchant.intro ?? "") ||
      themePreset !== merchant.theme_preset ||
      themeCustomColor !== merchant.theme_custom_color ||
      announcementEnabled !== merchant.announcement_enabled ||
      announcementContent !== (merchant.announcement_content ?? "")
    : false;

  // 2026-09-24 深夜巡檢修正(重疊事故):底部的未儲存提示列跟 PWA 安裝提示條原本各自寫死
  // 一模一樣的 `fixed inset-x-0 bottom-16 z-40`,安裝提示條會把「儲存變更」那顆按鈕整個蓋掉。
  // 現在兩邊都改從 src/lib/bottomFixedLayers.ts 取 class,而且這條提示列出現時主動登記一下,
  // 讓優先度較低的提示條自動往上讓開。完整原委見那個檔案開頭的說明。
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    return acquireBottomActionBarSlot();
  }, [hasUnsavedChanges]);

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架,不要用「載入中⋯」四個字。
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
        <LoadingSkeleton variant="lines" rows={3} />
        <LoadingSkeleton variant="cards" rows={3} />
      </main>
    );
  }

  if (!merchant) {
    // skill 二之八:出錯要講三件事 +「你的資料沒有遺失」(那句由 ErrorState 固定加上)。
    return (
      <main className="mx-auto max-w-2xl px-5 py-12">
        <ErrorState
          title="找不到目前操作中的商家"
          reason="可能是剛剛切換商家的時候斷線,或是這個帳號在這間店的管理員身分被移除了"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app">回到後台首頁</Link>
            </Button>
          }
        />
      </main>
    );
  }

  async function handleLogoUpload(file: File) {
    const url = await uploadMerchantLogo(merchant!.id, file);
    await updateMerchantSettings(merchant!.id, { logoUrl: url });
    await refetchAccessibleMerchants();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateMerchantSettings(merchant!.id, {
        name,
        industryType,
        address: address || null,
        phone: phone || null,
        contactEmail: contactEmail || null,
        intro: intro || null,
        themePreset,
        themeCustomColor,
        announcementEnabled,
        announcementContent: announcementContent || null,
      });
      await refetchAccessibleMerchants();
      toast.success("商家設定已儲存");
    } catch (err) {
      // 2026-09-24 深夜巡檢修正:原本寫 `err instanceof Error ? err.message : "請稍後再試"`,
      // 但 Supabase 回傳的 error 只是 JSON.parse 出來的一般物件、不是 Error 的實例,
      // instanceof 永遠 false,資料庫真正擋下來的原因(欄位約束、權限、防呆訊息)永遠被吞掉。
      // 改用本檔案上方早就 import 好、卻漏了在這裡使用的 getErrorMessage()。
      // 完整根因見 src/modules/platform-admin/getErrorMessage.ts 的檔頭說明。
      toast.error("儲存失敗", { description: getErrorMessage(err, "請稍後再試") });
    } finally {
      setSaving(false);
    }
  }

  return (
    // 有未儲存提示列時多留一段底部空間,避免最後一張卡片被那條固定提示列蓋住。
    <main className={cn("mx-auto max-w-3xl space-y-6 px-5 py-12", hasUnsavedChanges && "pb-32")}>
      <PageHeader
        backTo="/app/manage"
        title="商家設定"
        description={`管理「${merchant.name}」的基本資料與外觀`}
      />

      {/* 下方固定提示列的「儲存變更」按鈕靠這個 id 送出同一份表單(HTML 原生的 form 屬性),
          不用把按鈕真的塞進表單裡面,也就不會影響既有版面。 */}
      <form id={MERCHANT_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>基本資料</CardTitle>
            <CardDescription>LOGO、店名、地址、電話、對外聯絡信箱與簡介</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <LogoUploader currentLogoUrl={merchant.logo_url} onUpload={handleLogoUpload} />

            <FormField label="店名" htmlFor="settings-name" required>
              <FieldInput
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>

            <FormField
              label="產業模組"
              htmlFor="settings-industry-type"
              help="可隨時切換,只影響之後新增/編輯預約時「客戶地址」欄位要不要顯示/必填(到府派工要填、到店服務不用),不會更動已經建立的訂單資料。"
              helpLabel="說明:切換產業模組會影響什麼"
            >
              <FieldSelect<IndustryType>
                id="settings-industry-type"
                value={industryType}
                // Radix Select 內部會額外渲染一個隱藏的原生 <select>(給表單相容用)。實測發現:
                // 受控的 value 在「掛載之後」才被 useEffect 從資料庫灌進新值時(這個頁面正是這種
                // 情況——初始值是 on_site_dispatch,資料載入後才改成商家實際的值),瀏覽器會對那個
                // 隱藏的原生 select 補發一次 change 事件,把空字串回傳進 onValueChange,瞬間把剛
                // 灌好的值洗成空白,畫面上的產業模組就變成沒有選取任何東西的空欄位。
                // 這裡只接受合法的產業類型,把這種假事件忽略掉 —— 改用共用的
                // guardPhantomEmptyChange(白名單版),行為跟原本手寫的判斷完全相同。
                onValueChange={guardPhantomEmptyChange<IndustryType>(setIndustryType, (v) =>
                  INDUSTRY_TYPES.includes(v as IndustryType),
                )}
                options={INDUSTRY_TYPES.map((type) => ({
                  value: type,
                  label: INDUSTRY_TYPE_LABELS[type],
                }))}
              />
            </FormField>

            <FormField label="地址" htmlFor="settings-address">
              <FieldInput
                id="settings-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </FormField>

            <FormField label="電話" htmlFor="settings-phone">
              <FieldInput
                id="settings-phone"
                type="tel"
                inputMode="tel"
                className="tabular-nums"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </FormField>

            <FormField
              label="對外聯絡 Email"
              htmlFor="settings-contact-email"
              help="這是顯示給客戶看的信箱,跟你登入帳號用的 Email 是不同的兩件事。改這裡不會影響你怎麼登入。"
              helpLabel="說明:對外聯絡 Email 跟登入信箱的差別"
            >
              <FieldInput
                id="settings-contact-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </FormField>

            <FormField label="商家簡介" htmlFor="settings-intro">
              <FieldTextarea
                id="settings-intro"
                rows={3}
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
              />
            </FormField>

            <FormField
              label="預約網址"
              help="這組網址代碼由系統自動產生,目前不開放自行修改。實際的客戶預約頁面會在「客戶端自助預約」模組推出。"
              helpLabel="說明:預約網址是什麼、可以改嗎"
            >
              {/* 唯讀的事實,不是可編輯欄位 ⇒ 用灰底區塊表示「看得到但動不了」,不做成 disabled
                  輸入框(disabled 的輸入框會讓人一直想點它)。 */}
              <p className="break-all rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-sm text-muted-foreground">
                {merchant.booking_slug ?? "尚未產生"}
              </p>
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>主題色系</CardTitle>
            <CardDescription>選一組基礎色系,或自訂一個顏色</CardDescription>
          </CardHeader>
          <CardContent>
            <ThemePresetPicker
              themePreset={themePreset}
              themeCustomColor={themeCustomColor}
              onChangePreset={setThemePreset}
              onChangeCustomColor={setThemeCustomColor}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>公告</CardTitle>
            <CardDescription>在客戶看到的頁面上顯示一則公告訊息</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* skill 二之七:開關做成一整列(左邊標題 + 一行說明,右邊開關)。 */}
            <SwitchRow
              id="settings-announcement-enabled"
              title="啟用公告"
              description="關閉時,即使填了內容,客戶端也不會顯示(內容會保留)。"
              checked={announcementEnabled}
              onCheckedChange={setAnnouncementEnabled}
            />
            <FormField label="公告內容" htmlFor="settings-announcement-content">
              <FieldTextarea
                id="settings-announcement-content"
                rows={3}
                value={announcementContent}
                onChange={(e) => setAnnouncementContent(e.target.value)}
                placeholder="公告關閉時,這裡的內容不會顯示,但會保留"
              />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>管理員名單</CardTitle>
            <CardDescription>目前能管理這間店的帳號(唯讀)</CardDescription>
          </CardHeader>
          <CardContent>
            <MerchantAdminList merchantId={merchant.id} />
          </CardContent>
        </Card>

        {/* 這一頁的 ① 主要按鈕(底部固定提示列那一顆是同一個動作,不算第二顆)。 */}
        <Button
          type="submit"
          variant="primary"
          size="touch"
          className="w-full"
          disabled={saving || !hasUnsavedChanges}
        >
          {saving ? "儲存中⋯" : hasUnsavedChanges ? "儲存變更" : "沒有需要儲存的變更"}
        </Button>
      </form>

      {/* 建單與訂單管理介面優化 §十(SPECS-INDEX #633):訂單狀態顏色設定,從 OrdersPage.tsx
          搬過來。刻意放在上面那個 <form> 外面——它寫入的是完全不同的一張表
          (merchant_booking_status_colors),自己有自己的「儲存」按鈕跟載入/儲存狀態,不跟著
          主表單的 handleSubmit 一起送出。 */}
      <BookingStatusColorsCard merchantId={merchant.id} />

      {/* SPECS-INDEX #644:行事曆排程狀態顏色設定(全天休假/時段排休/跨店佔用)——跟上面訂單
          狀態顏色設定平行但完全獨立的新區塊,寫入的是完全不同的一張表
          (merchant_calendar_state_styles),自己的「儲存」按鈕跟載入/儲存狀態。 */}
      <CalendarStateStylesCard merchantId={merchant.id} />

      {/* 使用者決策(2026-09-23):「新增分店」從舊版 HomePage.tsx 搬到這裡最下方——這個頁面
          整頁已經套用 RequireMerchantAdmin,自然滿足「只有管理員這個角色時才會出現」,不需要
          另外加角色判斷。 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">新增分店</p>
          <p className="mt-0.5 text-xs text-muted-foreground">在同一個集團底下再開一間新的分店</p>
        </div>
        {/* ② 次要:跳頁,不是這一頁的主要動作(skill 二之三)。 */}
        <Button asChild variant="neutral" size="card" className="shrink-0">
          <Link to="/app/new-merchant">新增分店</Link>
        </Button>
      </div>

      {/* 使用者回報(2026-09-24):原本唯一的「儲存變更」按鈕在頁面最下方,使用者在上方改完
          「產業模組」之後,沒有任何提示告訴他還沒儲存,結果以為選了就生效。這條提示列只在真的
          有未儲存變更時才出現,固定在畫面底部(疊在底部分頁籤上方,讓開分頁籤的高度),
          不管捲到哪裡都看得到,而且直接附一顆儲存按鈕,不用再捲回去找。
          位置/層級一律取自 src/lib/bottomFixedLayers.ts 的 BOTTOM_LAYER_ACTION_BAR,不再自己
          寫死 bottom 距離跟 z-index(2026-09-24 深夜巡檢:寫死的數字跟 PWA 安裝提示條撞在一起,
          那條提示把這顆儲存按鈕整個蓋掉)。 */}
      {hasUnsavedChanges ? (
        <div
          className={cn(
            BOTTOM_LAYER_ACTION_BAR,
            "border-y border-border bg-background shadow-[0_-4px_12px_rgba(0,0,0,0.1)]",
          )}
        >
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-3">
            <p className="text-sm font-semibold text-foreground">尚未儲存變更</p>
            {/* 跟上面表單裡那顆是**同一個動作**(form= 指回同一份表單),不是第二顆主要按鈕。 */}
            <Button
              type="submit"
              form={MERCHANT_SETTINGS_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "儲存中⋯" : "儲存變更"}
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// 建單與訂單管理介面優化 §十(SPECS-INDEX #633,原 §十 10.6 / #620 #621):訂單狀態顏色設定卡片。
// 4 個狀態各自一個 <input type="color">(原生色彩選擇器)+ 色碼文字輸入框 + 即時預覽色塊,
// 跟搬家前在 OrdersPage.tsx 的實作完全一致,只是掛載位置換成這個頁面。這個元件只在
// RequireMerchantAdmin 通過後才會渲染,不需要再重複判斷一次權限。
// ---------------------------------------------------------------------------
const STATUS_COLOR_FIELDS: { key: keyof BookingStatusColorMap; label: string }[] = [
  { key: "pendingConfirmation", label: "待確認" },
  { key: "accepted", label: "已確認" },
  { key: "completed", label: "已完成" },
  { key: "cancelled", label: "已取消" },
];

function BookingStatusColorsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: colors, isLoading } = useMerchantBookingStatusColors(merchantId);
  const [form, setForm] = useState<BookingStatusColorMap>(DEFAULT_BOOKING_STATUS_COLORS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (colors) setForm(colors);
  }, [colors]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateMerchantBookingStatusColors(merchantId, form);
      await queryClient.invalidateQueries({
        queryKey: ["booking-module", "merchant-booking-status-colors", merchantId],
      });
      toast.success("已更新訂單狀態顏色設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>訂單狀態顏色設定</CardTitle>
        <CardDescription>
          自訂 4 種訂單狀態在行事曆、訂單管理頁顯示的代表色。這次不強制檢查顏色搭配文字是否夠清楚,
          請自行參考右側的即時預覽色塊判斷。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={4} />
        ) : (
          <>
            {STATUS_COLOR_FIELDS.map(({ key, label }) => (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <span className="shrink-0 text-[13px] font-semibold text-foreground sm:w-16">
                  {label}
                </span>
                <FieldColor
                  aria-label={`「${label}」的代表色`}
                  value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : "#000000"}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <FieldInput
                  aria-label={`「${label}」的色碼`}
                  className="w-28 min-w-0 font-mono uppercase"
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                {/* 即時預覽色塊,跟搬家前行為一致。 */}
                <span
                  className="ml-auto shrink-0 rounded-md border border-border px-3 py-1 text-xs font-medium"
                  style={{ backgroundColor: form[key], color: "#ffffff" }}
                >
                  預覽文字
                </span>
              </div>
            ))}
            {/* ② 次要:這張卡片寫入的是另一張表、屬於子區塊的儲存;這一頁的 ① 主要按鈕是
                上面主表單的「儲存變更」(skill 二之三)。 */}
            <Button
              type="button"
              variant="neutral"
              size="touch"
              className="self-start"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SPECS-INDEX #644:行事曆排程狀態顏色設定卡片。3 個狀態各自一個 <input type="color">
// (原生色彩選擇器)+ 色碼文字輸入框 + 即時預覽色塊——這次的預覽色塊直接套用
// calendarStateBlockStyle(跟 CalendarPage.tsx/MyCalendarTimelineView.tsx 實際渲染時完全同一支
// 函式),讓商家在設定畫面就能看到跟行事曆上一模一樣的圖樣效果(斜線/交叉網格),不是只看到
// 純色塊。這個元件只在 RequireMerchantAdmin 通過後才會渲染,不需要再重複判斷一次權限。
// ---------------------------------------------------------------------------
const CALENDAR_STATE_FIELDS: {
  key: keyof CalendarStateStyleMap;
  state: CalendarStateType;
  label: string;
  hint: string;
}[] = [
  { key: "fullDayLeave", state: "full_day_leave", label: "全天休假", hint: "密集 45 度斜線" },
  { key: "partialLeave", state: "partial_leave", label: "時段排休", hint: "稀疏 45 度斜線" },
  {
    key: "crossStoreOccupied",
    state: "cross_store_occupied",
    label: "跨店佔用",
    hint: "交叉網格紋",
  },
];

function CalendarStateStylesCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: styles, isLoading } = useMerchantCalendarStateStyles(merchantId);
  const [form, setForm] = useState<CalendarStateStyleMap>(DEFAULT_CALENDAR_STATE_STYLES);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (styles) setForm(styles);
  }, [styles]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateMerchantCalendarStateStyles(merchantId, form);
      await queryClient.invalidateQueries({
        queryKey: ["booking-module", "merchant-calendar-state-styles", merchantId],
      });
      toast.success("已更新行事曆排程狀態顏色設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>行事曆排程狀態顏色設定</CardTitle>
        <CardDescription>
          自訂「全天休假」「時段排休」「跨店佔用」這 3 種行事曆排程狀態的底色,同時套用到商家/
          客服端行事曆跟服務人員自己的行事曆,兩邊看到的顏色一致。每種狀態固定搭配一種圖樣
          (不是純色塊),方便一眼分辨是哪一種狀態,不用只靠顏色判斷。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={3} />
        ) : (
          <>
            {CALENDAR_STATE_FIELDS.map(({ key, state, label, hint }) => (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2.5"
              >
                <div className="shrink-0 sm:w-20">
                  <span className="block text-[13px] font-semibold text-foreground">{label}</span>
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </div>
                <FieldColor
                  aria-label={`「${label}」的底色`}
                  value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : "#000000"}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <FieldInput
                  aria-label={`「${label}」的色碼`}
                  className="w-28 min-w-0 font-mono uppercase"
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                {/* 即時預覽:直接套用實際渲染時用的同一支函式,商家看到的圖樣效果跟行事曆上
                    一模一樣。 */}
                <span
                  className="ml-auto flex h-9 w-24 shrink-0 items-center justify-center rounded-md border text-[11px] font-medium"
                  style={calendarStateBlockStyle(form, state)}
                >
                  預覽
                </span>
              </div>
            ))}
            {/* ② 次要:理由同上面那張顏色卡。 */}
            <Button
              type="button"
              variant="neutral"
              size="touch"
              className="self-start"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function MerchantSettingsPage() {
  return (
    <RequireMerchantAdmin>
      <MerchantSettingsPageInner />
    </RequireMerchantAdmin>
  );
}
