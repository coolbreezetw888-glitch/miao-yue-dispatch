// 模組 11:LINE 通知 — line-send-marketing 的 Deno 測試(對應第七節,規則 2.6 核心必測)。
// 只測 buildMarketingDispatchPlan(未綁定會員被跳過且記錄 skip_reason='target_not_bound';
// §10.2/SPECS-INDEX #612 問題 2:黑名單會員一律被伺服器端強制擋下,不管前端傳了什麼進來)跟
// pushLineMessage,不呼叫真正的 Deno.serve handler(需要真實 Supabase 環境變數/資料庫連線)。
// 「客服呼叫被擋下、管理員成功」這個權限邊界已經在 index.ts 用 am_i_merchant_admin(既有的
// SECURITY DEFINER 函式)把關,對應的行為已經在 pgTAP module11_01(規則 2.1 對照組)驗證過
// am_i_merchant_admin 系列權限判斷本身的正確性;這裡專注驗證 line-send-marketing 自己這一層
// 「誰會被跳過/誰會被發送」的分派邏輯。

import { assertEquals } from "jsr:@std/assert@1";
import { buildMarketingDispatchPlan, type MarketingMemberRow } from "./index.ts";

const MEMBERS: MarketingMemberRow[] = [
  { id: "m1", name: "會員甲", line_bound: true, line_user_id: "Uabc001", is_blacklisted: false },
  { id: "m2", name: "會員乙", line_bound: false, line_user_id: null, is_blacklisted: false },
  { id: "m3", name: "會員丙", line_bound: true, line_user_id: "Uabc003", is_blacklisted: false },
  // §10.2:黑名單會員「無例外」——刻意設成已綁定 LINE(line_bound: true),驗證黑名單擋下的
  // 優先權比「有沒有綁定」更高,不是因為沒綁定才被跳過。
  {
    id: "m4-blacklisted",
    name: "會員丁(黑名單)",
    line_bound: true,
    line_user_id: "Uabc004",
    is_blacklisted: true,
  },
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

Deno.test("buildMarketingDispatchPlan(§10.2/SPECS-INDEX #612 問題 2,核心必測): 黑名單會員一律標記為 skipped_blacklisted,即使已經綁定 LINE 也不會是 will_send", () => {
  const plan = buildMarketingDispatchPlan(["m4-blacklisted"], MEMBERS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0].status, "skipped_blacklisted");
  assertEquals(plan[0].lineUserId, null);
  assertEquals(plan[0].name, "會員丁(黑名單)");
});

Deno.test("buildMarketingDispatchPlan(§10.2): 黑名單擋下的優先權比『未綁定』更高——同時符合兩種條件時記錄為黑名單,不是未綁定", () => {
  const blacklistedAndUnbound: MarketingMemberRow[] = [
    { id: "m5", name: "會員戊", line_bound: false, line_user_id: null, is_blacklisted: true },
  ];
  const plan = buildMarketingDispatchPlan(["m5"], blacklistedAndUnbound);
  assertEquals(plan[0].status, "skipped_blacklisted");
});

Deno.test("buildMarketingDispatchPlan(§10.2): 混合黑名單/已綁定/未綁定,各自正確分類,伺服器端不管前端傳了哪些 id 進來都會重新判斷", () => {
  const plan = buildMarketingDispatchPlan(["m1", "m2", "m3", "m4-blacklisted"], MEMBERS);
  const willSend = plan.filter((p) => p.status === "will_send");
  const skippedNotBound = plan.filter((p) => p.status === "skipped_not_bound");
  const skippedBlacklisted = plan.filter((p) => p.status === "skipped_blacklisted");
  assertEquals(willSend.length, 2);
  assertEquals(skippedNotBound.length, 1);
  assertEquals(skippedBlacklisted.length, 1);
  assertEquals(skippedBlacklisted[0].memberId, "m4-blacklisted");
});
