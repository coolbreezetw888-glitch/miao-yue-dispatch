// 模組 15(服務人員推播通知)§7.9:推播事件設定頁(新路由 /app/push-events)。
// 4 張卡片(對應 4 種事件),每張有「開關 + 標題 + 內文」欄位(對應規則 4.4,沒有通知對象
// 勾選——通知對象永遠是這筆訂單指定的服務人員本人)+ §13.1(SPECS-INDEX #586)補上的
// 「可用變數說明 + 即時預覽」,複用模組 11 §4.2/§385/§10.1 既有的 TemplateVariablePreview
// 共用元件,標題/內文分開兩段預覽(對應 §13.1 邊界情況,推播內文比 LINE 訊息更寸土寸金)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill,做法與 LINE 通知事件設定頁
// (LineEventSettingsPage)刻意一致 —— 兩頁長得一樣、使用者的心智模型才一樣。
//   - 頁首改 PageHeader;載入中改灰色骨架(二之八)。
//   - 每張卡的總開關改 SwitchRow(二之七)。
//   - 標題 / 內文改 FormField + FieldInput / FieldTextarea;「建議 N 字以內」原本混在同一行
//     小字裡,現在字數改用 FormField 的 counter(右上角 `12 / 40`),建議字數與「超出會被截斷」
//     的理由收進 `?`(二之七 + 二)。
//   - 「可用變數」改成三欄說明表 + 「服務人員實際會收到」預覽框(二之七,做在共用元件裡)。
//   - 儲存按鈕改 ② 次要:一頁 4 張一樣的事件卡,每張放一顆 primary 等於一頁 4 顆主要按鈕,
//     違反二之三「一個畫面只能有一顆」。
//
// **只動外觀,不動行為**:儲存送出的欄位、maxLength(標題 40 / 內文 120)、事件清單、
// toast 文案、data-testid 全部照舊。

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  FieldInput,
  FieldTextarea,
  FormField,
  LoadingSkeleton,
  PageHeader,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
// §13.1 明講「直接複用該檔案已經做好的同一套元件/邏輯」——這是模組 15 對模組 11 的 UI 呈現層
// 依賴(見 `.project/specs/服務人員推播通知.md` §8.3/§13.1),不重寫第三份幾乎相同的 JSX。
import { TemplateVariablePreview } from "@/modules/line-notifications/TemplateVariablePreview";

import { updatePushEventSetting, useMerchantPushEventSettings } from "./api";
import { RequirePushNotificationAccess } from "./RequirePushNotificationAccess";
import {
  getPushTemplateVariableDefinitions,
  previewPushTemplate,
  PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES,
} from "./templateVariables";
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

  const titleFieldId = `push-event-title-${eventType}`;
  const bodyFieldId = `push-event-body-${eventType}`;

  return (
    <Card data-testid={`push-event-card-${eventType}`}>
      <CardContent className="flex flex-col gap-4 pt-6">
        {/* skill 二之七:開關做成一整列 —— 左邊標題 + 一行說明,右邊開關。 */}
        <SwitchRow
          title={PUSH_NOTIFICATION_EVENT_LABELS[eventType]}
          description={
            form.enabled
              ? "推播已開啟,符合條件時會推播給這筆訂單指定的服務人員。"
              : "推播目前關閉,這類事件不會發出任何推播。"
          }
          checked={form.enabled}
          onCheckedChange={(v) => setField("enabled", v)}
        />

        <FormField
          label="通知標題"
          htmlFor={titleFieldId}
          counter={{ value: form.messageTitle.length, max: 40 }}
          help="建議 20 字以內。手機的通知列顯示空間有限,超出的部分會被系統自己截掉,寫再多對方也看不到。"
          helpLabel="說明:通知標題建議寫多長"
        >
          <FieldInput
            id={titleFieldId}
            value={form.messageTitle}
            onChange={(e) => setField("messageTitle", e.target.value)}
            maxLength={40}
          />
        </FormField>

        <FormField
          label="通知內文"
          htmlFor={bodyFieldId}
          counter={{ value: form.messageBody.length, max: 120 }}
          help="建議 50 字以內。手機的通知列空間比標題還少,超出的部分會被系統自己截掉。"
          helpLabel="說明:通知內文建議寫多長"
        >
          <FieldTextarea
            id={bodyFieldId}
            rows={2}
            value={form.messageBody}
            onChange={(e) => setField("messageBody", e.target.value)}
            maxLength={120}
          />
        </FormField>

        {/* skill 二之七:變數說明要完整(三欄:變數 / 中文意思 / 範例值)+ 預覽框。
            標題與內文分開兩段預覽(§13.1 邊界情況)。 */}
        <TemplateVariablePreview
          variables={getPushTemplateVariableDefinitions(eventType)}
          sampleValues={PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES}
          recipientLabel="服務人員"
          previews={[
            { label: "標題", text: previewPushTemplate(form.messageTitle) },
            { label: "內文", text: previewPushTemplate(form.messageBody) },
          ]}
        />

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
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="推播通知設定"
        description="設定每一類事件要不要發推播，以及文案內容。商家管理員、客服、服務人員都要在自己的手機或瀏覽器開啟通知才收得到。"
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
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
