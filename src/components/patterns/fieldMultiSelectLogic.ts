// 多選下拉 FieldMultiSelect 的純函式(第 11 批 G,#994,2026-10-07)。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §14.5 G-5、G-9。
// 畫面在 FieldMultiSelect.tsx;這裡只放「外框摘要文字」與「搜尋過濾」,方便 vitest 逐字核對。

export interface FieldMultiSelectOption {
  value: string;
  /** 名稱(清單第一行、摘要裡的名稱) */
  label: string;
  /** 清單第二行淡字(例:`分類 ・ $價格`)。已下架的列會改成固定提醒文字。 */
  detail?: string | undefined;
  /** 搜尋時額外比對的文字(例:分類名稱)。不顯示。 */
  keywords?: string | undefined;
  /** 已下架但仍綁著:排在清單最後、「已下架」分隔標題下、半透明;摘要名稱後加 `(已下架)`。 */
  removed?: boolean | undefined;
}

/** 已下架列的第二行淡字(G-8)。 */
export const MULTI_SELECT_REMOVED_DETAIL = "已下架，取消勾選後就不能再選回來";
/** 已下架分隔標題(G-8)。 */
export const MULTI_SELECT_REMOVED_HEADING = "已下架";
/** 搜尋沒有結果(G-9)。 */
export const MULTI_SELECT_NO_RESULT = "找不到符合的服務項目";

/**
 * G-5:外框摘要。0 項 ⇒ null(呼叫端顯示灰字 placeholder);
 * 1 項以上 ⇒ `已選 N 項：名稱A、名稱B`(名稱照 options 順序,全形「、」;已下架的名稱後面加 `(已下架)`)。
 * N = 「已選」且在 options 裡的項目數(跟後面列出的名稱一致)。
 */
export function formatMultiSelectSummary(
  options: readonly FieldMultiSelectOption[],
  selected: ReadonlySet<string>,
): string | null {
  const names = options
    .filter((o) => selected.has(o.value))
    .map((o) => (o.removed ? `${o.label}(已下架)` : o.label));
  if (names.length === 0) return null;
  return `已選 ${names.length} 項：${names.join("、")}`;
}

/** 已選且在 options 裡的項目數(清單底部「已選 N 項」用)。 */
export function countSelectedOptions(
  options: readonly FieldMultiSelectOption[],
  selected: ReadonlySet<string>,
): number {
  return options.filter((o) => selected.has(o.value)).length;
}

/**
 * G-9:搜尋。比對名稱與 keywords(分類名稱),忽略大小寫與前後空白;空字串 ⇒ 全部。
 * 只影響顯示,不影響已選;順序不變。
 */
export function filterMultiSelectOptions(
  options: readonly FieldMultiSelectOption[],
  query: string,
): FieldMultiSelectOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...options];
  return options.filter((o) =>
    [o.label, o.keywords ?? ""].some((text) => text.toLowerCase().includes(q)),
  );
}
