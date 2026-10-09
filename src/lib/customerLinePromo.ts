// 客戶端第 5 批:「優惠通知」開關的畫面總開關(客人端會員中心 + 後台會員聯絡人卡共用同一個值)。
// 5-A = false(行銷 / 生日禮那時還沒照開關發,先顯示 = 畫面說謊)。
// 5-B(#1047,C5-P01、P02)行銷與生日禮改成照「優惠通知」開關發送 ⇒ true,客人端與後台聯絡人卡一起出現。
// 🔴 要改回 false 只能跟 P01 / P02 一起退(不然客人關了還是會收到)。
// 放在 src/lib 是因為 public-booking 與 line-notifications 兩個模組都要讀,不讓其中一個模組依賴另一個。
export const PROMO_SWITCH_VISIBLE = true;
