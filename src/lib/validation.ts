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

// ---------------------------------------------------------------------------
// Email 格式驗證。
//
// ─── 為什麼需要(2026-09-24 稽核抓到)─────────────────────────────────────────
// 建單表單的「客戶 Email」欄位雖然寫了 <input type="email">,但那個原生格式驗證**從來不會
// 觸發**——因為那顆送出按鈕是 type="button" + onClick,外面也沒有包 <form>,瀏覽器根本沒有
// 「提交表單」這個動作可以觸發驗證。結果客服隨手打 `abc`(或誤把地址貼進去)就直接存進資料庫。
//
// 服務人員/客服的電話早就有 isValidTaiwanMobilePhone 嚴格把關(StaffListPage、AgentListPage、
// EditMyStaffProfileDialog 三處),客戶 Email 這邊卻一條驗證都沒有,所以補上這支共用函式,
// 一樣放在這個檔案讓各表單 import,不要各自在元件內寫一份正規表示式。
//
// ─── 刻意寫得寬鬆 ───────────────────────────────────────────────────────────
// 這裡的目的是擋掉「明顯不是 Email」的輸入(沒有 @、沒有網域、含空白),不是要完整實作
// RFC 5322——過嚴的正規表示式反而會誤擋掉合法但少見的位址(例如 name+tag@example.co.uk),
// 對客服來說「明明是對的卻存不進去」比「偶爾放過一個怪字串」更困擾。
// 真正確認 Email 有效的唯一方法是實際寄一封信出去,那不在這個欄位的職責範圍內。
// ---------------------------------------------------------------------------

/** Email 格式:@ 前後都要有內容、網域至少要有一個點、整串不能有空白字元。 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 檢查是否為合法的 Email 格式。注意:**空字串會回 false**,「選填欄位留空要放行」這件事
 * 由呼叫端自己先判斷(例如 `if (email.trim() && !isValidEmail(email)) { ... }`),
 * 這支函式本身不決定某個欄位是必填還是選填。 */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/** 白話錯誤訊息,各表單 Email 驗證失敗時共用同一句文案。 */
export const EMAIL_ERROR_MESSAGE = "請輸入正確的 Email 格式,例如 name@example.com";
