// 模組 11(LINE 通知)§4.2:通知事件設定頁(新路由 /app/line-events)。
// 5 張卡片(對應 5 種事件),每張顯示:白話名稱、總開關、通知對象勾選(staff_leave_created
// 隱藏服務人員/會員兩個選項,對應 1.2 邊界情況)、文案範本編輯區 + 「可用變數」說明清單 +
// 即時預覽(純前端函式,判斷 11)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader(‹ 返回功能 → 標題 → 說明);載入中改灰色骨架,不用「載入中⋯」(二之八)。
//   - 每張卡的總開關改 SwitchRow(二之七「開關做成一整列」),卡片標題不再跟開關擠在同一列。
//   - 「通知對象」從打勾方框改成可點的方塊 ChoiceChip(二之七:手機好按)—— 通知對象可以同時
//     選好幾個,所以是 ChoiceChip(aria-pressed 多選語意),不是 ChoiceChipGroup(單選)。
//   - 「文案範本」改 FormField + FieldTextarea;「可用變數」改成 skill 二之七指定的三欄說明表
//     + 「○○○實際會收到」預覽框(做在共用元件 TemplateVariablePreview 裡)。
//   - 儲存按鈕改 ② 次要(neutral):這一頁有 5 張一模一樣的事件卡,每張都放一顆主要按鈕等於
//     一頁 5 顆 primary,違反 skill 二之三「一個畫面只能有一顆」,而且整頁都是主題色實心按鈕時
//     反而沒有任何一顆突出(跟 #846 黃卡「全部都黃 = 都不黃」是同一個道理)。
//
// **只動外觀,不動行為**:儲存送出的欄位、事件類型清單、哪些事件隱藏服務人員/會員選項、
// toast 文案全部照舊。
//
// 客戶端第 5 批 5-A(C5-K01 / K02):
//   - 最上方新增「通知客人」卡(CustomerLineSettingsCard.tsx);下面 5 張是「通知店家這邊」的事件。
//   - 5 種事件不再顯示「會員」勾選(Q6:客人通知一律走「通知客人」設定,避免重複發)。
//     notify_member 欄位不刪,儲存時照原值送回(不影響既有資料,日後體檢再清)。

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ChoiceChip,
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

import { updateLineEventSetting, useMerchantLineEventSettings } from "./api";
import { RequireLineNotificationAccess } from "./RequireLineNotificationAccess";
import { TemplateVariablePreview } from "./TemplateVariablePreview";
import { CustomerLineSettingsCard } from "./CustomerLineSettingsCard";
import { CUSTOMER_SETTINGS_POINTER } from "./customerLineSettingsLogic";
import {
  LINE_NOTIFICATION_EVENT_LABELS,
  LINE_NOTIFICATION_EVENT_TYPES,
  eventSupportsStaffTarget,
  type LineNotificationEventType,
  type MerchantLineEventSetting,
} from "./types";
import {
  getTemplateVariableDefinitions,
  LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES,
  previewLineMessageTemplate,
} from "./templateVariables";

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
  const templateFieldId = `line-event-template-${eventType}`;

  // 通知對象可以同時選好幾個 ⇒ ChoiceChip(多選,aria-pressed),不是 ChoiceChipGroup(單選)。
  // staff_leave_created 沒有服務人員這個對象(§1.2 邊界情況),清單就不放那顆。
  // C5-K01:「會員」不再出現(客人通知改由上方「通知客人」卡設定)。
  type TargetKey = "notifyAdmin" | "notifyAgent" | "notifyStaff";
  const targetOptions: { key: TargetKey; label: string }[] = [
    { key: "notifyAdmin", label: "商家管理員" },
    { key: "notifyAgent", label: "客服" },
    ...(showStaffOption ? [{ key: "notifyStaff" as const, label: "服務人員" }] : []),
  ];

  return (
    <Card data-testid={`line-event-card-${eventType}`}>
      <CardContent className="flex flex-col gap-4 pt-6">
        {/* skill 二之七:開關做成一整列 —— 左邊標題 + 一行說明,右邊開關。 */}
        <SwitchRow
          title={LINE_NOTIFICATION_EVENT_LABELS[eventType]}
          description={
            form.enabled
              ? "通知已開啟，符合條件時會依下方設定發送 LINE 訊息。"
              : "通知目前關閉，這類事件不會發出任何 LINE 訊息。"
          }
          checked={form.enabled}
          onCheckedChange={(v) => setField("enabled", v)}
        />

        <FormField
          label="通知對象"
          help={
            <>
              勾選這類事件發生時要通知誰。<strong>只有已經綁定 LINE 的人收得到</strong>
              ，沒綁定的人會被安靜略過，不會報錯。
            </>
          }
          helpLabel="說明：通知對象怎麼選、沒綁定 LINE 的人會怎樣"
        >
          <div className="flex flex-wrap gap-2">
            {targetOptions.map((option) => (
              <ChoiceChip
                key={option.key}
                selected={form[option.key]}
                onClick={() => setField(option.key, !form[option.key])}
              >
                {option.label}
              </ChoiceChip>
            ))}
          </div>
        </FormField>

        <FormField label="文案範本" htmlFor={templateFieldId}>
          <FieldTextarea
            id={templateFieldId}
            rows={3}
            value={form.messageTemplate}
            onChange={(e) => setField("messageTemplate", e.target.value)}
          />
        </FormField>
        {/* skill 二之七:變數說明要完整(三欄:變數 / 中文意思 / 範例值)+ 預覽框。 */}
        <TemplateVariablePreview
          variables={getTemplateVariableDefinitions(eventType)}
          sampleValues={LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES}
          recipientLabel="收到通知的人"
          previews={[{ text: previewLineMessageTemplate(form.messageTemplate) }]}
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
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="LINE 通知設定"
        description="設定每一類事件要不要透過 LINE 通知、通知誰、文案內容。"
      />

      <CustomerLineSettingsCard
        merchantId={merchantId}
        merchantName={merchant!.name}
        merchantPhone={merchant!.phone}
        bookingSlug={merchant!.booking_slug}
        isOnSite={merchant!.industry_type === "on_site_dispatch"}
      />

      <div>
        <h2 className="text-base font-bold text-foreground">通知店家這邊</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          {CUSTOMER_SETTINGS_POINTER}
        </p>
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
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
