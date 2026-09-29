// 抽成制服務人員卡片「要不要標黃(待辦)」的判斷 —— ui-overlay-patterns skill 二之五。
//
// ## 為什麼要有守門條件(2026-09-30 QA 抓到 + 使用者同型裁決)
//
// 抽成設定頁原本寫的是:
//
//     const needsAttention = total === 0 || unconfigured > 0;
//
// 沒有任何守門條件。**「逐項抽成」是選配功能**——很多商家根本不用它(抽成制服務人員可能是用別的
// 方式談的,或商家只用月薪制),那些商家的每一位抽成制服務人員永遠都是「有項目沒設抽成」
// ⇒ 整份名單**永久全黃**。全部都黃的時候,「哪張要處理」的對比就消失了,黃色等於白做。
//
// 🔴 使用者 2026-09-30 已經為同型問題裁決過(服務人員「尚未開通登入」黃卡),規則寫進 skill 二之五:
//
// > 標成待辦之前先問:「這個狀態對某些使用者是不是永久狀態?」如果是,它就不是待辦,是屬性
// > —— 屬性不給警示色。
//
// 所以這裡照同一條規則:**只有「這家商家已經在用逐項抽成」(整份名單裡至少已經設定過一項)時,
// 其他未設定的才標黃**;一項都沒設定過 = 沒在用這個功能 ⇒ 不標黃,標籤降成中性樣式
// (資訊仍然要看得到,只是不搶注意力)。
//
// 📌 判斷基準是**整份名單**,不是目前畫面上那一位——這跟 skill 二之五 對「尚未開通登入」的
//    規定一致(切分頁 / 篩選不可以讓黃不黃跟著變)。

/** 一位抽成制服務人員的抽成設定覆蓋率。 */
export interface StaffCommissionCoverage {
  /** 這位服務人員「可接的服務項目」有幾個。 */
  total: number;
  /** 其中已經設定過抽成的有幾個。 */
  configured: number;
}

/**
 * 這家商家有沒有在用「逐項抽成」這個功能 —— 整份名單裡只要有任何一項抽成被設定過就算有。
 *
 * 傳進來的應該是**整份抽成制服務人員名單**的覆蓋率,不是篩選後的一批。
 */
export function merchantUsesPieceRateCommission(
  coverages: readonly StaffCommissionCoverage[],
): boolean {
  return coverages.some((c) => c.configured > 0);
}

/**
 * 這張卡片要不要標成待辦(整張變黃 + `!` 標籤)。
 *
 * @param own 這位服務人員自己的覆蓋率
 * @param merchantUsesCommission `merchantUsesPieceRateCommission()` 的結果(整份名單算出來的)
 */
export function shouldFlagCommissionAttention(
  own: StaffCommissionCoverage,
  merchantUsesCommission: boolean,
): boolean {
  // 守門:這家商家沒在用逐項抽成 ⇒ 沒有人是待辦(那是屬性,不是待辦)。
  if (!merchantUsesCommission) return false;
  if (own.total === 0) return true;
  return own.total - own.configured > 0;
}
