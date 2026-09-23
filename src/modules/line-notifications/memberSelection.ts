// 模組 11(LINE 通知)§10.2(SPECS-INDEX #612):行銷通知會員選擇擴充——依會員分類批量選擇/
// 排除清單。純函式抽出來方便 Vitest 直接測試,不用整個渲染 LineMarketingPage.tsx。
//
// ⚠️ 待確認事項(§10.2 規格書最後一段/SPECS-INDEX #612 備註,`engineer` 動工前已查證這個問題
// 目前仍是「待確認」狀態,規格書原文明講「不要自行假設答案」):黑名單會員被單獨選擇或依分類
// 批量選中時,最終送出名單依然自動排除——但「商家能不能在排除清單裡手動把這位黑名單會員從排除
// 清單移除,讓他還是收到訊息」這件事沒有定案。**這次的實作沒有做這個手動取消排除的機制**:
// 黑名單會員永遠自動排除、UI 上是唯讀顯示(不能勾選移除),不提供任何管道讓商家繞過黑名單排除。
// 這是為了不要自己選一個方向硬做而選擇的最保守做法(維持黑名單「預設不打擾」的既有精神,寧可
// 少發也不要誤發給黑名單客戶),但這仍然是一個需要主腦/使用者確認的假設,回報時務必提出,不要
// 當作已經定案。

export interface SelectableMember {
  id: string;
  tierId: string | null;
  isBlacklisted: boolean;
}

/** 依分類批量選擇:找出某個等級底下、目前這份「已綁定 LINE 會員」清單裡所有成員的 id。
 * 呼叫端傳進來的 members 本來就已經是只有 line_bound=true 的名單(§4.4/fetchMarketableMembers
 * 既有查詢條件),這裡不用重複檢查 line_bound。 */
export function getTierMemberIds(members: SelectableMember[], tierId: string): string[] {
  return members.filter((m) => m.tierId === tierId).map((m) => m.id);
}

/** 這個等級是否「目前已經整批被選取」——用於批量選擇 checkbox 呈現目前的勾選狀態:等級底下
 * 沒有任何已綁定 LINE 的會員時,一律回傳 false(空等級不算「已選取」)。 */
export function isTierFullySelected(
  members: SelectableMember[],
  tierId: string,
  selectedIds: string[],
): boolean {
  const tierMemberIds = getTierMemberIds(members, tierId);
  if (tierMemberIds.length === 0) return false;
  const selectedSet = new Set(selectedIds);
  return tierMemberIds.every((id) => selectedSet.has(id));
}

/** 切換某個等級的批量選取:勾選時把整批 id 加進 selectedIds(去重),取消勾選時把整批 id 從
 * selectedIds 移除。不影響不屬於這個等級的其他既有選取(例如單獨選擇的其他會員)。 */
export function toggleTierSelection(
  members: SelectableMember[],
  tierId: string,
  selectedIds: string[],
  checked: boolean,
): string[] {
  const tierMemberIds = new Set(getTierMemberIds(members, tierId));
  if (checked) {
    const merged = new Set(selectedIds);
    tierMemberIds.forEach((id) => merged.add(id));
    return Array.from(merged);
  }
  return selectedIds.filter((id) => !tierMemberIds.has(id));
}

/** §10.2 核心規則:最終送出名單 = 選取名單(單獨選擇 ∪ 依分類批量選擇)扣掉手動排除清單、
 * 再扣掉黑名單會員(黑名單預設自動排除,見檔案開頭「待確認事項」說明——這次不提供手動取消排除
 * 黑名單會員的機制,黑名單會員永遠不會出現在最終送出名單裡,不管有沒有被手動排除清單勾選過,
 * 也不管是不是被單獨選擇/批量選擇選中過)。 */
export function computeFinalRecipientIds(
  members: SelectableMember[],
  selectedIds: string[],
  manuallyExcludedIds: string[],
): string[] {
  const excludedSet = new Set(manuallyExcludedIds);
  const blacklistedSet = new Set(members.filter((m) => m.isBlacklisted).map((m) => m.id));
  return selectedIds.filter((id) => !excludedSet.has(id) && !blacklistedSet.has(id));
}
