/**
 * 句子裡的「目前開啟 / 目前關閉」狀態字 —— SPECS-INDEX #998 第 11 批 I。
 *
 * 只包住狀態那幾個字,整句其他字維持原本的灰色:
 *   開啟 = `font-semibold text-success-strong`(綠)
 *   關閉 = `font-semibold text-destructive-strong`(紅;意思是「提醒你目前是關的」,不是錯誤)
 * 一律用設計系統的語意 token(淺色 / 深色模式都已定義成高對比組),不寫死任何色碼。
 *
 * 🔴 顏色不是唯一差別(ui-overlay-patterns skill 二之四:色盲看不出紅綠)—— 字本身就寫「開啟 / 關閉」。
 * 為什麼不用 StatusTag 膠囊:skill 二之四規定「停用 = 灰系」,紅色膠囊會跟「已取消 / 已移除」這類出事狀態
 * 混在一起;句中變色字較輕、不違反標籤規則。
 */
import { cn } from "@/lib/utils";

export const ON_OFF_STATE_TEXT_CLASSES = {
  on: "font-semibold text-success-strong",
  off: "font-semibold text-destructive-strong",
} as const;

export interface OnOffStateTextProps {
  on: boolean;
  onText?: string;
  offText?: string;
  testId?: string;
  className?: string;
}

export function OnOffStateText({
  on,
  onText = "目前開啟",
  offText = "目前關閉",
  testId,
  className,
}: OnOffStateTextProps) {
  return (
    <span
      data-testid={testId}
      data-state={on ? "on" : "off"}
      className={cn(on ? ON_OFF_STATE_TEXT_CLASSES.on : ON_OFF_STATE_TEXT_CLASSES.off, className)}
    >
      {on ? onText : offText}
    </span>
  );
}
