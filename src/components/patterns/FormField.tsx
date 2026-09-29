/**
 * 表單欄位 —— ui-overlay-patterns skill 二之七。
 *
 *   - 高度一律 44px、圓角 10px(rounded-md)、標籤在欄位上方(13px 粗體)
 *   - 必填用紅色 `*`,不要寫「(必填)」佔位置
 *   - 錯誤:框變紅 **+ 下面一行 `!` 說明**。🔴 不要只把框變紅
 *   - 數字 tabular-nums,金額靠右並在左側放 `$`(FieldAmountInput)
 *   - 有字數上限的欄位,右上角顯示 `34 / 1000`(counter)
 *   - 多選用可點的方塊(ChoiceChip,選中 = 主題色框 + 勾),不用打勾方框(手機好按)
 *   - 開關做成一整列:左邊標題 + 一行說明,右邊開關(SwitchRow)
 *   - 欄位說明收進 `?`(help),要點才展開;「為什麼不能按 / 按了會怎樣」用 AlertNote 常駐(HelpHint.tsx)
 *
 * 錯誤外框的做法:FormField 在有 error 時給外層 data-invalid,FieldInput / FieldTextarea /
 * FieldAmountInput 用 group-data-[invalid] 把框變紅——頁面不用自己傳 className。
 *
 * ⚠️ skill 二之七「變數說明要完整(三欄 + 預覽框)」屬於 LINE 訊息模板那一頁專用,不在這份地基裡,
 *    第二階段處理該頁時再做。
 */

import * as React from "react";
import { Check } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
// 多選方塊
// ---------------------------------------------------------------------------

interface ChoiceChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  selected: boolean;
}

/** 可點的方塊:選中 = 主題色框 + 勾。放在 `flex flex-wrap gap-2` 的容器裡。 */
export function ChoiceChip({ selected, className, children, ...props }: ChoiceChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-brand bg-brand-soft font-semibold text-brand"
          : "border-input bg-background text-muted-foreground hover:bg-accent",
        className,
      )}
      {...props}
    >
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </button>
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
