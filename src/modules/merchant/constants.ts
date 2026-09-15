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

/** 規格書 4.5:目前操作中商家的 id 存進瀏覽器,供分店切換器與 useCurrentMerchant() 共用。
 *
 * 2026-09-15 主腦複查修正(SPECS-INDEX 編號 26/27):這個 key 原本是全域的,不分帳號、登出時也
 * 沒有清除——同一個瀏覽器換帳號測試時,新帳號會讀到舊帳號存的商家 id,導致新帳號(可能 0 間商家、
 * 該導去 Onboarding)誤顯示成舊帳號的商家。改成依登入使用者 id 分開存(見下方
 * getCurrentMerchantStorageKey),不同帳號的 key 天生互不影響。這是「讀取任何使用者上次操作狀態
 * 的本機快取時,都要用目前登入的使用者身份當作 key 的一部分」的通用模式,之後任何模組要在
 * localStorage/sessionStorage 存使用者專屬的偏好設定時都應該比照辦理,不要用一個全域共用的 key。 */
export const CURRENT_MERCHANT_STORAGE_KEY_PREFIX = "miaoyue.currentMerchantId";

/** 依使用者 id 組出專屬的 localStorage key,見上方說明。 */
export function getCurrentMerchantStorageKey(userId: string): string {
  return `${CURRENT_MERCHANT_STORAGE_KEY_PREFIX}.${userId}`;
}
