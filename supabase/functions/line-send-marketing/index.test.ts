// 模組 11:LINE 通知 — line-send-marketing 的 Deno 測試(對應第七節,規則 2.6 核心必測)。
// 只測 buildMarketingDispatchPlan(未綁定會員被跳過且記錄 skip_reason='target_not_bound';
// §10.2/SPECS-INDEX #612 問題 2:黑名單會員一律被伺服器端強制擋下,不管前端傳了什麼進來)跟
// pushLineMessage,不呼叫真正的 Deno.serve handler(需要真實 Supabase 環境變數/資料庫連線)。
// 權限邊界(#976 第 3 批起:管理員或 line_marketing 客服放行、其他客服擋下)在 index.ts 用
// am_i_allowed_line_marketing(SECURITY DEFINER,內部是 private.can_send_line_marketing)把關,
// 判斷本身由 pgTAP req976_02 驗證,實際呼叫這支 Edge Function 的 200 / 403 由
// e2e-local/permission-tightening-batch3.spec.ts 在本機驗證;這裡專注驗證 line-send-marketing 自己這一層
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

Deno.test(
  "buildMarketingDispatchPlan: 傳入不存在的 member_id(例如已被刪除)視為未綁定跳過,不報錯",
  () => {
    const plan = buildMarketingDispatchPlan(["not-exist-id"], MEMBERS);
    assertEquals(plan.length, 1);
    assertEquals(plan[0].status, "skipped_not_bound");
    assertEquals(plan[0].name, "");
  },
);

Deno.test(
  "buildMarketingDispatchPlan(§10.2/SPECS-INDEX #612 問題 2,核心必測): 黑名單會員一律標記為 skipped_blacklisted,即使已經綁定 LINE 也不會是 will_send",
  () => {
    const plan = buildMarketingDispatchPlan(["m4-blacklisted"], MEMBERS);
    assertEquals(plan.length, 1);
    assertEquals(plan[0].status, "skipped_blacklisted");
    assertEquals(plan[0].lineUserId, null);
    assertEquals(plan[0].name, "會員丁(黑名單)");
  },
);

Deno.test(
  "buildMarketingDispatchPlan(§10.2): 黑名單擋下的優先權比『未綁定』更高——同時符合兩種條件時記錄為黑名單,不是未綁定",
  () => {
    const blacklistedAndUnbound: MarketingMemberRow[] = [
      { id: "m5", name: "會員戊", line_bound: false, line_user_id: null, is_blacklisted: true },
    ];
    const plan = buildMarketingDispatchPlan(["m5"], blacklistedAndUnbound);
    assertEquals(plan[0].status, "skipped_blacklisted");
  },
);

Deno.test(
  "buildMarketingDispatchPlan(§10.2): 混合黑名單/已綁定/未綁定,各自正確分類,伺服器端不管前端傳了哪些 id 進來都會重新判斷",
  () => {
    const plan = buildMarketingDispatchPlan(["m1", "m2", "m3", "m4-blacklisted"], MEMBERS);
    const willSend = plan.filter((p) => p.status === "will_send");
    const skippedNotBound = plan.filter((p) => p.status === "skipped_not_bound");
    const skippedBlacklisted = plan.filter((p) => p.status === "skipped_blacklisted");
    assertEquals(willSend.length, 2);
    assertEquals(skippedNotBound.length, 1);
    assertEquals(skippedBlacklisted.length, 1);
    assertEquals(skippedBlacklisted[0].memberId, "m4-blacklisted");
  },
);

// =========================================================================
// 客戶端第 5-B 批 C5-P01(#1047):照每位聯絡人的「優惠通知」開關發
// =========================================================================
const CONTACT_MEMBERS: MarketingMemberRow[] = [
  {
    id: "c1", name: "公司會員", line_bound: false, line_user_id: null, is_blacklisted: false,
    contacts: [
      { user_id: "u-primary", line_user_id: "Uprimary", notify_promo: true, friend_status: "unknown" },
      { user_id: "u-second", line_user_id: "Usecond", notify_promo: true, friend_status: "friend" },
      { user_id: "u-off", line_user_id: "Uoff", notify_promo: false, friend_status: "friend" },
      { user_id: "u-block", line_user_id: "Ublock", notify_promo: true, friend_status: "not_friend" },
      { user_id: "u-otherch", line_user_id: null, notify_promo: true, friend_status: "unknown" },
    ],
  },
  {
    id: "c2-blacklisted", name: "黑名單公司", line_bound: false, line_user_id: null, is_blacklisted: true,
    contacts: [{ user_id: "u-x", line_user_id: "Ux", notify_promo: true, friend_status: "friend" }],
  },
  { id: "c3-legacy-blocked", name: "舊綁定封鎖", line_bound: true, line_user_id: "Ulegacy", is_blacklisted: false, contacts: [], legacy_friend_status: "not_friend" },
  { id: "c4-legacy", name: "舊綁定", line_bound: true, line_user_id: "Ulegacy4", is_blacklisted: false, contacts: [], legacy_friend_status: "unknown" },
];

Deno.test("C5-P01-1 多聯絡人:開著的各一則;關掉 ⇒ opted_out;已知非好友 ⇒ not_friend;沒有這間店身分 ⇒ not_bound", () => {
  const plan = buildMarketingDispatchPlan(["c1"], CONTACT_MEMBERS);
  assertEquals(plan.map((p) => `${p.targetUserId}:${p.status}:${p.lineUserId}`), [
    "u-primary:will_send:Uprimary",
    "u-second:will_send:Usecond",
    "u-off:skipped_opted_out:null",
    "u-block:skipped_not_friend:null",
    "u-otherch:skipped_not_bound:null",
  ]);
  assertEquals(plan.every((p) => p.memberId === "c1" && p.name === "公司會員"), true);
});

Deno.test("C5-P01-2 黑名單仍然優先擋(即使聯絡人都開著優惠通知)", () => {
  const plan = buildMarketingDispatchPlan(["c2-blacklisted"], CONTACT_MEMBERS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0].status, "skipped_blacklisted");
  assertEquals(plan[0].lineUserId, null);
});

Deno.test("C5-P01-3 沒有聯絡人的舊綁定碼會員:照舊發;已知非好友 ⇒ not_friend", () => {
  const plan = buildMarketingDispatchPlan(["c3-legacy-blocked", "c4-legacy"], CONTACT_MEMBERS);
  assertEquals(plan.map((p) => `${p.memberId}:${p.status}:${p.lineUserId}:${p.targetUserId}`), [
    "c3-legacy-blocked:skipped_not_friend:null:null",
    "c4-legacy:will_send:Ulegacy4:null",
  ]);
});

Deno.test("C5-P01-4 混合:則數 = 實際要發的聯絡人數(跟 preview_line_marketing_recipients 規則一致)", () => {
  const plan = buildMarketingDispatchPlan(["c1", "c2-blacklisted", "c3-legacy-blocked", "c4-legacy", "m1", "missing"], [...CONTACT_MEMBERS, ...MEMBERS]);
  assertEquals(plan.filter((p) => p.status === "will_send").length, 4);
});
