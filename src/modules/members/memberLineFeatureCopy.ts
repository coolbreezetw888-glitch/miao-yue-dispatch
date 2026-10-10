// SPECS-INDEX #1052 H2-05:會員相關畫面依「LINE 通知」功能開關調整的選項與文字(純函式,方便 Vitest 逐條驗)。
//
// 規則(功能開關 skill):hasFeature(key) === true 才算開;讀取中 / 讀取失敗一律當「先不顯示」。

import { REWARD_CONDITION_MODE_LABELS, type RewardConditionMode } from "./types";

/**
 * 紅利點數管理 >「核發獎勵資格條件」下拉的選項。
 * LINE 通知沒開 ⇒ 不列「只看 LINE 已綁定」;但目前存的值剛好就是它時照樣列出來,
 * 下拉才不會變成空白、店家原本的設定也不會被看成不見了(設定值保留不刪)。
 */
export function rewardConditionModeOptions(
  lineNotificationsOn: boolean,
  current: RewardConditionMode,
): RewardConditionMode[] {
  return (Object.keys(REWARD_CONDITION_MODE_LABELS) as RewardConditionMode[]).filter(
    (mode) => mode !== "line_bound" || lineNotificationsOn || current === "line_bound",
  );
}

/** 會員名單「還沒有任何會員」空白狀態的說明;LINE 再行銷沒開時不提 LINE。 */
export function membersListFirstMemberHint(lineMarketingOn: boolean): string {
  return lineMarketingOn
    ? "按右上角的「新增會員」建立第一位。建立之後，建單時輸入電話就能查到這位客戶、累積紅利點數、發生日獎勵與 LINE 再行銷通知。"
    : "按右上角的「新增會員」建立第一位。建立之後，建單時輸入電話就能查到這位客戶、累積紅利點數、發生日獎勵。";
}
