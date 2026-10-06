// SPECS-INDEX #873:移除協助人員後擋流程提示的純邏輯(文案、編輯表單要不要跳提示)。
// 元件在 assistantRemoval.tsx;拆開是為了 react-refresh(元件檔只匯出元件)。
export interface AssistantRemovedInfo {
  bookingId: string;
  /** 被移除的協助人員姓名(編輯表單一次可以拿掉好幾位)。 */
  assistantNames: string[];
  primaryName: string;
}

export const ASSISTANT_REMOVED_TITLE = "已移除協助人員";
export const ASSISTANT_REMOVED_KEEP_LABEL = "維持現狀";
export const ASSISTANT_REMOVED_ADD_LABEL = "再加助手";

/** 規格書一-2 主腦定稿文案。 */
export function buildAssistantRemovedMessage(info: AssistantRemovedInfo): string {
  const names = info.assistantNames.length > 0 ? info.assistantNames.join("、") : "協助人員";
  return `${names} 已從這張訂單移除，主服務人員 ${info.primaryName} 的訂單維持不變。要再加一位協助人員嗎？`;
}

/**
 * 路徑 (b):編輯表單儲存成功後,要不要跳提示。
 * 有人被拿掉、而且這次沒有加任何新的人 ⇒ 回傳提示內容;否則 null。
 */
export function assistantRemovedInfoAfterEdit(params: {
  bookingId: string;
  originalAssistants: { staffId: string; staffName: string }[];
  nextAssistantStaffIds: string[];
  primaryName: string;
}): AssistantRemovedInfo | null {
  const { bookingId, originalAssistants, nextAssistantStaffIds, primaryName } = params;
  const originalIds = new Set(originalAssistants.map((a) => a.staffId));
  const removed = originalAssistants.filter((a) => !nextAssistantStaffIds.includes(a.staffId));
  const added = nextAssistantStaffIds.filter((id) => !originalIds.has(id));
  if (removed.length === 0 || added.length > 0) return null;
  return { bookingId, assistantNames: removed.map((a) => a.staffName), primaryName };
}
