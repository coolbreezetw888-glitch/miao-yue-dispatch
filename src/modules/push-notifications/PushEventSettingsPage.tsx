// 模組 15(服務人員推播通知)§7.9:推播事件設定頁(新路由 /app/push-events)。
// 4 張卡片(對應 4 種事件),每張有「開關 + 標題 + 內文」欄位(對應規則 4.4,沒有通知對象
// 勾選——通知對象永遠是這筆訂單指定的服務人員本人)+ §13.1(SPECS-INDEX #586)補上的
// 「可用變數說明 + 即時預覽」,複用模組 11 §4.2/§385/§10.1 既有的 TemplateVariablePreview
// 共用元件,標題/內文分開兩段預覽(對應 §13.1 邊界情況,推播內文比 LINE 訊息更寸土寸金)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
// §13.1 明講「直接複用該檔案已經做好的同一套元件/邏輯」——這是模組 15 對模組 11 的 UI 呈現層
// 依賴(見 `.project/specs/服務人員推播通知.md` §8.3/§13.1),不重寫第三份幾乎相同的 JSX。
import { TemplateVariablePreview } from "@/modules/line-notifications/TemplateVariablePreview";

import { updatePushEventSetting, useMerchantPushEventSettings } from "./api";
import { RequirePushNotificationAccess } from "./RequirePushNotificationAccess";
import { getPushTemplateVariableDefinitions, previewPushTemplate } from "./templateVariables";
import {
  PUSH_NOTIFICATION_EVENT_LABELS,
  PUSH_NOTIFICATION_EVENT_TYPES,
  type MerchantPushEventSetting,
  type PushNotificationEventType,
} from "./types";

interface EventFormState {
  enabled: boolean;
  messageTitle: string;
  messageBody: string;
}

function settingToFormState(setting: MerchantPushEventSetting): EventFormState {
  return {
    enabled: setting.enabled,
    messageTitle: setting.message_title,
    messageBody: setting.message_body,
  };
}

function EventSettingCard({
  merchantId,
  eventType,
  setting,
  onSaved,
}: {
  merchantId: string;
  eventType: PushNotificationEventType;
  setting: MerchantPushEventSetting;
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
      await updatePushEventSetting({
        merchantId,
        eventType,
        enabled: form.enabled,
        messageTitle: form.messageTitle,
        messageBody: form.messageBody,
      });
      toast.success("已儲存推播設定");
      onSaved();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid={`push-event-card-${eventType}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{PUSH_NOTIFICATION_EVENT_LABELS[eventType]}</CardTitle>
          <CardDescription>{form.enabled ? "推播已開啟" : "推播目前關閉"}</CardDescription>
        </div>
        <Switch checked={form.enabled} onCheckedChange={(v) => setField("enabled", v)} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1 text-sm font-medium text-foreground">通知標題</p>
          <Input
            value={form.messageTitle}
            onChange={(e) => setField("messageTitle", e.target.value)}
            maxLength={40}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            建議 20 字以內({form.messageTitle.length} 字)——手機通知顯示空間有限,超出的部分會被系統截斷。
          </p>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-foreground">通知內文</p>
          <Textarea
            rows={2}
            value={form.messageBody}
            onChange={(e) => setField("messageBody", e.target.value)}
            maxLength={120}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            建議 50 字以內({form.messageBody.length} 字)——手機通知列空間有限,超出的部分會被系統截斷。
          </p>
          <TemplateVariablePreview
            variables={getPushTemplateVariableDefinitions(eventType)}
            previews={[
              { label: "標題", text: previewPushTemplate(form.messageTitle) },
              { label: "內文", text: previewPushTemplate(form.messageBody) },
            ]}
          />
        </div>

        <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
          {saving ? "儲存中⋯" : "儲存"}
        </Button>
      </CardContent>
    </Card>
  );
}

function PushEventSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useMerchantPushEventSettings(merchantId);

  function refetch() {
    return queryClient.invalidateQueries({
      queryKey: ["push-notifications-module", "event-settings", merchantId],
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">推播通知設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          設定服務人員的手機/瀏覽器推播通知要不要開啟、文案內容。通知對象固定是這筆訂單指定的服務
          人員本人,不會通知管理員/客服/會員。服務人員需要自己在個人頁面開啟通知(這裡只控制要不要
          發送)。
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : (
        <div className="space-y-4">
          {PUSH_NOTIFICATION_EVENT_TYPES.map((eventType) => {
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

export default function PushEventSettingsPage() {
  return (
    <RequirePushNotificationAccess>
      <PushEventSettingsPageInner />
    </RequirePushNotificationAccess>
  );
}
