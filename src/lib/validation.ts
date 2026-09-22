// 共用的簡單欄位格式驗證工具。
// 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\人員與權限管理.md §8.3:
// 「新增服務人員」(§8.1)跟「客服邀請」(§8.2)兩個表單都要 import 這支同一個函式,
// 不要各自在元件內寫一份正規表示式判斷,避免兩處規則不一致。
//
// 注意:Supabase Edge Function(supabase/functions/invite-merchant-agent)是獨立的 Deno
// runtime,無法直接 import 這個檔案(這個檔案走 Vite 打包給瀏覽器用),所以 Edge Function
// 端另外在 supabase/functions/_shared/phoneValidation.ts 放了一份「正規表示式逐字相同」的
// 版本並在檔案開頭互相註記——修改這裡的正規表示式時,務必同步修改那一份,兩處要保持逐字一致
// (§8.3 邊界情況)。

/** 台灣手機號碼格式:09 開頭、共 10 碼純數字,不允許空格/破折號/加號等其他字元。 */
export const TW_MOBILE_PHONE_REGEX = /^09\d{8}$/;

/** 檢查是否為合法的台灣手機號碼格式(09 開頭、共 10 碼數字)。 */
export function isValidTaiwanMobilePhone(phone: string): boolean {
  return TW_MOBILE_PHONE_REGEX.test(phone);
}

/** 白話錯誤訊息,§8.1/§8.2 表單驗證失敗時共用同一句文案。 */
export const TW_MOBILE_PHONE_ERROR_MESSAGE = "請輸入正確的手機號碼格式,例如 0912345678";
