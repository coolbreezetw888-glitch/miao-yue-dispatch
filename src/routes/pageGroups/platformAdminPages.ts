// SPECS-INDEX #1054(網站拆檔):「超級管理員」分組。守門元件(PlatformAdminGuard)跟頁面放在同一包,
// 權限判斷照舊由守門元件 + 資料庫負責,拆檔只影響「什麼時候下載」。
export { PlatformAdminGuard } from "@/modules/platform-admin/PlatformAdminGuard";
export { default as MerchantsOverviewPage } from "@/modules/platform-admin/MerchantsOverviewPage";
export { default as MerchantDetailPage } from "@/modules/platform-admin/MerchantDetailPage";
export { default as IndustryPresetsPage } from "@/modules/platform-admin/IndustryPresetsPage";
