// 對應規格書 4.7:主題色系選擇 UI —— 基礎預設色系(6 組,見 constants.ts)+ 自選色。

import { Check } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <div className="space-y-4">
      <div>
        <Label>基礎色系</Label>
        <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-6">
          {THEME_PRESETS.map((preset) => {
            const selected = themePreset === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => onChangePreset(preset.key)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border p-2 text-xs transition-colors",
                  selected
                    ? "border-primary ring-1 ring-primary"
                    : "border-border hover:border-primary/50",
                )}
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{ backgroundColor: preset.color }}
                >
                  {selected ? <Check className="h-4 w-4 text-white" /> : null}
                </span>
                <span className="text-foreground">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label htmlFor="theme-custom-color">自選色(選填)</Label>
        <div className="mt-2 flex items-center gap-3">
          <input
            id="theme-custom-color"
            type="color"
            value={themeCustomColor || "#000000"}
            onChange={(e) => onChangeCustomColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-input bg-transparent"
          />
          <Input
            value={themeCustomColor ?? ""}
            onChange={(e) => onChangeCustomColor(e.target.value)}
            placeholder="例如 #FF7A30"
            className="max-w-[10rem]"
          />
        </div>
      </div>
    </div>
  );
}
