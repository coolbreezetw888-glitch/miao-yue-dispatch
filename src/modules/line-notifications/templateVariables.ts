// 模組 11(LINE 通知)判斷 11:文案範本變數替換,前端(4.2 即時預覽)自己寫一份小型函式,
// 跟 Edge Function(supabase/functions/line-notify-dispatch/index.ts 的 renderMessageTemplate)
// 邏輯完全一致但各自獨立維護(這個專案前端/Edge Function 執行環境不共用程式碼,判斷 11 的既有
// 先例)。找 {{變數名稱}} 換成對應的值,對應不到的變數維持原樣不變動(不報錯,對應規則 2.4
// 「安靜」精神延伸到這裡)。

import type { LineNotificationEventType } from "./types";

/** 3.9 render_booking_notification_variables 實際會組出來的變數名稱,訂單類 4 個事件
 * (booking_created/confirmed/cancelled/completed)的「可用變數」說明清單跟即時預覽都依這份
 * 清單渲染,維持前後端一致。 */
export const LINE_TEMPLATE_VARIABLE_DEFINITIONS: { key: string; label: string }[] = [
  { key: "merchant_name", label: "商家名稱" },
  { key: "customer_name", label: "客戶姓名" },
  { key: "booking_date", label: "預約時間" },
  { key: "service_names", label: "服務項目" },
  { key: "final_amount", label: "訂單金額" },
  { key: "staff_name", label: "服務人員姓名" },
  { key: "member_name", label: "會員姓名" },
  { key: "cancel_reason", label: "取消原因" },
  { key: "points_earned", label: "本次獲得點數" },
];

/** bug fix(SPECS-INDEX 385):render_staff_leave_notification_variables 實際會組出來的變數
 * 名稱。staff_leave_created 事件沒有客戶/訂單金額這些概念,「可用變數」清單不能沿用訂單事件的
 * 清單(列出 {{customer_name}}/{{final_amount}} 只會誤導商家,實際發送時這些變數永遠不會被
 * 替換)。 */
export const LINE_STAFF_LEAVE_TEMPLATE_VARIABLE_DEFINITIONS: { key: string; label: string }[] = [
  { key: "merchant_name", label: "商家名稱" },
  { key: "staff_name", label: "服務人員姓名" },
  { key: "booking_date", label: "請假日期" },
  { key: "leave_type_name", label: "假別名稱" },
];

/** 4.2「可用變數」說明清單依事件類型決定要顯示哪一份清單,避免請假事件顯示出訂單事件才有的
 * 變數。 */
export function getTemplateVariableDefinitions(
  eventType: LineNotificationEventType,
): { key: string; label: string }[] {
  return eventType === "staff_leave_created"
    ? LINE_STAFF_LEAVE_TEMPLATE_VARIABLE_DEFINITIONS
    : LINE_TEMPLATE_VARIABLE_DEFINITIONS;
}

/** 4.2 即時預覽用的範例假資料,套用在文案範本上讓商家看到「大概會長什麼樣子」。涵蓋訂單事件
 * 跟請假事件(bug fix 385:含 leave_type_name)全部變數。 */
export const LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES: Record<string, string> = {
  merchant_name: "示範美甲工作室",
  customer_name: "王小姐",
  booking_date: "2026-10-01 14:30",
  service_names: "手部保養、單色凝膠",
  final_amount: "1500",
  staff_name: "陳美美",
  member_name: "王小姐",
  cancel_reason: "客戶臨時有事",
  points_earned: "15",
  leave_type_name: "特休",
};

/** 判斷 11 的核心純函式:找 {{變數名稱}} 換成 variables 裡對應的值,對應不到的變數維持原樣。 */
export function renderLineMessageTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? match) : match;
  });
}

/** 4.2 即時預覽:套用範例假資料渲染範本。 */
export function previewLineMessageTemplate(template: string): string {
  return renderLineMessageTemplate(template, LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES);
}
