// 客戶端第 5 批:「優惠通知」開關的畫面總開關(客人端會員中心 + 後台會員聯絡人卡共用同一個值)。
// 🔴 5-A = false:行銷 / 生日禮照「優惠通知」開關發送是 5-B(C5-P01、P02)。5-A 先顯示的話,客人關掉了還是會收到
//    優惠訊息 = 畫面說謊;後台看到「優惠通知：關」也會以為不會發。5-B 上線時改成 true,兩邊一起出現。
// 放在 src/lib 是因為 public-booking 與 line-notifications 兩個模組都要讀,不讓其中一個模組依賴另一個。
export const PROMO_SWITCH_VISIBLE = false;
