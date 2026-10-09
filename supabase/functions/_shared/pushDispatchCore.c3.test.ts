// 客戶端第 3 批 C3-C02:dispatchPushForBooking 兩個可選參數 skipInAppNotification / messageOverride。
// 不帶時行為完全不變(既有 pushDispatchCore.test.ts 全部照舊通過;這裡另外用同一組假資料比對「不帶」與「帶 false / null」結果一致)。
import { assertEquals } from "jsr:@std/assert";
import {
  dispatchPushForBooking,
  type DispatchPushForBookingParams,
  type PushDispatchDeps,
  type PushNotificationLogInsert,
  type PushPayload,
  type UserNotificationInsert,
} from "./pushDispatchCore.ts";

function makeDeps() {
  const bells: UserNotificationInsert[] = [];
  const logs: PushNotificationLogInsert[] = [];
  const sent: PushPayload[] = [];
  const deps: PushDispatchDeps = {
    isPushFeatureEnabled: () => Promise.resolve(true),
    getEventSetting: () => Promise.resolve({ enabled: true, message_title: "新訂單 {{customer_name}}", message_body: "範本內文 {{booking_date}}" }),
    getBookingStaffId: () => Promise.resolve("staff-1"),
    resolveRecipients: () =>
      Promise.resolve([
        { target_type: "admin", target_id: "admin-1", target_user_id: "u-admin", target_name: "管理員" },
        { target_type: "staff", target_id: "staff-1", target_user_id: "u-staff", target_name: "阿明" },
      ]),
    getSubscriptionsForUsers: () =>
      Promise.resolve(new Map([
        ["u-admin", [{ id: "s1", endpoint: "https://push/a", p256dh_key: "k", auth_key: "a" }]],
        ["u-staff", [{ id: "s2", endpoint: "https://push/s", p256dh_key: "k", auth_key: "a" }]],
      ])),
    isStaffEventDisabled: () => Promise.resolve(false),
    deleteSubscription: () => Promise.resolve(),
    renderBookingVariables: () => Promise.resolve({ customer_name: "王小明", booking_date: "10/13", merchant_name: "涼風工匠" }),
    writeLog: (row) => {
      logs.push(row);
      return Promise.resolve();
    },
    writeInAppNotification: (row) => {
      bells.push(row);
      return Promise.resolve();
    },
    sendPush: (_sub, payload) => {
      sent.push(payload);
      return Promise.resolve({ ok: true, status: 201, errorDetail: null });
    },
  };
  return { deps, bells, logs, sent };
}

const BASE: DispatchPushForBookingParams = { merchantId: "m-1", bookingId: "b-1", eventType: "booking_created" };

Deno.test("C3-C02 不帶新參數 / 帶 false、null ⇒ 結果完全一樣(既有行為不變)", async () => {
  const a = makeDeps();
  const ra = await dispatchPushForBooking(a.deps, BASE);
  const b = makeDeps();
  const rb = await dispatchPushForBooking(b.deps, { ...BASE, skipInAppNotification: false, messageOverride: null });
  assertEquals(ra, rb);
  assertEquals(a.bells, b.bells);
  assertEquals(a.logs, b.logs);
  assertEquals(a.sent, b.sent);
  assertEquals(a.bells.length, 2);
  assertEquals(a.sent.map((p) => p.title).sort(), ["新訂單 王小明", "涼風工匠·新訂單 王小明"]);
});

Deno.test("C3-C02 skipInAppNotification ⇒ 不寫鈴鐺,推播與 log 照舊", async () => {
  const a = makeDeps();
  await dispatchPushForBooking(a.deps, { ...BASE, skipInAppNotification: true });
  assertEquals(a.bells.length, 0);
  assertEquals(a.sent.length, 2);
  assertEquals(a.logs.map((l) => l.status), ["sent", "sent"]);
});

Deno.test("C3-C02 messageOverride ⇒ 推播與 log 用這組文字(不套商家範本);管理員標題仍加商家名稱前綴", async () => {
  const a = makeDeps();
  await dispatchPushForBooking(a.deps, {
    ...BASE,
    skipInAppNotification: true,
    messageOverride: { title: "新的線上預約（待確認）", body: "客人「王小明」預約 10/13（二）10:00。訪客預約（未登入），請自行與客戶電話確認。" },
  });
  assertEquals(a.sent.map((p) => `${p.title}|${p.body}`).sort(), [
    "新的線上預約（待確認）|客人「王小明」預約 10/13（二）10:00。訪客預約（未登入），請自行與客戶電話確認。",
    "涼風工匠·新的線上預約（待確認）|客人「王小明」預約 10/13（二）10:00。訪客預約（未登入），請自行與客戶電話確認。",
  ]);
  assertEquals([...new Set(a.logs.map((l) => l.rendered_title))], ["新的線上預約（待確認）"]);
});

Deno.test("C3-C02 商家總開關關閉 ⇒ 帶了新參數也一樣整件事跳過(照店家既有推播設定)", async () => {
  const a = makeDeps();
  a.deps.getEventSetting = () => Promise.resolve({ enabled: false, message_title: "", message_body: "" });
  const r = await dispatchPushForBooking(a.deps, { ...BASE, skipInAppNotification: true, messageOverride: { title: "t", body: "b" } });
  assertEquals(r, { dispatched: false, reason: "event_disabled" });
  assertEquals(a.sent.length, 0);
});
