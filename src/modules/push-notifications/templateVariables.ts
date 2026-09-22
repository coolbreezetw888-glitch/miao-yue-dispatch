// 模組 15(服務人員推播通知)§13.1(SPECS-INDEX #586):推播事件設定頁(7.9)的通知標題/內文
// 變數說明 + 即時預覽。UI 呈現複用模組 11(LINE 通知)§4.2/§385 已經做好、§10.1 抽出來的共用
// 元件 `TemplateVariablePreview`(src/modules/line-notifications/TemplateVariablePreview.tsx),
// 這個檔案只負責推播模組自己的「哪個事件有哪些可用變數/範例假資料怎麼渲染」——渲染邏輯刻意
// 不跨模組 import 模組 11 的版本,比照這個專案既有的「前端/Edge Function 之間、甚至 Edge
// Function 彼此之間都各自維護一份小型純函式」慣例(模組 11 templateVariables.ts 開頭/
// supabase/functions/line-send-marketing/index.ts 開頭都有相同說明),只共用「怎麼呈現」的
// UI 元件,不共用「這個範本實際能替換到什麼」的資料定義,避免兩個模組的變數規則被誤綁在一起。

import type { PushNotificationEventType } from "./types";

/** §13.1「本模組可用的變數範圍」:依 §7.6/§7.7 兩支 Edge Function(實際共用
 * supabase/functions/_shared/pushDispatchCore.ts 呼叫 render_booking_notification_variables)
 * 組裝推播內容時真的會用到的欄位為準。雖然 render_booking_notification_variables 實際回傳的
 * 是完整的訂單變數集合(跟模組 11 共用同一支 RPC),但規格書明講「比照 §2.2 表格已列出的 4 種
 * 事件預設文案裡出現的變數」「每種事件類型只列出該事件實際會替換到的變數,不要把 4 種事件全部
 * 變數混在一起列」——推播內文寸土寸金(規則 4.4),不鼓勵商家塞入完整 9 個訂單變數,這裡刻意
 * 只列出各事件預設文案實際用到的那幾個。 */
const PUSH_TEMPLATE_VARIABLE_DEFINITIONS_BY_EVENT: Record<
  PushNotificationEventType,
  { key: string; label: string }[]
> = {
  booking_created: [
    { key: "booking_date", label: "預約時間" },
    { key: "customer_name", label: "客戶姓名" },
    { key: "service_names", label: "服務項目" },
  ],
  booking_cancelled: [
    { key: "booking_date", label: "預約時間" },
    { key: "customer_name", label: "客戶姓名" },
  ],
  booking_updated: [
    { key: "booking_date", label: "預約時間" },
    { key: "customer_name", label: "客戶姓名" },
    { key: "change_summary", label: "異動內容摘要" },
  ],
  booking_reminder_next_day: [
    { key: "booking_date", label: "預約時間" },
    { key: "customer_name", label: "客戶姓名" },
    { key: "service_names", label: "服務項目" },
  ],
};

/** §13.1:依事件類型決定要顯示哪一份「可用變數」清單。 */
export function getPushTemplateVariableDefinitions(
  eventType: PushNotificationEventType,
): { key: string; label: string }[] {
  return PUSH_TEMPLATE_VARIABLE_DEFINITIONS_BY_EVENT[eventType];
}

/** 即時預覽用的範例假資料。booking_date/customer_name/service_names 採用跟模組 11
 * templateVariables.ts 相同的示範值(方便同時檢視兩邊測試/預覽時前後一致),change_summary
 * 是推播模組獨有的變數(規則 4.5:訂單異動時前端算好的一句話摘要,LINE 通知沒有這個變數)。 */
const PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES: Record<string, string> = {
  booking_date: "2026-10-01 14:30",
  customer_name: "王小姐",
  service_names: "手部保養、單色凝膠",
  change_summary: "預約時間從 14:30 改成 15:00",
};

/** 找 {{變數名稱}} 換成 variables 裡對應的值,對應不到的變數維持原樣(規則 2.4/4.3「安靜」
 * 精神延伸到這裡,對應模組 11 renderLineMessageTemplate 的同一套邏輯,這裡各自維護一份)。 */
function renderPushTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? match) : match;
  });
}

/** §13.1 即時預覽:套用範例假資料渲染標題/內文範本。邊界情況要求「標題+內文分開預覽,不是
 * 合併成一大段文字」,呼叫端(PushEventSettingsPage)各自對標題/內文呼叫這支函式一次。 */
export function previewPushTemplate(template: string): string {
  return renderPushTemplate(template, PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES);
}
