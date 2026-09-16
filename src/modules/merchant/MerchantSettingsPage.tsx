// 對應規格書 4.2(商家設定頁)、4.3(唯讀管理員清單)、4.7(主題色系)、4.8(公告開關與內容)。
//
// 2026-09-16 主腦複查補上的既有缺口:這個頁面從模組 1 上線以來就沒有套用任何路由守衛
// (後台導覽外殼重構時才被發現——當時「功能」分頁籤的卡片本身已經只對 isAdmin 顯示這個入口,
// 但直接輸入網址 `/app/settings` 深層連結不受影響)。這次比照 `StaffListPage.tsx`/
// `AgentListPage.tsx`/`AgentPermissionsPage.tsx` 既有用法,直接用專案既有的
// `RequireMerchantAdmin`(見 `src/modules/staff-agent/RequireMerchantAdmin.tsx`)把整個頁面包起來,
// 不重新設計判斷邏輯——非管理員(含客服、或還沒選定商家)一律導回 `/app`,不顯示這個頁面存在。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { updateMerchantSettings, uploadMerchantLogo } from "./api";
import { useCurrentMerchant, useRefetchAccessibleMerchants } from "./context";
import { LogoUploader } from "./LogoUploader";
import { MerchantAdminList } from "./MerchantAdminList";
import { ThemePresetPicker } from "./ThemePresetPicker";
import { INDUSTRY_TYPE_LABELS } from "./types";
import type { IndustryType } from "./types";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

function MerchantSettingsPageInner() {
  const { merchant, isLoading } = useCurrentMerchant();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
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
    setAddress(merchant.address ?? "");
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
        address: address || null,
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
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
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

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>基本資料</CardTitle>
            <CardDescription>LOGO、店名、地址、對外聯絡信箱與簡介</CardDescription>
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
              <Label>產業模組</Label>
              <p className="mt-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                {INDUSTRY_TYPE_LABELS[merchant.industry_type as IndustryType] ??
                  merchant.industry_type}
                <span className="ml-2 text-xs">(建立後無法修改)</span>
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

        <Button type="submit" variant="cta" size="lg" className="w-full" disabled={saving}>
          {saving ? "儲存中⋯" : "儲存變更"}
        </Button>
      </form>
    </main>
  );
}

export default function MerchantSettingsPage() {
  return (
    <RequireMerchantAdmin>
      <MerchantSettingsPageInner />
    </RequireMerchantAdmin>
  );
}
