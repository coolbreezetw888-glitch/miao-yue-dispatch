/**
 * 表單欄位 —— ui-overlay-patterns skill 二之七。
 *
 *   - 高度一律 44px、圓角 10px(rounded-md)、標籤在欄位上方(13px 粗體)
 *   - 必填用紅色 `*`,不要寫「(必填)」佔位置
 *   - 錯誤:框變紅 **+ 下面一行 `!` 說明**。🔴 不要只把框變紅
 *   - 數字 tabular-nums,金額靠右並在左側放 `$`(FieldAmountInput)
 *   - 有字數上限的欄位,右上角顯示 `34 / 1000`(counter)
 *   - 下拉選單(FieldSelect = shadcn/Radix Select 的統一樣式版)跟輸入框同高同圓角同字級,
 *     頁面不用再自己在 SelectTrigger 上寫 className 調樣式
 *   - 原生控制項(FieldNativeSelect / FieldTime / FieldDate)同上;用在時間、日期這種原生控制項
 *     在手機上體驗比較好的欄位,或跟時間欄位排在同一列的短下拉
 *   - 多選用可點的方塊(ChoiceChip,選中 = 主題色框 + 勾),不用打勾方框(手機好按)
 *   - 🔴 **單選**(類型、計酬類型、扣款規則、付款方式)用 ChoiceChipGroup —— 視覺跟 ChoiceChip 一樣,
 *     但語意是 role="radiogroup" / role="radio" + aria-checked,鍵盤方向鍵可以切換;
 *     ChoiceChip 本身是 aria-pressed(壓下鈕 = 多選語意),**不要拿它做單選**
 *   - 開關做成一整列:左邊標題 + 一行說明,右邊開關(SwitchRow)
 *   - 欄位說明收進 `?`(help),要點才展開;「為什麼不能按 / 按了會怎樣」用 AlertNote 常駐(HelpHint.tsx)
 *
 * 錯誤外框的做法:FormField 在有 error 時給外層 data-invalid,FieldInput / FieldTextarea /
 * FieldAmountInput / FieldSelect / 原生欄位用 group-data-[invalid] 把框變紅——頁面不用自己傳 className。
 *
 * ⚠️ 這裡改動會影響全站所有表單,改之前先讀 .claude/skills/ui-overlay-patterns/SKILL.md。
 * ⚠️ skill 二之七「變數說明要完整(三欄 + 預覽框)」屬於 LINE 訊息模板那一頁專用,不在這份地基裡,
 *    第二階段處理該頁時再做。
 */

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { HelpToggle } from "./HelpHint";

// ---------------------------------------------------------------------------
// 欄位外框:標籤 / 必填 / ? / 字數 / 錯誤
// ---------------------------------------------------------------------------

interface FormFieldProps {
  label: React.ReactNode;
  /** 對應輸入元件的 id,讓點標籤能聚焦欄位。 */
  htmlFor?: string | undefined;
  required?: boolean | undefined;
  /** `?` 展開後的說明內容(看過一次就懂的:怎麼填、怎麼算、範例)。 */
  help?: React.ReactNode | undefined;
  /** `?` 的 aria-label,要寫完整句子,例:「說明:點數兌換比例怎麼設定」。有 help 就一定要給。 */
  helpLabel?: string | undefined;
  /** 錯誤訊息;有值時外框變紅 + 下面一行 `!` 說明。 */
  error?: string | null | undefined;
  /** 字數上限顯示:右上角 `34 / 1000`。 */
  counter?: { value: number; max: number } | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

export function FormField({
  label,
  htmlFor,
  required,
  help,
  helpLabel,
  error,
  counter,
  className,
  children,
}: FormFieldProps) {
  const hasError = Boolean(error);
  return (
    <div
      className={cn("group/field flex flex-col gap-1.5", className)}
      data-invalid={hasError ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        <Label htmlFor={htmlFor} className="text-[13px] font-semibold leading-none text-foreground">
          {label}
          {required ? (
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
          ) : null}
        </Label>
        {help ? <HelpToggle label={helpLabel ?? "說明"}>{help}</HelpToggle> : null}
        {counter ? (
          <span
            className={cn(
              "ml-auto text-xs tabular-nums",
              counter.value > counter.max
                ? "font-semibold text-destructive"
                : "text-muted-foreground",
            )}
          >
            {counter.value} / {counter.max}
          </span>
        ) : null}
      </div>
      {children}
      {hasError ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** 錯誤那一行:`!` 紅圈 + 說明。FormField 有 error 時自動用,獨立情境也可以直接放。 */
export function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-xs leading-snug text-destructive-strong"
    >
      <span
        aria-hidden="true"
        className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive text-[11px] font-bold leading-none text-destructive-foreground"
      >
        !
      </span>
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// 輸入元件:44px / 10px 圓角 / 錯誤時跟著外框變紅
// ---------------------------------------------------------------------------

const FIELD_CONTROL_CLASS =
  "h-11 rounded-md border-input bg-background px-3 text-[15px] md:text-[15px] group-data-[invalid=true]/field:border-destructive group-data-[invalid=true]/field:focus-visible:ring-destructive";

export const FieldInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <Input ref={ref} className={cn(FIELD_CONTROL_CLASS, className)} {...props} />
  ),
);
FieldInput.displayName = "FieldInput";

export const FieldTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <Textarea
    ref={ref}
    className={cn(
      "min-h-[88px] rounded-md border-input bg-background px-3 py-2.5 text-[15px] leading-relaxed md:text-[15px] group-data-[invalid=true]/field:border-destructive",
      className,
    )}
    {...props}
  />
));
FieldTextarea.displayName = "FieldTextarea";

/** 金額:靠右、tabular-nums、左側 `$`。 */
export const FieldAmountInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => (
  <div className="relative">
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-muted-foreground"
    >
      $
    </span>
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      className={cn(FIELD_CONTROL_CLASS, "pl-7 text-right tabular-nums", className)}
      {...props}
    />
  </div>
));
FieldAmountInput.displayName = "FieldAmountInput";

// ---------------------------------------------------------------------------
// 選項清單的共用型別(FieldSelect / FieldNativeSelect / ChoiceChipGroup 都吃這個)
// ---------------------------------------------------------------------------

export interface FieldOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// 下拉選單(shadcn / Radix Select 的統一樣式版)
// ---------------------------------------------------------------------------

interface FieldSelectProps<T extends string> {
  /** 對應 FormField 的 htmlFor,讓點標籤能打開下拉。 */
  id?: string | undefined;
  value?: T | undefined;
  defaultValue?: T | undefined;
  /** ⚠️ Radix Select 會在某些時序送出空字串的幽靈事件,值來自資料庫、非固定白名單時
   *  請用 `guardPhantomEmptyChange` 包起來(見 src/lib/radixSelectGuard.ts)。 */
  onValueChange?: ((value: T) => void) | undefined;
  /** 沒有值時顯示的灰字。 */
  placeholder?: string | undefined;
  /** 選項清單。要放分組 / 分隔線這種進階內容時改用 children 自己放 <SelectItem>。 */
  options?: ReadonlyArray<FieldOption<T>> | undefined;
  children?: React.ReactNode | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
}

/**
 * 下拉選單:44px / 10px 圓角 / 15px 字,錯誤時跟著 FormField 的外框變紅。
 * 🔴 頁面不要再自己在 SelectTrigger 上寫 className 調高度 / 圓角 / 字級 —— 樣式只由這裡決定。
 *
 * 用法:
 *   <FormField label="所屬分類" htmlFor="item-category">
 *     <FieldSelect
 *       id="item-category"
 *       value={form.categoryId ?? "__none__"}
 *       onValueChange={guardPhantomEmptyChange((v) => ...)}
 *       options={[{ value: "__none__", label: "未分類" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
 *     />
 *   </FormField>
 */
export function FieldSelect<T extends string = string>({
  id,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  options,
  children,
  disabled,
  required,
  name,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: FieldSelectProps<T>) {
  return (
    <Select
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange ? { onValueChange: onValueChange as (value: string) => void } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(required !== undefined ? { required } : {})}
      {...(name !== undefined ? { name } : {})}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(FIELD_CONTROL_CLASS, "shadow-none focus:ring-1 [&>span]:text-left")}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options
          ? options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className="min-h-10 cursor-pointer text-[15px]"
              >
                {option.label}
              </SelectItem>
            ))
          : null}
        {children}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// 原生控制項:<select> / <input type="time"> / <input type="date">
// ---------------------------------------------------------------------------

/** 原生控制項共用:跟 FIELD_CONTROL_CLASS 同高同圓角同字級,錯誤時同樣跟著外框變紅。 */
const NATIVE_CONTROL_CLASS =
  "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[15px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 group-data-[invalid=true]/field:border-destructive";

/** time / date 的原生小圖示(Chrome 的 ::-webkit-calendar-picker-indicator)預設自帶一截左邊距,
 *  兩顆時間欄位並排在 320px 時會把「上午 09:00」最後一個字擠掉,這裡把它歸零。 */
const PICKER_INDICATOR_CLASS =
  "[&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:p-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer";

interface FieldNativeSelectProps extends Omit<React.ComponentProps<"select">, "className"> {
  /** 選項清單;要用 <optgroup> 這種進階內容時改用 children 自己放 <option>。 */
  options?: ReadonlyArray<FieldOption> | undefined;
  /** 只給版面用(例如 `sm:w-36` 決定在一列裡佔多寬),不要拿來改高度 / 圓角 / 字級。 */
  className?: string | undefined;
}

/**
 * 原生 <select>:適合「選項是固定短清單、又跟時間 / 日期欄位排在同一列」的情境
 * (原生控制項在手機上會跳系統選單,體驗一致)。單獨一個下拉欄位請優先用 FieldSelect。
 */
export const FieldNativeSelect = React.forwardRef<HTMLSelectElement, FieldNativeSelectProps>(
  ({ options, children, className, ...props }, ref) => (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className={cn(NATIVE_CONTROL_CLASS, "cursor-pointer appearance-none pr-9")}
        {...props}
      >
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled ?? false}>
                {option.label}
              </option>
            ))
          : null}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50"
      />
    </div>
  ),
);
FieldNativeSelect.displayName = "FieldNativeSelect";

/**
 * 原生時間欄位 <input type="time">。className 只給版面用(寬度),不要改高度 / 圓角 / 字級。
 * 左右 padding 比一般欄位小(px-2):zh-TW 的原生時間欄位會顯示「上午 09:00」+ 時鐘圖示,
 * 兩顆並排在 320px 時用 px-3 會把文字截掉。同一列排兩顆時,電腦版寬度至少給 sm:w-36。
 */
export const FieldTime = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="time"
    className={cn(
      NATIVE_CONTROL_CLASS,
      PICKER_INDICATOR_CLASS,
      "appearance-none px-2 tabular-nums",
      className,
    )}
    {...props}
  />
));
FieldTime.displayName = "FieldTime";

/** 原生日期欄位 <input type="date">。className 只給版面用(寬度),不要改高度 / 圓角 / 字級。 */
export const FieldDate = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="date"
    className={cn(
      NATIVE_CONTROL_CLASS,
      PICKER_INDICATOR_CLASS,
      "appearance-none tabular-nums",
      className,
    )}
    {...props}
  />
));
FieldDate.displayName = "FieldDate";

/** 原生月份欄位 <input type="month">(報表的「指定月份 / 按月份區間」用)。className 只給版面用(寬度),
 *  不要改高度 / 圓角 / 字級。ui-v1-full 第 2 批補上:跟 FieldDate 同一套外觀,少了它報表頁就得自己刻。 */
export const FieldMonth = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="month"
    className={cn(
      NATIVE_CONTROL_CLASS,
      PICKER_INDICATOR_CLASS,
      "appearance-none tabular-nums",
      className,
    )}
    {...props}
  />
));
FieldMonth.displayName = "FieldMonth";

// ---------------------------------------------------------------------------
// 可點的方塊:多選(ChoiceChip)/ 單選群組(ChoiceChipGroup)
// ---------------------------------------------------------------------------

/** 兩種方塊共用的外觀,確保多選 / 單選看起來一模一樣,差別只在語意。 */
function chipClass(selected: boolean, className?: string | undefined) {
  return cn(
    "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    selected
      ? "border-brand bg-brand-soft font-semibold text-brand"
      : "border-input bg-background text-muted-foreground hover:bg-accent",
    className,
  );
}

interface ChoiceChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  selected: boolean;
}

/**
 * 多選方塊:選中 = 主題色框 + 勾,語意是 aria-pressed(壓下鈕)。放在 `flex flex-wrap gap-2` 的容器裡。
 * 🔴 只給「可以同時選好幾個」的情境(服務項目勾選);二選一 / 多選一請用 ChoiceChipGroup。
 */
export function ChoiceChip({ selected, className, children, ...props }: ChoiceChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={chipClass(selected, className)}
      {...props}
    >
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

interface ChoiceChipGroupProps<T extends string> extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onChange" | "defaultValue"
> {
  options: ReadonlyArray<FieldOption<T>>;
  value: T | null | undefined;
  onValueChange: (value: T) => void;
  disabled?: boolean | undefined;
}

/**
 * 單選群組:外觀同 ChoiceChip,語意是 role="radiogroup" / role="radio" + aria-checked。
 *   - 鍵盤:Tab 進來停在選中的那顆(沒選中時停第一顆),←/↑ 上一顆、→/↓ 下一顆(會繞圈)、
 *     Home / End 頭尾;移到哪顆就選哪顆(跟原生 radio 一樣)。
 *   - 一定要給 aria-label 或 aria-labelledby(FormField 的 <Label> 不能 htmlFor 到一個 div)。
 *
 * 用法:
 *   <FormField label="類型" required>
 *     <ChoiceChipGroup
 *       aria-label="類型"
 *       value={form.itemType}
 *       onValueChange={(v) => setField("itemType", v)}
 *       options={[{ value: "fixed", label: "固定價" }, { value: "hourly", label: "計時" }]}
 *     />
 *   </FormField>
 */
export function ChoiceChipGroup<T extends string>({
  options,
  value,
  onValueChange,
  disabled,
  className,
  ...props
}: ChoiceChipGroupProps<T>) {
  const groupRef = React.useRef<HTMLDivElement>(null);
  const enabledOptions = options.filter((option) => !option.disabled);
  const hasSelection = enabledOptions.some((option) => option.value === value);
  const firstEnabled = enabledOptions[0];

  function focusAndSelect(option: FieldOption<T>) {
    onValueChange(option.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.forEach((button) => {
      if (button.dataset["value"] === option.value) button.focus();
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, current: T) {
    if (disabled || enabledOptions.length === 0) return;
    const index = enabledOptions.findIndex((option) => option.value === current);
    let next: FieldOption<T> | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = enabledOptions[(index + 1) % enabledOptions.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = enabledOptions[(index - 1 + enabledOptions.length) % enabledOptions.length];
        break;
      case "Home":
        next = enabledOptions[0];
        break;
      case "End":
        next = enabledOptions[enabledOptions.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) focusAndSelect(next);
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-disabled={disabled ? true : undefined}
      className={cn("flex flex-wrap gap-2", className)}
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const isDisabled = Boolean(disabled || option.disabled);
        // roving tabindex:只有一顆能被 Tab 到 —— 選中的那顆;沒選中時是第一顆可用的。
        const tabbable = hasSelection ? selected : option === firstEnabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            tabIndex={tabbable && !isDisabled ? 0 : -1}
            disabled={isDisabled}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, option.value)}
            className={chipClass(selected)}
          >
            {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 開關列
// ---------------------------------------------------------------------------

interface SwitchRowProps {
  id?: string | undefined;
  title: React.ReactNode;
  description?: React.ReactNode | undefined;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** 開關底下的常駐提醒(例如「為什麼不能開」),請放 <AlertNote>。 */
  children?: React.ReactNode | undefined;
}

export function SwitchRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
  children,
}: SwitchRowProps) {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  return (
    <div className={cn("rounded-lg border border-border px-3.5 py-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label
            htmlFor={switchId}
            className={cn(
              "block text-sm font-semibold leading-snug",
              disabled ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </Label>
          {description ? (
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <Switch
          id={switchId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled ?? false}
          className="shrink-0 data-[state=checked]:bg-brand"
        />
      </div>
      {children ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}
