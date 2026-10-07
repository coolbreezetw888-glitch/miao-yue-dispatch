/**
 * 多選下拉(第 11 批 G,#994,2026-10-07)—— ui-overlay-patterns skill 二之七的使用者指定例外。
 *
 * 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §14.5 G-4~G-15。目前只用在
 * 「編輯服務人員 → 服務項目」:外框看起來跟 FieldSelect 一樣(44px、10px 圓角、手機 16px / 桌機 15px、右側 ▾),
 * 寫已選摘要;點開是勾選清單,**點一列就呼叫 onToggle(呼叫端立刻寫入)、清單不自動關**。
 *
 *   - G-10 刻意**沒有**全選 / 清除全部:每勾一項就是一次寫入,全選 = 一次打幾十支 API,中途失敗會留下一半。
 *   - G-12 Esc 只關清單:Radix 的層級是「最上層先吃 Esc」,在全頁層(Dialog)裡打開清單時,Esc 只關清單。
 *   - G-13 彈出方式照 skill 三之五「全頁層裡的 Popover」:`<Popover modal>`(不然捲動被全頁層的捲動鎖吃掉),
 *     **捲動放在內層**(modal Popover 的捲動鎖以 PopoverContent 為根,根節點自己捲會被擋)。
 *   - G-9 不自動聚焦搜尋框(手機會彈鍵盤蓋住清單);焦點放第一個已勾選的列,沒有就第一列。
 *
 * ⚠️ 這裡改動會影響之後所有用到多選下拉的地方,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 */

import * as React from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  countSelectedOptions,
  filterMultiSelectOptions,
  formatMultiSelectSummary,
  MULTI_SELECT_NO_RESULT,
  MULTI_SELECT_REMOVED_DETAIL,
  MULTI_SELECT_REMOVED_HEADING,
  type FieldMultiSelectOption,
} from "./fieldMultiSelectLogic";

export type { FieldMultiSelectOption } from "./fieldMultiSelectLogic";

export interface FieldMultiSelectProps {
  id: string;
  "aria-labelledby"?: string | undefined;
  "aria-label"?: string | undefined;
  /** 上架中的在前、已下架但綁著的(removed)在後 —— 呼叫端排好。 */
  options: readonly FieldMultiSelectOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string, next: boolean) => void | Promise<void>;
  /** 正在寫入中的列:aria-disabled + 小轉圈,不能重複點。 */
  busyValues?: ReadonlySet<string> | undefined;
  /** 沒選任何一項時外框的灰字。 */
  placeholder: string;
  /** 清單總列數超過這個數字才出現搜尋框(預設 8)。 */
  searchThreshold?: number | undefined;
  /** 搜尋框灰字(預設「搜尋服務項目」)。 */
  searchPlaceholder?: string | undefined;
  testIdPrefix?: string | undefined;
}

/** 外框:跟 FieldSelect(FIELD_CONTROL_CLASS + SelectTrigger)同高同圓角同字級。 */
const TRIGGER_CLASS =
  "flex h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-[16px] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-[15px]";

export function FieldMultiSelect({
  id,
  "aria-labelledby": ariaLabelledBy,
  "aria-label": ariaLabel,
  options,
  selected,
  onToggle,
  busyValues,
  placeholder,
  searchThreshold = 8,
  searchPlaceholder = "搜尋服務項目",
  testIdPrefix = "multi-select",
}: FieldMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);

  const summary = formatMultiSelectSummary(options, selected);
  const selectedCount = countSelectedOptions(options, selected);
  const showSearch = options.length > searchThreshold;
  const visible = showSearch ? filterMultiSelectOptions(options, query) : [...options];
  const visibleActive = visible.filter((o) => !o.removed);
  const visibleRemoved = visible.filter((o) => o.removed);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function renderRow(option: FieldMultiSelectOption) {
    const checked = selected.has(option.value);
    const busy = busyValues?.has(option.value) ?? false;
    return (
      <button
        key={option.value}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={busy || undefined}
        data-testid={`${testIdPrefix}-option-${option.value}`}
        onClick={() => {
          if (busy) return;
          void onToggle(option.value, !checked);
        }}
        className={cn(
          "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          option.removed && "opacity-60",
          busy && "cursor-wait",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
            checked ? "border-brand bg-brand text-brand-foreground" : "border-border",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : checked ? (
            <Check className="h-4 w-4" strokeWidth={3} />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words text-[15px] font-medium text-foreground">
            {option.label}
          </span>
          {option.removed ? (
            <span className="text-xs text-muted-foreground">{MULTI_SELECT_REMOVED_DETAIL}</span>
          ) : option.detail ? (
            <span className="break-words text-xs text-muted-foreground">{option.detail}</span>
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={ariaLabelledBy}
          aria-label={ariaLabel}
          data-testid={`${testIdPrefix}-trigger`}
          className={TRIGGER_CLASS}
        >
          <span
            className={cn("min-w-0 flex-1 truncate", summary ? "" : "text-muted-foreground")}
            data-testid={`${testIdPrefix}-summary`}
          >
            {summary ?? placeholder}
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        data-testid={`${testIdPrefix}-content`}
        data-pull-to-refresh="off"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onOpenAutoFocus={(event) => {
          // G-9:不聚焦搜尋框(手機會彈鍵盤);焦點放第一個已勾選的列,沒有就第一列。
          event.preventDefault();
          const list = listRef.current;
          const target =
            list?.querySelector<HTMLElement>('[role="checkbox"][aria-checked="true"]') ??
            list?.querySelector<HTMLElement>('[role="checkbox"]');
          target?.focus({ preventScroll: false });
        }}
      >
        {/* 🔴 捲動放在內層(skill 三之五):高度上限 = Radix 算好的可用高度,搜尋框與底部列固定、只有清單捲。 */}
        <div className="flex max-h-[var(--radix-popover-content-available-height)] flex-col">
          {showSearch ? (
            <div className="shrink-0 border-b border-border p-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                data-testid={`${testIdPrefix}-search`}
                className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[16px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-[15px]"
              />
            </div>
          ) : null}
          <div
            ref={listRef}
            role="group"
            aria-labelledby={ariaLabelledBy}
            aria-label={ariaLabel}
            data-testid={`${testIdPrefix}-list`}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {visible.length === 0 ? (
              <p
                className="px-3 py-4 text-center text-sm text-muted-foreground"
                data-testid={`${testIdPrefix}-empty`}
              >
                {MULTI_SELECT_NO_RESULT}
              </p>
            ) : null}
            {visibleActive.map(renderRow)}
            {visibleRemoved.length > 0 ? (
              <>
                <p
                  className="px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground"
                  data-testid={`${testIdPrefix}-removed-heading`}
                >
                  {MULTI_SELECT_REMOVED_HEADING}
                </p>
                {visibleRemoved.map(renderRow)}
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2">
            <span
              className="text-sm tabular-nums text-muted-foreground"
              data-testid={`${testIdPrefix}-count`}
            >
              已選 {selectedCount} 項
            </span>
            {/* skill:面板內不放實心主題色按鈕 ⇒ neutral。 */}
            <Button
              type="button"
              variant="neutral"
              size="card"
              data-testid={`${testIdPrefix}-done`}
              onClick={() => handleOpenChange(false)}
            >
              完成
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
