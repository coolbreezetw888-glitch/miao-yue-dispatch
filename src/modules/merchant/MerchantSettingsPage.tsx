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

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (!merchant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">找不到目前操作中的商家</p>
      </div>
    );
  }

  // 使用者回報(2026-09-24):「儲存變更」按鈕在頁面最下方(要捲過地址/電話/主題色/公告/管理員
  // 名單才看得到),而上方的「產業模組」下拉選單改完之後沒有任何提示,使用者以為選了就生效,
  // 結果根本沒存到。這裡比對表單目前的值跟資料庫存的值,只要有任何一項不一樣就顯示一條固定在
  // 畫面底部的提示列(見下方 render),讓「你還沒儲存」這件事不可能被忽略。
  // LOGO 不列入比對——它在上傳成功的當下就已經自己存檔了(見 handleLogoUpload),不走這個表單。
  const hasUnsavedChanges =
    name !== merchant.name ||
    industryType !== merchant.industry_type ||
    address !== (merchant.address ?? "") ||
    phone !== (merchant.phone ?? "") ||
    contactEmail !== (merchant.contact_email ?? "") ||
    intro !== (merchant.intro ?? "") ||
    themePreset !== merchant.theme_preset ||
    themeCustomColor !== merchant.theme_custom_color ||
    announcementEnabled !== merchant.announcement_enabled ||
    announcementContent !== (merchant.announcement_content ?? "");

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
      toast.error("儲存失敗", { description: err instanceof Error ? err.message : "請稍後再試" });
    } finally {
      setSaving(false);
    }
  }

  return (
    // 有未儲存提示列時多留一段底部空間,避免最後一張卡片被那條固定提示列蓋住。
    <main className={cn("mx-auto max-w-3xl space-y-6 px-5 py-12", hasUnsavedChanges && "pb-32")}>
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">商家設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理「{merchant.name}」的基本資料與外觀
        </p>
      </div>

      {/* 下方固定提示列的「儲存變更」按鈕靠這個 id 送出同一份表單(HTML 原生的 form 屬性),
          不用把按鈕真的塞進表單裡面,也就不會影響既有版面。 */}
      <form id={MERCHANT_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>基本資料</CardTitle>
            <CardDescription>LOGO、店名、地址、電話、對外聯絡信箱與簡介</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <LogoUploader currentLogoUrl={merchant.logo_url} onUpload={handleLogoUpload} />

            <div>
              <Label htmlFor="settings-name">店名</Label>
              <Input
                id="settings-name"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="settings-industry-type">產業模組</Label>
              <Select
                value={industryType}
                // Radix Select 內部會額外渲染一個隱藏的原生 <select>(給表單相容用)。實測發現:
                // 受控的 value 在「掛載之後」才被 useEffect 從資料庫灌進新值時(這個頁面正是這種
                // 情況——初始值是 on_site_dispatch,資料載入後才改成商家實際的值),瀏覽器會對那個
                // 隱藏的原生 select 補發一次 change 事件,把空字串回傳進 onValueChange,瞬間把剛
                // 灌好的值洗成空白,畫面上的產業模組就變成沒有選取任何東西的空欄位。
                // 這裡只接受合法的產業類型,把這種假事件忽略掉。
                onValueChange={(v) => {
                  if (!INDUSTRY_TYPES.includes(v as IndustryType)) return;
                  setIndustryType(v as IndustryType);
                }}
              >
                <SelectTrigger id="settings-industry-type" className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INDUSTRY_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {INDUSTRY_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                可隨時切換,只影響之後新增/編輯預約時「客戶地址」欄位要不要顯示/必填(到府派工要填、
                到店服務不用),不會更動已經建立的訂單資料。
              </p>
            </div>

            <div>
              <Label htmlFor="settings-address">地址</Label>
              <Input
                id="settings-address"
                className="mt-2"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="settings-phone">電話</Label>
              <Input
                id="settings-phone"
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="settings-contact-email">對外聯絡 Email</Label>
              <Input
                id="settings-contact-email"
                type="email"
                className="mt-2"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                這是顯示給客戶看的信箱,跟你登入帳號用的 Email 是不同的兩件事。
              </p>
            </div>

            <div>
              <Label htmlFor="settings-intro">商家簡介</Label>
              <Textarea
                id="settings-intro"
                className="mt-2"
                rows={3}
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
              />
            </div>

            <div>
              <Label>預約網址</Label>
              <p className="mt-2 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
                {merchant.booking_slug ?? "尚未產生"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                這組網址代碼由系統自動產生,目前不開放自行修改。實際的客戶預約頁面會在「客戶端自助預約」模組推出。
              </p>
            </div>
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
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="settings-announcement-enabled">啟用公告</Label>
              <Switch
                id="settings-announcement-enabled"
                checked={announcementEnabled}
                onCheckedChange={setAnnouncementEnabled}
              />
            </div>
            <div>
              <Label htmlFor="settings-announcement-content">公告內容</Label>
              <Textarea
                id="settings-announcement-content"
                className="mt-2"
                rows={3}
                value={announcementContent}
                onChange={(e) => setAnnouncementContent(e.target.value)}
                placeholder="公告關閉時,這裡的內容不會顯示,但會保留"
              />
            </div>
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

        <Button
          type="submit"
          variant="cta"
          size="lg"
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
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
        <div>
          <p className="text-sm font-medium text-foreground">新增分店</p>
          <p className="mt-1 text-xs text-muted-foreground">在同一個集團底下再開一間新的分店</p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/app/new-merchant">新增分店</Link>
        </Button>
      </div>

      {/* 使用者回報(2026-09-24):原本唯一的「儲存變更」按鈕在頁面最下方,使用者在上方改完
          「產業模組」之後,沒有任何提示告訴他還沒儲存,結果以為選了就生效。這條提示列只在真的
          有未儲存變更時才出現,固定在畫面底部(疊在底部分頁籤上方,bottom-16 讓開分頁籤的高度),
          不管捲到哪裡都看得到,而且直接附一顆儲存按鈕,不用再捲回去找。 */}
      {hasUnsavedChanges ? (
        <div className="fixed inset-x-0 bottom-16 z-40 border-y border-border bg-background shadow-[0_-4px_12px_rgba(0,0,0,0.1)]">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-3">
            <p className="text-sm font-medium text-foreground">尚未儲存變更</p>
            <Button
              type="submit"
              form={MERCHANT_SETTINGS_FORM_ID}
              variant="cta"
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
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <>
            {STATUS_COLOR_FIELDS.map(({ key, label }) => (
              <div
                key={key}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="w-16 shrink-0 text-sm font-medium text-foreground">{label}</span>
                <input
                  type="color"
                  className="h-8 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                  value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : "#000000"}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <Input
                  className="w-32"
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                {/* 即時預覽色塊,跟搬家前行為一致。 */}
                <span
                  className="ml-auto rounded-md border border-border px-3 py-1 text-xs font-medium"
                  style={{ backgroundColor: form[key], color: "#ffffff" }}
                >
                  預覽文字
                </span>
              </div>
            ))}
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
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
const CALENDAR_STATE_FIELDS: { key: keyof CalendarStateStyleMap; state: CalendarStateType; label: string; hint: string }[] = [
  { key: "fullDayLeave", state: "full_day_leave", label: "全天休假", hint: "密集 45 度斜線" },
  { key: "partialLeave", state: "partial_leave", label: "時段排休", hint: "稀疏 45 度斜線" },
  { key: "crossStoreOccupied", state: "cross_store_occupied", label: "跨店佔用", hint: "交叉網格紋" },
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
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <>
            {CALENDAR_STATE_FIELDS.map(({ key, state, label, hint }) => (
              <div
                key={key}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="w-20 shrink-0">
                  <span className="block text-sm font-medium text-foreground">{label}</span>
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </div>
                <input
                  type="color"
                  className="h-8 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                  value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : "#000000"}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <Input
                  className="w-32"
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                {/* 即時預覽:直接套用實際渲染時用的同一支函式,商家看到的圖樣效果跟行事曆上
                    一模一樣。 */}
                <span
                  className="ml-auto flex h-8 w-24 shrink-0 items-center justify-center rounded-md border text-[11px] font-medium"
                  style={calendarStateBlockStyle(form, state)}
                >
                  預覽
                </span>
              </div>
            ))}
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
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
