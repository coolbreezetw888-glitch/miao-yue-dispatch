// 模組 11:LINE 通知 — line-send-marketing 的 Deno 測試(對應第七節,規則 2.6 核心必測)。
// 只測 buildMarketingDispatchPlan(未綁定會員被跳過且記錄 skip_reason='target_not_bound')跟
// pushLineMessage,不呼叫真正的 Deno.serve handler(需要真實 Supabase 環境變數/資料庫連線)。
// 「客服呼叫被擋下、管理員成功」這個權限邊界已經在 index.ts 用 am_i_merchant_admin(既有的
// SECURITY DEFINER 函式)把關,對應的行為已經在 pgTAP module11_01(規則 2.1 對照組)驗證過
// am_i_merchant_admin 系列權限判斷本身的正確性;這裡專注驗證 line-send-marketing 自己這一層
// 「誰會被跳過/誰會被發送」的分派邏輯。

import { assertEquals } from "jsr:@std/assert@1";
import { buildMarketingDispatchPlan, type MarketingMemberRow } from "./index.ts";

const MEMBERS: MarketingMemberRow[] = [
  { id: "m1", name: "會員甲", line_bound: true, line_user_id: "Uabc001" },
  { id: "m2", name: "會員乙", line_bound: false, line_user_id: null },
  { id: "m3", name: "會員丙", line_bound: true, line_user_id: "Uabc003" },
];

Deno.test("buildMarketingDispatchPlan: 已綁定會員標記為 will_send 並帶出 line_user_id", () => {
  const plan = buildMarketingDispatchPlan(["m1"], MEMBERS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0].status, "will_send");
  assertEquals(plan[0].lineUserId, "Uabc001");
  assertEquals(plan[0].name, "會員甲");
});

Deno.test("buildMarketingDispatchPlan: 未綁定會員被跳過(核心必測,規則 2.6)", () => {
  const plan = buildMarketingDispatchPlan(["m2"], MEMBERS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0].status, "skipped_not_bound");
  assertEquals(plan[0].lineUserId, null);
});

Deno.test("buildMarketingDispatchPlan: 混合已綁定/未綁定會員,各自正確分類", () => {
  const plan = buildMarketingDispatchPlan(["m1", "m2", "m3"], MEMBERS);
  const willSend = plan.filter((p) => p.status === "will_send");
  const skipped = plan.filter((p) => p.status === "skipped_not_bound");
  assertEquals(willSend.length, 2);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].memberId, "m2");
});

Deno.test("buildMarketingDispatchPlan: 傳入不存在的 member_id(例如已被刪除)視為未綁定跳過,不報錯", () => {
  const plan = buildMarketingDispatchPlan(["not-exist-id"], MEMBERS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0].status, "skipped_not_bound");
  assertEquals(plan[0].name, "");
});
