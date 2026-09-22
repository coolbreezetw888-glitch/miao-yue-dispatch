// 台灣手機號碼格式驗證(Edge Function 端)。
// 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\人員與權限管理.md §8.2/§8.3。
//
// 這份檔案的正規表示式跟前端 src/lib/validation.ts 的 TW_MOBILE_PHONE_REGEX 要逐字一致
// (§8.3 邊界情況:「兩處約束表達式要逐字一致」)。之所以另外放一份、不是直接 import
// src/lib/validation.ts,是因為 Edge Function 跑在獨立的 Deno runtime、跟前端走 Vite 打包
// 是兩個不同的建置/部署管線,這個專案既有的 supabase/functions/_shared 慣例也是把共用邏輯
// 放在 supabase/functions/_shared 底下、用相對路徑 import(不會跨到 src/ 目錄)。
// **修改這裡的正規表示式時,務必同步修改 src/lib/validation.ts 那一份。**

/** 台灣手機號碼格式:09 開頭、共 10 碼純數字。務必與 src/lib/validation.ts 逐字一致。 */
export const TW_MOBILE_PHONE_REGEX = /^09\d{8}$/;

export function isValidTaiwanMobilePhone(phone: string): boolean {
  return TW_MOBILE_PHONE_REGEX.test(phone);
}
