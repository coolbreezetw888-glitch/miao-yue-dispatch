// 對應規格書「首頁外殼與主題色優化」二、2.1:主題色實際套用的核心 bug 修正。
// `merchants.theme_preset`/`theme_custom_color` 一直都有存進資料庫,但從來沒有任何地方讀出來
// 套用成實際顏色——這個檔案就是補上「輸入商家的主題色設定 → 算出要覆寫的 CSS 變數值」這段串接,
// 實際套用(document.documentElement.style.setProperty)則由呼叫端(AppLayout.tsx)的 useEffect 負責,
// 這裡只做純函式的顏色計算,方便單獨測試。

import { THEME_PRESETS } from "./constants";
import type { Merchant } from "./types";

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** 這次要覆寫的既有 CSS 變數(styles.css 已經定義過,這裡不新增變數名稱)。 */
const THEME_CSS_VARIABLE_NAMES = [
  "--brand",
  "--brand-soft",
  "--brand-foreground",
  "--cta",
  "--cta-foreground",
  "--cta-soft",
  "--ring",
] as const;

function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * 規格書 2.1:「輸入」——自訂色(theme_custom_color)優先權高於預設色系(theme_preset)。
 * 沿用 MerchantSettingsPage/ThemePresetPicker 既有的儲存邏輯(兩個欄位都會存、互不清空對方),
 * 不重新發明「哪一個生效」的判斷順序,單純照規格書明講的優先順序取值。
 * 兩者都沒有設定或格式不合法時回傳 null(理論上不會發生,ThemePresetPicker 目前一定有預設選項,
 * 這裡只是防禦性處理)。
 */
export function resolveMerchantThemeColor(
  merchant: Pick<Merchant, "theme_preset" | "theme_custom_color"> | null | undefined,
): string | null {
  if (!merchant) return null;

  const customColor = normalizeHex(merchant.theme_custom_color);
  if (customColor) return customColor;

  if (merchant.theme_preset) {
    const preset = THEME_PRESETS.find((p) => p.key === merchant.theme_preset);
    const presetColor = normalizeHex(preset?.color ?? null);
    if (presetColor) return presetColor;
  }

  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** 近似 WCAG 相對亮度公式,不追求色彩學上的精確,只用來大致判斷這個顏色偏亮還是偏暗。 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 規格書 2.1:「--brand-foreground/--cta-foreground 用簡單的亮度閾值判斷選黑或白」。 */
function foregroundFor(hex: string): string {
  return relativeLuminance(hexToRgb(hex)) > 0.5 ? "#171717" : "#ffffff";
}

export interface DerivedThemeColors {
  brand: string;
  brandSoft: string;
  brandForeground: string;
  cta: string;
  ctaForeground: string;
  ctaSoft: string;
  ring: string;
}

/**
 * 規格書 2.1:「衍生方式」——輸入一個 hex 顏色字串,輸出要覆寫的幾個既有 CSS 變數值。
 * 淺色變化用 CSS `color-mix()` 做(瀏覽器原生計算,不用自己重新實作色彩混合公式),
 * 能大致呈現「跟著主題色系聯動」的效果即符合這次要求,不用追求色彩學上完美。
 */
export function deriveThemeColors(hex: string): DerivedThemeColors {
  const foreground = foregroundFor(hex);
  // 12% 主題色混 88% 白色:比照 styles.css 預設值 --brand-soft 那種「非常淺的底色」觀感,
  // 用在卡片 hover 的內部填色/圖示底色。
  const soft = `color-mix(in srgb, ${hex} 12%, white)`;

  return {
    brand: hex,
    brandSoft: soft,
    brandForeground: foreground,
    cta: hex,
    ctaForeground: foreground,
    ctaSoft: soft,
    ring: hex,
  };
}

/**
 * 規格書 2.1:「套用方式」——把衍生出的顏色寫進 <html> 的 inline style,覆寫 styles.css
 * 定義的既有 CSS 變數值。resolvedColor 為 null 時(理論上不會發生,防禦性處理)清掉所有先前的
 * 覆寫,退回 styles.css 原本的預設藍色,不殘留上一次套用的顏色。
 */
export function applyThemeColorToDocument(resolvedColor: string | null): void {
  const root = document.documentElement;

  if (!resolvedColor) {
    for (const name of THEME_CSS_VARIABLE_NAMES) {
      root.style.removeProperty(name);
    }
    return;
  }

  const derived = deriveThemeColors(resolvedColor);
  root.style.setProperty("--brand", derived.brand);
  root.style.setProperty("--brand-soft", derived.brandSoft);
  root.style.setProperty("--brand-foreground", derived.brandForeground);
  root.style.setProperty("--cta", derived.cta);
  root.style.setProperty("--cta-foreground", derived.ctaForeground);
  root.style.setProperty("--cta-soft", derived.ctaSoft);
  root.style.setProperty("--ring", derived.ring);
}
