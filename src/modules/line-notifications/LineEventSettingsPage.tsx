// 模組 11(LINE 通知)§4.2:通知事件設定頁(新路由 /app/line-events)。
// 5 張卡片(對應 5 種事件),每張顯示:白話名稱、總開關、通知對象勾選(staff_leave_created
// 隱藏服務人員/會員兩個選項,對應 1.2 邊界情況)、文案範本編輯區 + 「可用變數」說明清單 +
// 即時預覽(純前端函式,判斷 11)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import { updateLineEventSetting, useMerchantLineEventSettings } from "./api";
import { RequireLineNotificationAccess } from "./RequireLineNotificationAccess";
import { TemplateVariablePreview } from "./TemplateVariablePreview";
import {
  LINE_NOTIFICATION_EVENT_LABELS,
  LINE_NOTIFICATION_EVENT_TYPES,
  eventSupportsMemberTarget,
  eventSupportsStaffTarget,
  type LineNotificationEventType,
  type MerchantLineEventSetting,
} from "./types";
import { getTemplateVariableDefinitions, previewLineMessageTemplate } from "./templateVariables";

interface EventFormState {
  enabled: boolean;
  notifyAdmin: boolean;
  notifyAgent: boolean;
  notifyStaff: boolean;
  notifyMember: boolean;
  messageTemplate: string;
}

function settingToFormState(setting: MerchantLineEventSetting): EventFormState {
  return {
    enabled: setting.enabled,
    notifyAdmin: setting.notify_admin,
    notifyAgent: setting.notify_agent,
    notifyStaff: setting.notify_staff,
    notifyMember: setting.notify_member,
    messageTemplate: setting.message_template,
  };
}

function EventSettingCard({
  merchantId,
  eventType,
  setting,
  onSaved,
}: {
  merchantId: string;
  eventType: LineNotificationEventType;
  setting: MerchantLineEventSetting;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EventFormState>(settingToFormState(setting));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(settingToFormState(setting));
  }, [setting]);

  function setField<K extends keyof EventFormState>(key: K, value: EventFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateLineEventSetting({
        merchantId,
        eventType,
        enabled: form.enabled,
        notifyAdmin: form.notifyAdmin,
        notifyAgent: form.notifyAgent,
        notifyStaff: form.notifyStaff,
        notifyMember: form.notifyMember,
        messageTemplate: form.messageTemplate,
      });
      toast.success("已儲存通知設定");
      onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const showStaffOption = eventSupportsStaffTarget(eventType);
  const showMemberOption = eventSupportsMemberTarget(eventType);

  return (
    <Card data-testid={`line-event-card-${eventType}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{LINE_NOTIFICATION_EVENT_LABELS[eventType]}</CardTitle>
          <CardDescription>{form.enabled ? "通知已開啟" : "通知目前關閉"}</CardDescription>
        </div>
        <Switch checked={form.enabled} onCheckedChange={(v) => setField("enabled", v)} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-foreground">通知對象</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.notifyAdmin}
                onCheckedChange={(v) => setField("notifyAdmin", v === true)}
              />
              商家管理員
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={form.notifyAgent}
                onCheckedChange={(v) => setField("notifyAgent", v === true)}
              />
              客服
            </label>
            {showStaffOption ? (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.notifyStaff}
                  onCheckedChange={(v) => setField("notifyStaff", v === true)}
                />
                服務人員
              </label>
            ) : null}
            {showMemberOption ? (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.notifyMember}
                  onCheckedChange={(v) => setField("notifyMember", v === true)}
                />
                會員
              </label>
            ) : null}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">文案範本</p>
          <Textarea
            rows={3}
            value={form.messageTemplate}
            onChange={(e) => setField("messageTemplate", e.target.value)}
          />
          <TemplateVariablePreview
            variables={getTemplateVariableDefinitions(eventType)}
            previews={[{ text: previewLineMessageTemplate(form.messageTemplate) }]}
          />
        </div>

        <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
          {saving ? "儲存中⋯" : "儲存"}
        </Button>
      </CardContent>
    </Card>
  );
}

function LineEventSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useMerchantLineEventSettings(merchantId);

  function refetch() {
    return queryClient.invalidateQueries({
      queryKey: ["line-notifications-module", "event-settings", merchantId],
    });
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">LINE 通知設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          設定每一類事件要不要透過 LINE 通知、通知誰、文案內容。
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : (
        <div className="space-y-4">
          {LINE_NOTIFICATION_EVENT_TYPES.map((eventType) => {
            const setting = settings?.find((s) => s.event_type === eventType);
            if (!setting) return null;
            return (
              <EventSettingCard
                key={eventType}
                merchantId={merchantId}
                eventType={eventType}
                setting={setting}
                onSaved={refetch}
              />
            );
          })}
        </div>
      )}
    </main>
  );
}

export default function LineEventSettingsPage() {
  return (
    <RequireLineNotificationAccess>
      <LineEventSettingsPageInner />
    </RequireLineNotificationAccess>
  );
}
