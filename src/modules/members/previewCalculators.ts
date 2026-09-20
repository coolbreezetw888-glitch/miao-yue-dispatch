// 模組 10(會員與紅利)§4.3:會員系統設定頁的「即時預覽計算機」。
//
// 純函式,只給畫面上的白話試算用(例如「一筆 1000 元的訂單,這位會員可以拿到多少點數」),
// 不是任何寫入依據。真正的計算永遠以資料庫函式(compute_member_loyalty_points)的結果為準
// (比照模組 8 previewCalculators.ts 的既有精神)。

/** 消費點數試算(規則 2.1/3.7):floor(金額 / 比例)。points_earn_rate <= 0 代表尚未設定,
 * 直接回傳 0(不能自己「幫」商家假設一個比例)。 */
export function previewLoyaltyPoints(amount: number, pointsEarnRate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(pointsEarnRate) || pointsEarnRate <= 0) {
    return 0;
  }
  if (amount <= 0) return 0;
  return Math.floor(amount / pointsEarnRate);
}
