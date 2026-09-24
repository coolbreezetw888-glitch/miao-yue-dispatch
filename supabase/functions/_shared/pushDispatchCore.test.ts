// 模組 15(服務人員推播通知)— pushDispatchCore.ts 的 Deno 測試。對應第十節「特別說明」跟
// 規則 4.3/4.6 的核心必測情境:三種跳過情境(event_disabled/no_target/no_subscription)、
// 404/410 清除訂閱、成功/部分成功/全部失敗的狀態判斷、寫入 push_notification_log 的內容。

import { assertEquals } from "jsr:@std/assert@1";
import {
  computeLogStatus,
  dispatchPushForBooking,
  renderMessageTemplate,
  shouldDeleteSubscriptionOnFailure,
  type PushDispatchDeps,
  type PushEventSettingRow,
  type PushNotificationLogInsert,
  type StaffPushSubscriptionRow,
} from "./pushDispatchCore.ts";

Deno.test("renderMessageTemplate: 涵蓋所有已定義變數,正確替換", () => {
  const result = renderMessageTemplate("{{booking_date}} {{customer_name}}‧{{service_names}}", {
    booking_date: "2026-10-01 10:00",
    customer_name: "王小明",
    service_names: "洗髮、剪髮",
  });
  assertEquals(result, "2026-10-01 10:00 王小明‧洗髮、剪髮");
});

Deno.test("renderMessageTemplate: 缺值情境保留原樣不報錯", () => {
  const result = renderMessageTemplate("{{change_summary}}", {});
  assertEquals(result, "{{change_summary}}");
});

Deno.test("shouldDeleteSubscriptionOnFailure: 404/410 回傳 true", () => {
  assertEquals(shouldDeleteSubscriptionOnFailure(404), true);
  assertEquals(shouldDeleteSubscriptionOnFailure(410), true);
});

Deno.test("shouldDeleteSubscriptionOnFailure: 其他狀態碼(暫時性錯誤)回傳 false", () => {
  assertEquals(shouldDeleteSubscriptionOnFailure(500), false);
  assertEquals(shouldDeleteSubscriptionOnFailure(0), false);
  assertEquals(shouldDeleteSubscriptionOnFailure(200), false);
});

Deno.test("computeLogStatus: 全部成功為 sent", () => {
  assertEquals(computeLogStatus(3, 3), "sent");
});
Deno.test("computeLogStatus: 部分成功為 partially_sent", () => {
  assertEquals(computeLogStatus(3, 1), "partially_sent");
});
Deno.test("computeLogStatus: 全部失敗為 failed", () => {
  assertEquals(computeLogStatus(3, 0), "failed");
});
Deno.test("computeLogStatus: 裝置數 0 也視為 failed(防禦性)", () => {
  assertEquals(computeLogStatus(0, 0), "failed");
});

// =========================================================================
// dispatchPushForBooking:核心編排邏輯,用假的 deps 驗證(不需要真正的資料庫/網路)。
// =========================================================================
function makeFakeDeps(overrides: Partial<PushDispatchDeps> = {}): {
  deps: PushDispatchDeps;
  logs: PushNotificationLogInsert[];
  deletedIds: string[];
} {
  const logs: PushNotificationLogInsert[] = [];
  const deletedIds: string[] = [];

  const defaultSetting: PushEventSettingRow = {
    enabled: true,
    message_title: "新訂單通知",
    message_body: "{{booking_date}} {{customer_name}}",
  };

  const defaultDeps: PushDispatchDeps = {
    getEventSetting: async () => defaultSetting,
    getBookingStaffId: async () => "staff-1",
    getStaffSubscriptions: async () => [
      { id: "sub-1", endpoint: "https://fcm.example/1", p256dh_key: "p1", auth_key: "a1" },
    ],
    deleteSubscription: async (id: string) => {
      deletedIds.push(id);
    },
    renderBookingVariables: async () => ({
      booking_date: "2026-10-01 10:00",
      customer_name: "王小明",
    }),
    writeLog: async (row: PushNotificationLogInsert) => {
      logs.push(row);
    },
    sendPush: async () => ({ ok: true, status: 201, errorDetail: null }),
  };

  return { deps: { ...defaultDeps, ...overrides }, logs, deletedIds };
}

Deno.test("dispatchPushForBooking(核心必測):事件關閉時跳過,寫入 event_disabled", async () => {
  const { deps, logs } = makeFakeDeps({
    getEventSetting: async () => ({ enabled: false, message_title: "x", message_body: "y" }),
  });
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result, { dispatched: false, reason: "event_disabled" });
  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, "skipped");
  assertEquals(logs[0].skip_reason, "event_disabled");
  assertEquals(logs[0].staff_id, null);
});

Deno.test("dispatchPushForBooking(核心必測):查無事件設定(尚未種子)視同關閉,跳過", async () => {
  const { deps, logs } = makeFakeDeps({ getEventSetting: async () => null });
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result.reason, "event_disabled");
  assertEquals(logs[0].skip_reason, "event_disabled");
});

Deno.test("dispatchPushForBooking(核心必測):訂單沒有指定服務人員,跳過,寫入 no_target", async () => {
  const { deps, logs } = makeFakeDeps({ getBookingStaffId: async () => null });
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result, { dispatched: false, reason: "no_target" });
  assertEquals(logs[0].skip_reason, "no_target");
  assertEquals(logs[0].staff_id, null);
});

Deno.test(
  "dispatchPushForBooking(核心必測):服務人員沒有任何訂閱,跳過,寫入 no_subscription",
  async () => {
    const { deps, logs } = makeFakeDeps({ getStaffSubscriptions: async () => [] });
    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });
    assertEquals(result, { dispatched: false, reason: "no_subscription" });
    assertEquals(logs[0].skip_reason, "no_subscription");
    assertEquals(logs[0].staff_id, "staff-1");
  },
);

Deno.test("dispatchPushForBooking:全部裝置成功,寫入 sent,不刪除任何訂閱", async () => {
  const { deps, logs, deletedIds } = makeFakeDeps();
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result.dispatched, true);
  assertEquals(logs[0].status, "sent");
  assertEquals(logs[0].device_count, 1);
  assertEquals(logs[0].success_count, 1);
  assertEquals(logs[0].rendered_title, "新訂單通知");
  assertEquals(logs[0].rendered_body, "2026-10-01 10:00 王小明");
  assertEquals(deletedIds.length, 0);
});

Deno.test("dispatchPushForBooking(核心必測):多裝置部分成功,寫入 partially_sent", async () => {
  const subs: StaffPushSubscriptionRow[] = [
    { id: "sub-1", endpoint: "e1", p256dh_key: "p", auth_key: "a" },
    { id: "sub-2", endpoint: "e2", p256dh_key: "p", auth_key: "a" },
  ];
  let call = 0;
  const { deps, logs } = makeFakeDeps({
    getStaffSubscriptions: async () => subs,
    sendPush: async () => {
      call += 1;
      return call === 1
        ? { ok: true, status: 201, errorDetail: null }
        : { ok: false, status: 500, errorDetail: "暫時性錯誤" };
    },
  });
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result.deviceCount, 2);
  assertEquals(result.successCount, 1);
  assertEquals(logs[0].status, "partially_sent");
  assertEquals(logs[0].error_detail, "暫時性錯誤");
});

Deno.test("dispatchPushForBooking(核心必測,規則 4.6):404 回應時刪除該筆訂閱", async () => {
  const { deps, logs, deletedIds } = makeFakeDeps({
    sendPush: async () => ({ ok: false, status: 404, errorDetail: "gone" }),
  });
  const result = await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(result.successCount, 0);
  assertEquals(logs[0].status, "failed");
  assertEquals(deletedIds, ["sub-1"]);
});

Deno.test("dispatchPushForBooking(核心必測,規則 4.6):410 回應時也刪除該筆訂閱", async () => {
  const { deps, deletedIds } = makeFakeDeps({
    sendPush: async () => ({ ok: false, status: 410, errorDetail: "gone" }),
  });
  await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(deletedIds, ["sub-1"]);
});

Deno.test("dispatchPushForBooking(核心必測,規則 4.6):500 暫時性錯誤不刪除訂閱", async () => {
  const { deps, deletedIds } = makeFakeDeps({
    sendPush: async () => ({ ok: false, status: 500, errorDetail: "server error" }),
  });
  await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });
  assertEquals(deletedIds, []);
});

Deno.test(
  "dispatchPushForBooking(規則 4.5):booking_updated 事件把 changeSummary 併入 {{change_summary}}",
  async () => {
    const { deps, logs } = makeFakeDeps({
      getEventSetting: async () => ({
        enabled: true,
        message_title: "訂單內容異動",
        message_body: "{{booking_date}} {{customer_name}}:{{change_summary}}",
      }),
    });
    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_updated",
      changeSummary: "預約時間改為 09/26 15:00",
    });
    assertEquals(logs[0].rendered_body, "2026-10-01 10:00 王小明:預約時間改為 09/26 15:00");
  },
);

Deno.test(
  "dispatchPushForBooking:非 booking_updated 事件即使傳了 changeSummary 也不影響渲染(沒有這個變數鍵)",
  async () => {
    const { deps, logs } = makeFakeDeps();
    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
      changeSummary: "不應該出現",
    });
    assertEquals(logs[0].rendered_body, "2026-10-01 10:00 王小明");
  },
);
