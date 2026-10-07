// SPECS-INDEX #1007(第 14 批,#976 報表回饋,2026-10-07):沒有權限被路由守衛導回功能頁時,跳一則提示。
//
// 背景:只開「店家報表」的客服點「服務人員報表」→ RequireStaffReportAccess 直接 navigate('/app'),
// 畫面上沒有任何訊息,客服會以為是 bug。全站的「沒權限就導回」守衛不是一個共用元件,而是每個功能各一份
// (RequireXxxAccess.tsx,寫法相同),所以這裡只抽「提示」這一小段,讓每一份守衛在導回之前呼叫同一支。
// 主腦補上的決定(可單獨退):所有權限守門頁一起加,不只服務人員報表。
//
// 只在「確實是客服、而且已經選定商家」時提示 —— 還沒選商家、或根本不是這間店的人(理論上進不來)時
// 照舊安靜導回,不講「你沒有權限」這種會誤導的話。
// 用 sonner 的 id 去重:開發模式 StrictMode 會讓 effect 跑兩次,同一個功能只會留一則。

import { toast } from "sonner";

import { AGENT_PERMISSION_SECTIONS } from "./types";

/** 提示文字(全形標點,使用者指定的句型)。 */
export function permissionDeniedMessage(featureLabel: string): string {
  return `你沒有「${featureLabel}」的權限，如需使用請聯絡商家管理員。`;
}

/** 客服權限 key → 客服權限設定頁上顯示的名稱(同一份 AGENT_PERMISSION_SECTIONS,不另寫一份對照表)。 */
export function agentPermissionLabel(sectionKey: string): string {
  return AGENT_PERMISSION_SECTIONS.find((s) => s.key === sectionKey)?.label ?? sectionKey;
}

/** 這次導回要不要跳提示:有選定商家、而且身分是客服(管理員永遠放行;其他身分照舊安靜導回)。 */
export function shouldNotifyPermissionDenied(input: {
  hasMerchant: boolean;
  role: string | null | undefined;
}): boolean {
  return input.hasMerchant && input.role === "agent";
}

/** 跳「你沒有「X」的權限」提示。toast 會跨頁面保留,所以在 navigate 之前或之後呼叫都看得到。 */
export function notifyPermissionDenied(featureLabel: string): void {
  toast.error(permissionDeniedMessage(featureLabel), { id: `permission-denied:${featureLabel}` });
}
