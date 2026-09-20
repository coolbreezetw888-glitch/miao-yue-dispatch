// 模組 11:LINE 通知 — line-notify-dispatch 的 Deno 測試(對應第七節,規則 2.4 核心必測、
// 3.10/3.14 判斷邏輯一致性)。只測跟 I/O 分離的純函式(renderMessageTemplate/pushLineMessage/
// shouldWriteAnyLogRow),用假的 fetch 模擬 LINE push API 成功/失敗情境。不呼叫真正的
// Deno.serve handler(需要真實 Supabase 環境變數/資料庫連線,這次沒有可用的測試環境,見規格書
// 第〇節)——完整的端對端跳過情境已在 pgTAP(module11_02)驗證 resolve_line_notification_targets
// 這支「唯一一份判斷邏輯」的正確性,這裡只需要驗證 Edge Function 自己這一層的處理邏輯。

import { assertEquals } from "jsr:@std/assert@1";
import {
  pushLineMessage,
  renderMessageTemplate,
  shouldWriteAnyLogRow,
  type ResolveTargetsResult,
} from "./index.ts";

Deno.test("renderMessageTemplate: 涵蓋所有已定義變數,正確替換", () => {
  const template = "【{{merchant_name}}】{{customer_name}} 於 {{booking_date}} 預約 {{service_names}}。";
  const result = renderMessageTemplate(template, {
    merchant_name: "測試商家",
    customer_name: "王小明",
    booking_date: "2026-12-01 10:00",
    service_names: "洗髮、剪髮",
  });
  assertEquals(result, "【測試商家】王小明 於 2026-12-01 10:00 預約 洗髮、剪髮。");
});

Deno.test("renderMessageTemplate: 缺值情境(變數不在提供的物件裡)保留原樣不報錯", () => {
  const result = renderMessageTemplate("金額:{{final_amount}} 元", {});
  assertEquals(result, "金額:{{final_amount}} 元");
});

Deno.test("renderMessageTemplate: 空字串值正確替換成空字串(不是保留原樣)", () => {
  const result = renderMessageTemplate("取消原因:{{cancel_reason}}", { cancel_reason: "" });
  assertEquals(result, "取消原因:");
});

Deno.test("renderMessageTemplate: 沒有任何變數的純文字範本原樣輸出", () => {
  const result = renderMessageTemplate("這是一則沒有變數的訊息", { unused: "x" });
  assertEquals(result, "這是一則沒有變數的訊息");
});

Deno.test("pushLineMessage: 成功回傳 ok=true", async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.errorDetail, null);
});

Deno.test("pushLineMessage: LINE 回傳錯誤時記錄錯誤內容", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "The user hasn't added the bot as a friend" }), {
        status: 400,
      }),
    )) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, false);
  assertEquals(result.status, 400);
  assertEquals(result.errorDetail?.includes("hasn't added"), true);
});

Deno.test("pushLineMessage: 網路錯誤時 status=0 並記錄錯誤訊息", async () => {
  const fakeFetch = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, false);
  assertEquals(result.status, 0);
  assertEquals(result.errorDetail, "connection refused");
});

function makeResult(overrides: Partial<ResolveTargetsResult>): ResolveTargetsResult {
  return { connected: true, event_enabled: true, targets: [], skipped: [], ...overrides };
}

Deno.test("shouldWriteAnyLogRow: 2.4 第 1 點——商家沒串接 LINE 時不寫入任何記錄", () => {
  const result = makeResult({ connected: false, event_enabled: false });
  assertEquals(shouldWriteAnyLogRow(result), false);
});

Deno.test("shouldWriteAnyLogRow: 2.4 第 2 點——事件關閉時不寫入任何記錄", () => {
  const result = makeResult({ connected: true, event_enabled: false });
  assertEquals(shouldWriteAnyLogRow(result), false);
});

Deno.test("shouldWriteAnyLogRow: 已連線且事件開啟,但沒有任何目標(理論上不會出現,防禦性驗證)不寫入", () => {
  const result = makeResult({ targets: [], skipped: [] });
  assertEquals(shouldWriteAnyLogRow(result), false);
});

Deno.test("shouldWriteAnyLogRow: 已連線且事件開啟,有 skipped 對象時要寫入記錄(核心必測,規則 2.4 第 3 點)", () => {
  const result = makeResult({
    targets: [],
    skipped: [{ type: "staff", id: "s1", reason: "target_not_bound" }],
  });
  assertEquals(shouldWriteAnyLogRow(result), true);
});

Deno.test("shouldWriteAnyLogRow: 已連線且事件開啟,有實際目標時要寫入記錄", () => {
  const result = makeResult({
    targets: [{ type: "member", id: "m1", name: "會員甲", line_user_id: "Uabc" }],
  });
  assertEquals(shouldWriteAnyLogRow(result), true);
});
