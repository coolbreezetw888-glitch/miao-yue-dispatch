// SPECS-INDEX #638:所有 e2e fixture 建立測試商家時,都是呼叫 create_group_and_merchant
// 一次性原子性建立「一個全新集團 + 這個集團底下唯一一間商家」——這代表這間商家在自己的集團裡
// 永遠是「僅存的一間」。而 merchants_prevent_disable_last_active 這個 DB trigger(規則 2.2,
// 見 supabase/migrations/20260915100000_merchant_group_schema.sql)規定「集團底下至少要保留
// 一間啟用中商家,不能停用最後一間」——這代表所有 fixture 原本在 teardown 最後一步直接把這間
// 商家的 status 改成 disabled,一定會被這個 trigger 擋下、噴出「集團底下至少要保留一間啟用中
// 商家,無法停用最後一間」的錯誤,商家永遠停留在 active 狀態,造成正式環境(wjtbmmnakcriuaqoknsq)
// 的「孤兒測試商家」隨每一次 e2e 執行持續累積(#638 查到的 39 筆殘留就是這樣來的)。
//
// 修法:client 端的 publishable key 沒有 merchants 的 DELETE 權限(規則 2.2:分店只能軟刪除,
// 不能真刪除,故意的業務規則,不能繞過),沒辦法直接刪掉這間商家避開這條規則。這裡改成先用
// 既有、合法的 create_merchant_in_group RPC(4.4 新增分店流程本來就有的管道,不是新增任何
// schema/RPC)在同一個集團底下,額外建立一間完全沒有任何測試資料、純粹只是「佔位」用途的
// 商家(RPC 建立出來的商家預設就是 status='active'),讓「集團底下至少要保留一間啟用中商家」
// 這條規則被這個佔位商家滿足,接著才能把真正承載這次測試資料(服務人員/會員/訂單等)的那間
// 商家停用成功。
//
// ⚠️ 這個做法沒有徹底解決「每次 e2e 執行都會在正式環境留下一間 active 商家」的問題——佔位
// 商家本身依然是它自己集團裡「僅存的一間啟用中商家」,同一個 trigger 邏輯代表沒辦法在同一次
// teardown 裡把它自己也停用掉(會需要無窮遞迴出更多佔位商家)。但比起現況(整間承載了完整
// 服務人員/會員/訂單測試資料的商家永遠留在 active 狀態)已經好上非常多:留下的佔位商家永遠是
// 「空殼」(除了 create_merchant_in_group 自動套用的產業預設功能 + 預設付款方式以外,沒有任何
// 服務人員/會員/訂單/服務項目資料),用固定的名稱前綴清楚標記,之後要用資料庫直接存取權限
// 定期清乾淨時,不需要像這次 #638 一樣逐筆人工核對子表資料——名稱前綴本身就已經保證「這一定
// 是空殼」,可以直接批次刪除。是否要另外排一支排程/單次的 SQL 清掃 job 定期清除這些佔位商家,
// 由主腦/使用者決定,這次交付內容已在回報中說明。
import type { SupabaseClient } from "@supabase/supabase-js";

export const TEARDOWN_PLACEHOLDER_MERCHANT_NAME_PREFIX = "E2E-teardown佔位商家-可直接刪除-";

/** 停用一間由 create_group_and_merchant 建立(集團底下目前唯一一間商家)的 fixture 測試商家。
 * 直接呼叫 `.from("merchants").update({ status: "disabled" })` 一定會被
 * merchants_prevent_disable_last_active 這個 DB trigger 擋下(見檔案開頭說明),這裡先用
 * create_merchant_in_group 在同一集團底下建立一個空殼佔位商家滿足「至少保留一間啟用中商家」
 * 的規則,再停用真正的測試商家。回傳一行可讀的清理結果訊息,供各 fixture 的 teardown 函式
 * 直接 push 進自己的 actions 陣列(呼叫端要先用這個 fixture 自己的測試帳號 session 還原過
 * client,這個函式本身不處理登入)。 */
export async function disableFixtureMerchant(
  client: SupabaseClient,
  merchantId: string,
): Promise<string> {
  const { data: merchantRow, error: fetchError } = await client
    .from("merchants")
    .select("group_id")
    .eq("id", merchantId)
    .maybeSingle();
  if (fetchError || !merchantRow) {
    return `查詢 fixture 商家所屬集團失敗,略過停用步驟(${fetchError?.message ?? "查無這筆商家"})`;
  }
  const groupId = (merchantRow as { group_id: string }).group_id;

  const { error: placeholderError } = await client.rpc("create_merchant_in_group", {
    p_group_id: groupId,
    p_name: `${TEARDOWN_PLACEHOLDER_MERCHANT_NAME_PREFIX}${merchantId.slice(0, 8)}`,
    p_industry_type: "in_store_beauty",
  });
  if (placeholderError) {
    return (
      `建立佔位商家失敗,略過停用步驟(${placeholderError.message})——這間 fixture 商家仍是 ` +
      "active 狀態,需要另外用資料庫直接存取權限清理。"
    );
  }

  const { error: disableError } = await client
    .from("merchants")
    .update({ status: "disabled" })
    .eq("id", merchantId);
  return disableError
    ? `停用 fixture 商家失敗:${disableError.message}`
    : "已停用 fixture 商家(軟刪除;teardown 已先在同集團建立空殼佔位商家繞開「至少保留一間啟用中商家」規則,見 e2e/support/merchant-teardown-helper.ts 說明)";
}
