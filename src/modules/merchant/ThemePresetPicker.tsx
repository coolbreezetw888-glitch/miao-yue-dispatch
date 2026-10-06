// 對應規格書 4.7:主題色系選擇 UI —— 基礎預設色系(6 組,見 constants.ts)+ 自選色。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 兩個區塊改 FormField,說明收進 `?`(skill 二 / 二之七)。
//   - 色系方塊改成 skill 二之七的「可點的方塊」外觀(選中 = 主題色框 + 勾)、每顆至少 44px,
//     並補上 role="radiogroup" / role="radio" + aria-checked 的單選語意(原本只是一排 button,
//     螢幕閱讀器聽不出這是一組單選)。原本寫 border-primary,改成 border-brand —— 商家主題色
//     覆寫的是 --brand,不是 --primary(見 button.tsx 四階層那段說明)。
//   - 自選色的原生色彩選擇器改用新補的共用元件 FieldColor(44px 見方、跟其他欄位同一組邊框圓角);
//     色碼文字框改 FieldInput + 等寬字 + 大寫。
// **只動外觀,不動行為**:選色 / 改色碼的回呼與值完全照舊。

import { Check } from "lucide-react";

import { FieldColor, FieldInput, FormField } from "@/components/patterns";
import { cn } from "@/lib/utils";
import { THEME_PRESETS } from "./constants";

interface ThemePresetPickerProps {
  themePreset: string | null;
  themeCustomColor: string | null;
  onChangePreset: (key: string) => void;
  onChangeCustomColor: (hex: string) => void;
}

export function ThemePresetPicker({
  themePreset,
  themeCustomColor,
  onChangePreset,
  onChangeCustomColor,
}: ThemePresetPickerProps) {
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="基礎色系"
        help="選一組現成的色系最快。這個顏色會套用到全站的主要按鈕、選中狀態、標籤等地方(skill 一：元件不寫死品牌色，一律跟著這裡走)。"
        helpLabel="說明：基礎色系會影響哪些地方"
      >
        {/* 可點的方塊 = 單選(skill 二之七),選中 = 主題色框 + 勾。每顆至少 44px 觸控目標。
            這裡用原生 radiogroup 語意自己組(而不是 ChoiceChipGroup),因為每一顆裡面要放一個
            實際顏色的圓形色塊 —— 顏色是商家自訂的、build 時不知道,只能用 style 帶進來。 */}
        <div
          role="radiogroup"
          aria-label="基礎色系"
          className="grid grid-cols-3 gap-2.5 sm:grid-cols-6"
        >
          {THEME_PRESETS.map((preset) => {
            const selected = themePreset === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChangePreset(preset.key)}
                className={cn(
                  "flex min-h-11 cursor-pointer flex-col items-center gap-1.5 rounded-md border p-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-brand bg-brand-soft font-semibold text-brand ring-1 ring-brand"
                    : "border-input bg-background text-muted-foreground hover:bg-accent",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 items-center justify-center rounded-full"
                  style={{ backgroundColor: preset.color }}
                >
                  {selected ? <Check className="h-4 w-4 text-white" /> : null}
                </span>
                <span className="break-words">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </FormField>

      <FormField
        label="自選色(選填)"
        htmlFor="theme-custom-color"
        help="想用自己的品牌色就填這裡，會蓋過上面選的基礎色系。可以直接點左邊的色塊挑，或在右邊輸入 6 位色碼(例如 #FF7A30)。"
        helpLabel="說明：自選色怎麼填、跟基礎色系的關係"
      >
        <div className="flex items-center gap-2">
          <FieldColor
            id="theme-custom-color"
            value={themeCustomColor || "#000000"}
            onChange={(e) => onChangeCustomColor(e.target.value)}
          />
          <FieldInput
            aria-label="自選色的色碼"
            value={themeCustomColor ?? ""}
            onChange={(e) => onChangeCustomColor(e.target.value)}
            placeholder="例如 #FF7A30"
            className="min-w-0 max-w-[10rem] font-mono uppercase"
          />
        </div>
      </FormField>
    </div>
  );
}
