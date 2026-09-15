// 對應規格書 4.7:主題色系選擇 UI — 基礎預設色系清單(已與使用者確認照建議走,共 6 組)。

export interface ThemePreset {
  key: string;
  label: string;
  /** 用於色票預覽與 UI 顯示的代表色 hex,實際套用到商家頁面的邏輯留給之後有前台頁面的模組串接。 */
  color: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { key: "vibrant_orange", label: "活力橘", color: "#FF7A30" },
  { key: "steady_blue", label: "沉穩藍", color: "#2563EB" },
  { key: "minimal_mono", label: "簡約黑白", color: "#111827" },
  { key: "warm_green", label: "溫暖綠", color: "#16A34A" },
  { key: "soft_pink", label: "柔和粉", color: "#EC4899" },
  { key: "elegant_purple", label: "優雅紫", color: "#7C3AED" },
];

/** 規格書 4.5:目前操作中商家的 id 存進瀏覽器,供分店切換器與 useCurrentMerchant() 共用。 */
export const CURRENT_MERCHANT_STORAGE_KEY = "miaoyue.currentMerchantId";
