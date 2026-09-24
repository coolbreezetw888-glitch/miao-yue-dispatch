// 模組 15 擴充 §6.5:「證明真的生效」的誠實界線 —— 這支測試是那條紅線的守門員。
//
// 🔴 使用者 2026-09-25 裁決 Q5 的硬性要求:文案絕對不可以寫成無法兌現的「已生效」。
//    判斷法則:把畫面上那句話當成承諾唸出來,問「如果使用者的手機在靜音,這句話還是真的嗎?」
//    —— 不是,就是違規文案。
//
// 這裡做兩件事:
//   1. 對每一個狀態的每一句文案掃「禁止字眼清單」(加新文案時一定會被掃到)。
//   2. 釘住「還沒收到裝置回報時,絕對不可以出現『已確認』字樣」——這是最容易被改鬆的一條。

import { describe, expect, it } from "vitest";

import {
  PUSH_TEST_ACK_TIMEOUT_MS,
  PUSH_TEST_TROUBLESHOOTING,
  describePushTestState,
  readPushTestAckTokenFromSearch,
  type PushTestState,
} from "./pushTestStatus";

/** §6.5 的禁止字眼清單(規格書原文照抄)。 */
const FORBIDDEN_PHRASES = [
  "已生效",
  "已確認生效",
  "通知功能正常",
  "設定完成,你會收到通知",
  "已成功開啟並生效",
];

const ALL_STATES: PushTestState[] = [
  "idle",
  "waiting",
  "device_acked",
  "clicked",
  "no_ack",
  "no_device",
  "rate_limited",
  "error",
];

describe("§6.5(🔴 核心必測):文案不可以寫成無法兌現的承諾", () => {
  it("每一個狀態的每一句文案都不含禁止字眼", () => {
    for (const state of ALL_STATES) {
      const message = describePushTestState(state);
      if (!message) continue;
      const all = `${message.text} ${message.hint ?? ""}`;
      for (const phrase of FORBIDDEN_PHRASES) {
        expect(all.includes(phrase), `狀態 ${state} 的文案出現禁止字眼「${phrase}」`).toBe(false);
      }
    }
  });

  it("排查清單裡也不能出現禁止字眼", () => {
    for (const item of PUSH_TEST_TROUBLESHOOTING) {
      for (const phrase of FORBIDDEN_PHRASES) {
        expect(item.includes(phrase)).toBe(false);
      }
    }
  });

  it("成功狀態說的是「你的裝置收到」,不是「通知生效」——這兩件事之間隔著靜音/專注模式", () => {
    const message = describePushTestState("device_acked");
    expect(message?.text).toBe("已確認你的裝置收到通知");
    // 而且同一則訊息要誠實提醒「裝置收到 ≠ 你看得到」。
    expect(message?.hint).toContain("靜音");
  });

  it("還沒收到回報的三種狀態,一律不可以出現「已確認」字樣", () => {
    for (const state of ["waiting", "no_ack", "no_device", "rate_limited", "error"] as const) {
      const message = describePushTestState(state);
      const all = `${message?.text ?? ""} ${message?.hint ?? ""}`;
      expect(all.includes("已確認"), `狀態 ${state} 不該出現「已確認」`).toBe(false);
    }
  });

  it("sendWebPush 回 201(sent>0)但沒有 ack 時,畫面顯示的是「沒有收到你裝置的回報」", () => {
    // 這正是這個系統之前犯過的同一類錯(usePushSubscription.ts 檔頭記錄的「假成功訊息」):
    // 拿「我們把信交給郵局了」當成「對方收到了」。
    const message = describePushTestState("no_ack");
    expect(message?.text).toBe("通知已送出,但系統沒有收到你裝置的回報");
    expect(message?.tone).toBe("warning");
  });
});

describe("§6.3:狀態機的三種結果", () => {
  it("idle 不顯示任何文字", () => {
    expect(describePushTestState("idle")).toBeNull();
  });

  it("waiting → device_acked → clicked 的語氣逐步變強", () => {
    expect(describePushTestState("waiting")?.tone).toBe("muted");
    expect(describePushTestState("device_acked")?.tone).toBe("success");
    expect(describePushTestState("clicked")?.tone).toBe("success");
  });

  it("no_ack 會附上排查建議", () => {
    expect(describePushTestState("no_ack")?.hint).toContain("排查");
    expect(PUSH_TEST_TROUBLESHOOTING.length).toBeGreaterThanOrEqual(3);
  });

  it("等待回報的逾時是 15 秒(§6.3 第 4 點)", () => {
    expect(PUSH_TEST_ACK_TIMEOUT_MS).toBe(15_000);
  });
});

describe("§6.3 備援路徑:從網址讀 ack token", () => {
  it("讀得到 push_test_ack 參數", () => {
    expect(readPushTestAckTokenFromSearch("?push_test_ack=abc123")).toBe("abc123");
    expect(readPushTestAckTokenFromSearch("?a=1&push_test_ack=abc123&b=2")).toBe("abc123");
  });

  it("沒有參數或是空值時回 null", () => {
    expect(readPushTestAckTokenFromSearch("")).toBeNull();
    expect(readPushTestAckTokenFromSearch("?a=1")).toBeNull();
    expect(readPushTestAckTokenFromSearch("?push_test_ack=")).toBeNull();
    expect(readPushTestAckTokenFromSearch("?push_test_ack=%20%20")).toBeNull();
  });
});
