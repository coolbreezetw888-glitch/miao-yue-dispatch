// 模組 15(手機推播通知)— pushDispatchCore.ts 的 Deno 測試。對應第十節「特別說明」跟
// 規則 4.3/4.6 的核心必測情境:三種跳過情境(event_disabled/no_target/no_subscription)、
// 404/410 清除訂閱、成功/部分成功/全部失敗的狀態判斷、寫入 push_notification_log 的內容。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次:§5.2 明文要求「不要刪掉既有測試再重寫一份」。
//    下面既有的 12 條測試**一條都沒有刪掉**,只做了介面上的最小幅度調整:
//      - 假 deps 的 getStaffSubscriptions → getSubscriptionsForUsers + resolveRecipients
//      - 斷言的 logs[0].staff_id → logs[0].target_type / logs[0].target_id
//    新情境(多角色、去重、personal_disabled、payload 組裝)寫在檔案後半段的「新增情境」區塊。

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildRecipientTitle,
  computeLogStatus,
  dispatchPushForBooking,
  pickPayloadForDevice,
  renderMessageTemplate,
  resolvePushUrlForTarget,
  shouldDeleteSubscriptionOnFailure,
  type PushDispatchDeps,
  type PushEventSettingRow,
  type PushNotificationLogInsert,
  type PushPayload,
  type PushRecipient,
  type PushSubscriptionRow,
  type UserNotificationInsert,
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
/** 預設情境:這筆訂單指派給 staff-1,而 staff-1 自己訂閱了這個事件、也有一台裝置。
 * 也就是改寫前那個「單一服務人員」的世界 —— 既有 12 條測試靠這個預設值維持原本的驗證意圖。 */
const STAFF_1_RECIPIENT: PushRecipient = {
  target_type: "staff",
  target_id: "staff-1",
  target_user_id: "user-staff-1",
  target_name: "服務人員甲",
};

function makeFakeDeps(overrides: Partial<PushDispatchDeps> = {}): {
  deps: PushDispatchDeps;
  logs: PushNotificationLogInsert[];
  deletedIds: string[];
  sentPayloads: { endpoint: string; payload: PushPayload }[];
  /** §13.4:站內通知中心(鈴鐺)寫進去的列。 */
  inAppNotifications: UserNotificationInsert[];
} {
  const logs: PushNotificationLogInsert[] = [];
  const deletedIds: string[] = [];
  const sentPayloads: { endpoint: string; payload: PushPayload }[] = [];
  const inAppNotifications: UserNotificationInsert[] = [];

  const defaultSetting: PushEventSettingRow = {
    enabled: true,
    message_title: "新訂單通知",
    message_body: "{{booking_date}} {{customer_name}}",
  };

  const defaultDeps: PushDispatchDeps = {
    getEventSetting: async () => defaultSetting,
    getBookingStaffId: async () => "staff-1",
    resolveRecipients: async (_m, _e, bookingStaffId) =>
      bookingStaffId === "staff-1" ? [STAFF_1_RECIPIENT] : [],
    getSubscriptionsForUsers: async (userIds: string[]) => {
      const map = new Map<string, PushSubscriptionRow[]>();
      if (userIds.includes("user-staff-1")) {
        map.set("user-staff-1", [
          { id: "sub-1", endpoint: "https://fcm.example/1", p256dh_key: "p1", auth_key: "a1" },
        ]);
      }
      return map;
    },
    isStaffEventDisabled: async () => false,
    deleteSubscription: async (id: string) => {
      deletedIds.push(id);
    },
    renderBookingVariables: async () => ({
      booking_date: "2026-10-01 10:00",
      customer_name: "王小明",
      merchant_name: "涼風工匠",
    }),
    writeLog: async (row: PushNotificationLogInsert) => {
      logs.push(row);
    },
    writeInAppNotification: async (row: UserNotificationInsert) => {
      inAppNotifications.push(row);
    },
    sendPush: async (subscription, payload) => {
      sentPayloads.push({ endpoint: subscription.endpoint, payload });
      return { ok: true, status: 201, errorDetail: null };
    },
  };

  return {
    deps: { ...defaultDeps, ...overrides },
    logs,
    deletedIds,
    sentPayloads,
    inAppNotifications,
  };
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
  assertEquals(logs[0].target_type, null);
  assertEquals(logs[0].target_id, null);
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
  assertEquals(result.dispatched, false);
  assertEquals(result.reason, "no_target");
  assertEquals(logs[0].skip_reason, "no_target");
  assertEquals(logs[0].target_type, null);
  assertEquals(logs[0].target_id, null);
});

Deno.test(
  "dispatchPushForBooking(核心必測):服務人員沒有任何訂閱,跳過,寫入 no_subscription",
  async () => {
    const { deps, logs } = makeFakeDeps({
      getSubscriptionsForUsers: async () => new Map<string, PushSubscriptionRow[]>(),
    });
    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });
    assertEquals(result.dispatched, false);
    assertEquals(result.reason, "no_subscription");
    assertEquals(logs[0].skip_reason, "no_subscription");
    assertEquals(logs[0].target_type, "staff");
    assertEquals(logs[0].target_id, "staff-1");
    // §5.2/§〇.11 的回歸斷言:改寫前「沒有裝置」時 rendered_title/body 是 null,因為套文案
    // 發生在提前 return 之後。現在套文案提前到裝置查詢之前,這兩個值必須有內容。
    assertEquals(logs[0].rendered_title, "新訂單通知");
    assertEquals(logs[0].rendered_body, "2026-10-01 10:00 王小明");
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
  const subs: PushSubscriptionRow[] = [
    { id: "sub-1", endpoint: "e1", p256dh_key: "p", auth_key: "a" },
    { id: "sub-2", endpoint: "e2", p256dh_key: "p", auth_key: "a" },
  ];
  let call = 0;
  const { deps, logs } = makeFakeDeps({
    getSubscriptionsForUsers: async () => new Map([["user-staff-1", subs]]),
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

// =========================================================================
// 2026-09-25「手機推播擴及三種角色」批次新增的情境(既有測試一條都沒動,只加在後面)。
// =========================================================================

const ADMIN_RECIPIENT: PushRecipient = {
  target_type: "admin",
  target_id: "admin-1",
  target_user_id: "user-admin-1",
  target_name: "老闆",
};
const AGENT_RECIPIENT: PushRecipient = {
  target_type: "agent",
  target_id: "agent-1",
  target_user_id: "user-agent-1",
  target_name: "客服",
};

Deno.test("§4.7:三種角色的點擊落點正確(修掉 /app/my-calendar 這個不存在的路由)", () => {
  assertEquals(resolvePushUrlForTarget("staff"), "/app/calendar");
  assertEquals(resolvePushUrlForTarget("admin"), "/app/orders");
  assertEquals(resolvePushUrlForTarget("agent"), "/app/orders");
});

Deno.test("§4.8:管理員/客服的標題有商家名稱前綴,服務人員沒有", () => {
  assertEquals(buildRecipientTitle("admin", "新訂單通知", "涼風工匠"), "涼風工匠·新訂單通知");
  assertEquals(buildRecipientTitle("agent", "新訂單通知", "涼風工匠"), "涼風工匠·新訂單通知");
  assertEquals(buildRecipientTitle("staff", "新訂單通知", "涼風工匠"), "新訂單通知");
  // 商家名稱查不到時不要生出一個開頭是「·」的怪標題。
  assertEquals(buildRecipientTitle("admin", "新訂單通知", null), "新訂單通知");
  assertEquals(buildRecipientTitle("admin", "新訂單通知", "   "), "新訂單通知");
});

Deno.test("§5.5:同一台裝置對應兩個身份時,取角色優先權較高的那一份 payload", () => {
  assertEquals(pickPayloadForDevice([STAFF_1_RECIPIENT, AGENT_RECIPIENT])?.target_type, "agent");
  assertEquals(pickPayloadForDevice([AGENT_RECIPIENT, ADMIN_RECIPIENT])?.target_type, "admin");
  assertEquals(pickPayloadForDevice([STAFF_1_RECIPIENT])?.target_type, "staff");
  assertEquals(pickPayloadForDevice([]), null);
});

Deno.test(
  "dispatchPushForBooking(§4.4 核心必測):管理員 + 客服 + 被指派服務人員三人同時收件,各寫一列 log",
  async () => {
    const { deps, logs, sentPayloads } = makeFakeDeps({
      resolveRecipients: async () => [STAFF_1_RECIPIENT, ADMIN_RECIPIENT, AGENT_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-staff-1", [{ id: "s1", endpoint: "e-staff", p256dh_key: "p", auth_key: "a" }]],
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
          ["user-agent-1", [{ id: "s3", endpoint: "e-agent", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.dispatched, true);
    assertEquals(result.recipientCount, 3);
    assertEquals(result.deviceCount, 3);
    assertEquals(logs.length, 3);
    assertEquals(logs.map((l) => l.target_type).sort(), ["admin", "agent", "staff"]);
    assertEquals(sentPayloads.length, 3);

    const staffPayload = sentPayloads.find((x) => x.endpoint === "e-staff")!.payload;
    const adminPayload = sentPayloads.find((x) => x.endpoint === "e-admin")!.payload;
    assertEquals(staffPayload.url, "/app/calendar");
    assertEquals(staffPayload.title, "新訂單通知");
    assertEquals(adminPayload.url, "/app/orders");
    assertEquals(adminPayload.title, "涼風工匠·新訂單通知");
  },
);

Deno.test(
  "dispatchPushForBooking(§4.4 核心必測):訂單完全沒有指派服務人員時,管理員照樣收得到",
  async () => {
    const { deps, logs, sentPayloads } = makeFakeDeps({
      getBookingStaffId: async () => null,
      resolveRecipients: async () => [ADMIN_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.dispatched, true);
    assertEquals(sentPayloads.length, 1);
    assertEquals(logs.length, 1);
    assertEquals(logs[0].target_type, "admin");
  },
);

Deno.test(
  "dispatchPushForBooking(§4.3 核心必測):一個人兩個身份共用同一台裝置 → sendPush 只呼叫一次、log 兩列",
  async () => {
    const dualAgent: PushRecipient = { ...AGENT_RECIPIENT, target_user_id: "user-dual" };
    const dualStaff: PushRecipient = { ...STAFF_1_RECIPIENT, target_user_id: "user-dual" };
    const { deps, logs, sentPayloads } = makeFakeDeps({
      resolveRecipients: async () => [dualStaff, dualAgent],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-dual", [{ id: "s1", endpoint: "e-phone", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    // 手機只跳一則(§4.3 第 2 點)。
    assertEquals(sentPayloads.length, 1);
    // 但 log 仍然一個身份一列(§4.3 第 3 點)。
    assertEquals(logs.length, 2);
    assertEquals(result.recipientCount, 2);
    // 這裡刻意留一條斷言釘住「sum(success_count) 會偏大」這件事:兩列各記 1,實際只送出一則。
    assertEquals(logs.reduce((acc, l) => acc + l.success_count, 0), 2);
    // §5.5:同一台裝置取優先權較高的 agent payload。
    assertEquals(sentPayloads[0].payload.url, "/app/orders");
    assertEquals(sentPayloads[0].payload.title, "涼風工匠·新訂單通知");
  },
);

Deno.test(
  "dispatchPushForBooking(§4.2 第 3 點):被指派的服務人員自己關掉事件 → 補寫一列 personal_disabled",
  async () => {
    const { deps, logs } = makeFakeDeps({
      resolveRecipients: async () => [],
      isStaffEventDisabled: async () => true,
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.dispatched, false);
    assertEquals(result.reason, "no_recipient");
    assertEquals(logs.length, 2);
    assertEquals(logs[0].skip_reason, "personal_disabled");
    assertEquals(logs[0].target_type, "staff");
    assertEquals(logs[0].target_id, "staff-1");
    assertEquals(logs[1].skip_reason, "no_recipient");
  },
);

Deno.test(
  "dispatchPushForBooking(§4.2/§5.3):全店沒有一個人打開這個事件 → no_recipient,不寫 personal_disabled",
  async () => {
    const { deps, logs } = makeFakeDeps({ resolveRecipients: async () => [] });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.reason, "no_recipient");
    assertEquals(logs.length, 1);
    assertEquals(logs[0].skip_reason, "no_recipient");
    assertEquals(logs[0].target_type, null);
  },
);

Deno.test(
  "dispatchPushForBooking(§5.4/裁決 Q2):排程提醒只發給服務人員,管理員就算打開也不會被納入",
  async () => {
    const { deps, logs, sentPayloads } = makeFakeDeps({
      resolveRecipients: async () => [STAFF_1_RECIPIENT, ADMIN_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-staff-1", [{ id: "s1", endpoint: "e-staff", p256dh_key: "p", auth_key: "a" }]],
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_reminder_next_day",
      onlyStaffRecipients: true,
    });

    assertEquals(sentPayloads.length, 1);
    assertEquals(sentPayloads[0].endpoint, "e-staff");
    assertEquals(logs.length, 1);
    assertEquals(logs[0].target_type, "staff");
  },
);

Deno.test(
  "dispatchPushForBooking(規則 4.6):多收件人時,某一台裝置回 410 只刪那一台,其他人不受影響",
  async () => {
    const { deps, logs, deletedIds } = makeFakeDeps({
      resolveRecipients: async () => [STAFF_1_RECIPIENT, ADMIN_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-staff-1", [{ id: "s1", endpoint: "e-staff", p256dh_key: "p", auth_key: "a" }]],
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
        ]),
      sendPush: async (subscription) =>
        subscription.endpoint === "e-staff"
          ? { ok: false, status: 410, errorDetail: "gone" }
          : { ok: true, status: 201, errorDetail: null },
    });

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(deletedIds, ["s1"]);
    const staffLog = logs.find((l) => l.target_type === "staff")!;
    const adminLog = logs.find((l) => l.target_type === "admin")!;
    assertEquals(staffLog.status, "failed");
    assertEquals(adminLog.status, "sent");
  },
);

Deno.test(
  "dispatchPushForBooking:有收件人但其中一位一台裝置都沒有 → 那一位寫 no_subscription,其他人照常送",
  async () => {
    const { deps, logs, sentPayloads } = makeFakeDeps({
      resolveRecipients: async () => [STAFF_1_RECIPIENT, ADMIN_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.dispatched, true);
    assertEquals(sentPayloads.length, 1);
    const staffLog = logs.find((l) => l.target_type === "staff")!;
    assertEquals(staffLog.skip_reason, "no_subscription");
    assertEquals(staffLog.device_count, 0);
    assertEquals(staffLog.rendered_title, "新訂單通知");
  },
);

// =========================================================================
// §13.4 站內通知中心(鈴鐺)的寫入時機 —— 對應規格書 §十之二 的兩列:
//   「§13.4 寫入時機」四個情境 + 「§13.4 一對一」。
//
// 這一組測試的核心命題只有一句:**「你會收到推播的那些通知,都會留在鈴鐺裡」** —— 而且
// 「會收到」指的是「你是收件人」,不是「推播真的送成功」。所以推播失敗、甚至一台裝置都沒有,
// 站內通知都要在;只有「他根本不是收件人」才不寫。
// =========================================================================

Deno.test("§13.4(核心必測):推播送失敗(sendPush 回 500)時,站內通知照樣存在", async () => {
  const { deps, logs, inAppNotifications } = makeFakeDeps({
    sendPush: async () => ({ ok: false, status: 500, errorDetail: "boom" }),
  });

  await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });

  assertEquals(logs.length, 1);
  assertEquals(logs[0].status, "failed");
  // 這才是重點:發送結果是 failed,站內通知照樣有一列。
  assertEquals(inAppNotifications.length, 1);
  assertEquals(inAppNotifications[0].title, "新訂單通知");
  assertEquals(inAppNotifications[0].body, "2026-10-01 10:00 王小明");
});

Deno.test("§13.4(核心必測):裝置失效被清除(sendPush 回 410)時,站內通知照樣存在", async () => {
  const { deps, deletedIds, inAppNotifications } = makeFakeDeps({
    sendPush: async () => ({ ok: false, status: 410, errorDetail: "gone" }),
  });

  await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });

  assertEquals(deletedIds, ["sub-1"]);
  assertEquals(inAppNotifications.length, 1);
});

Deno.test(
  "🔴 §13.4(核心必測,§〇.11 順序陷阱的回歸測試):收件人一台裝置都沒有時,站內通知存在**而且 title/body 不是空字串**",
  async () => {
    // 這一條守的是「套文案必須在裝置查詢之前」。如果有人把 renderMessageTemplate 搬回
    // 「查裝置 → 沒有裝置就 return → 才套文案」的舊順序,這一條會立刻紅:不是筆數不對,
    // 而是 title/body 變成空字串(或這一列根本不存在)。
    const { deps, logs, sentPayloads, inAppNotifications } = makeFakeDeps({
      getSubscriptionsForUsers: async () => new Map<string, PushSubscriptionRow[]>(),
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.dispatched, false);
    assertEquals(result.reason, "no_subscription");
    assertEquals(sentPayloads.length, 0);
    assertEquals(logs.length, 1);
    assertEquals(logs[0].skip_reason, "no_subscription");

    // 一台裝置都沒有,站內通知**正是他唯一看得到的東西**。
    assertEquals(inAppNotifications.length, 1);
    assertEquals(inAppNotifications[0].title, "新訂單通知");
    assertEquals(inAppNotifications[0].body, "2026-10-01 10:00 王小明");
    assertEquals(inAppNotifications[0].title.length > 0, true);
    assertEquals(inAppNotifications[0].body.length > 0, true);
    // 變數真的被套進去了,不是留著未替換的原樣。
    assertEquals(inAppNotifications[0].body.includes("{{"), false);
  },
);

Deno.test("§13.4(核心必測):商家總開關關閉時,**一列站內通知都不寫**", async () => {
  const { deps, logs, inAppNotifications } = makeFakeDeps({
    getEventSetting: async () => ({ enabled: false, message_title: "x", message_body: "y" }),
  });

  await dispatchPushForBooking(deps, {
    merchantId: "m1",
    bookingId: "b1",
    eventType: "booking_created",
  });

  assertEquals(logs.length, 1);
  assertEquals(logs[0].skip_reason, "event_disabled");
  // Q8 裁決 A:鈴鐺跟推播同一套規則 —— 商家關掉總開關,鈴鐺也不該繼續累積。
  assertEquals(inAppNotifications.length, 0);
});

Deno.test(
  "§13.4(核心必測):個人開關關閉的人**沒有**站內通知(連 personal_disabled 那一列也不寫)",
  async () => {
    const { deps, logs, inAppNotifications } = makeFakeDeps({
      resolveRecipients: async () => [],
      isStaffEventDisabled: async () => true,
    });

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    // log 有兩列(personal_disabled + no_recipient),但這兩列都是「跳過」類,不是收件人。
    assertEquals(logs.length, 2);
    assertEquals(inAppNotifications.length, 0);
  },
);

Deno.test(
  "§13.4(核心必測):no_target 這種跳過類的情形,一列站內通知都不寫",
  async () => {
    const { deps, logs, inAppNotifications } = makeFakeDeps({
      getBookingStaffId: async () => null,
      resolveRecipients: async () => [],
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    assertEquals(result.reason, "no_target");
    assertEquals(logs.length, 1);
    assertEquals(inAppNotifications.length, 0);
  },
);

Deno.test(
  "§13.4 一對一(核心必測):三個收件人 → 三列 log + 三列站內通知,而 sendPush 因去重只被呼叫一次",
  async () => {
    // 三個身份全部屬於同一個登入帳號、共用同一台裝置(§〇.6 雙重身份 + 同時也是管理員的極端情形)。
    const dualStaff: PushRecipient = { ...STAFF_1_RECIPIENT, target_user_id: "user-dual" };
    const dualAgent: PushRecipient = { ...AGENT_RECIPIENT, target_user_id: "user-dual" };
    const dualAdmin: PushRecipient = { ...ADMIN_RECIPIENT, target_user_id: "user-dual" };

    const { deps, logs, sentPayloads, inAppNotifications } = makeFakeDeps({
      resolveRecipients: async () => [dualStaff, dualAgent, dualAdmin],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-dual", [{ id: "s1", endpoint: "e-phone", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    // §4.3 的既有斷言:手機只跳一則。
    assertEquals(sentPayloads.length, 1);
    // §13.4 的新斷言:log 三列、站內通知三列,一對一。
    assertEquals(logs.length, 3);
    assertEquals(inAppNotifications.length, 3);
    assertEquals(inAppNotifications.map((n) => n.target_type).sort(), ["admin", "agent", "staff"]);
    assertEquals(inAppNotifications.map((n) => n.target_id).sort(), [
      "admin-1",
      "agent-1",
      "staff-1",
    ]);
    // 三列都是同一個登入帳號(鈴鐺的 RLS 就是靠 user_id)。
    assertEquals(
      inAppNotifications.every((n) => n.user_id === "user-dual"),
      true,
    );
  },
);

Deno.test(
  "§13.2:站內通知的欄位內容 —— 只存 event_type/target_type/booking_id,刻意沒有目的地網址",
  async () => {
    const { deps, inAppNotifications } = makeFakeDeps();

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_updated",
      changeSummary: "時間改成 11:00",
    });

    assertEquals(inAppNotifications.length, 1);
    const row = inAppNotifications[0];
    assertEquals(row.merchant_id, "m1");
    assertEquals(row.booking_id, "b1");
    assertEquals(row.event_type, "booking_updated");
    assertEquals(row.target_type, "staff");
    assertEquals(row.target_id, "staff-1");
    assertEquals(row.user_id, "user-staff-1");
    // 刻意不存 url —— 目的地由前端用純函式即時算(§13.2 的 ⚠️、§〇.5 的教訓)。
    assertEquals("url" in (row as unknown as Record<string, unknown>), false);
  },
);

Deno.test(
  "§13.2:站內通知的 title 是 rendered_title 本身,**不含** §4.8 給管理員/客服加的商家名稱前綴",
  async () => {
    const { deps, logs, sentPayloads, inAppNotifications } = makeFakeDeps({
      resolveRecipients: async () => [ADMIN_RECIPIENT],
      getSubscriptionsForUsers: async () =>
        new Map<string, PushSubscriptionRow[]>([
          ["user-admin-1", [{ id: "s2", endpoint: "e-admin", p256dh_key: "p", auth_key: "a" }]],
        ]),
    });

    await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    // 手機通知列上要有前綴(那裡分不出是哪一間店)。
    assertEquals(sentPayloads[0].payload.title, "涼風工匠·新訂單通知");
    // 站內通知跟 push_notification_log.rendered_title 是同一份內容(面板本身會顯示商家名稱)。
    assertEquals(logs[0].rendered_title, "新訂單通知");
    assertEquals(inAppNotifications[0].title, "新訂單通知");
  },
);

Deno.test(
  "🔴 §13.4:站內通知寫入**在 sendPush 之前**,而且寫失敗絕對不能讓推播不發",
  async () => {
    const order: string[] = [];
    const { deps } = makeFakeDeps({
      writeInAppNotification: async () => {
        order.push("in-app");
        // 刻意丟例外:模擬 user_notifications 這張表暫時寫不進去(例如 migration 還沒套用)。
        throw new Error("user_notifications 寫入失敗");
      },
      sendPush: async () => {
        order.push("push");
        return { ok: true, status: 201, errorDetail: null };
      },
    });

    const result = await dispatchPushForBooking(deps, {
      merchantId: "m1",
      bookingId: "b1",
      eventType: "booking_created",
    });

    // ① 順序:站內通知先寫,推播後送。
    assertEquals(order, ["in-app", "push"]);
    // ② 站內通知寫失敗,推播照樣送成功 —— 這是 §13.4 最後一段的硬性要求。
    assertEquals(result.dispatched, true);
    assertEquals(result.successCount, 1);
  },
);
