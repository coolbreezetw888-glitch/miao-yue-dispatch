// 站內通知中心(鈴鐺)純函式的單元測試。對應規格書 §十之二 的:
//   §13.5 未讀數(0 筆不顯示 badge / 1~99 顯示數字 / ≥100 顯示 99+)
//   §13.7 合併顯示的純函式、resolveNotificationLink 三種角色
import { describe, expect, it } from "vitest";

// 🔴 刻意從**另一個模組**把對照表 import 進來比對:§13.7 記載「目的地規則在推播端活在
//    Edge Function(Deno)裡、在鈴鐺端活在前端(Vite)裡,兩個執行環境不共用程式碼」,而前端這一側
//    其實已經有一份(pushPayload.ts 給 service worker 邏輯用的)。三份實作不共用是刻意的,
//    但**不可以靜默分岔** —— 這條測試就是那道防護。
import { PUSH_TARGET_URLS } from "@/modules/push-notifications/pushPayload";

import {
  formatRelativeNotificationTime,
  formatUnreadBadgeText,
  mergeNotificationRows,
  NOTIFICATION_TARGET_URLS,
  resolveNotificationLink,
} from "./notificationLink";
import { NOTIFICATION_TARGET_TYPES, type UserNotification } from "./types";

function makeRow(overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: "n1",
    user_id: "u1",
    merchant_id: "m1",
    target_type: "staff",
    target_id: "staff-1",
    event_type: "booking_created",
    booking_id: "b1",
    title: "新訂單通知",
    body: "2026-10-01 10:00 王小明",
    read_at: null,
    created_at: "2026-09-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveNotificationLink(§13.7)", () => {
  it("服務人員身份導到行事曆", () => {
    expect(resolveNotificationLink({ target_type: "staff" })).toBe("/app/calendar");
  });

  it("商家管理員身份導到訂單管理", () => {
    expect(resolveNotificationLink({ target_type: "admin" })).toBe("/app/orders");
  });

  it("客服身份導到訂單管理", () => {
    expect(resolveNotificationLink({ target_type: "agent" })).toBe("/app/orders");
  });

  it("認不出來的身份一律 fallback 到 /app(絕對不會回傳不存在的路由)", () => {
    expect(resolveNotificationLink({ target_type: "member" })).toBe("/app");
    expect(resolveNotificationLink({ target_type: null })).toBe("/app");
    expect(resolveNotificationLink({ target_type: undefined })).toBe("/app");
  });

  it("🔴 §5.5 單一事實來源:跟 push-notifications 的 PUSH_TARGET_URLS 三種角色完全一致", () => {
    // 這條測試存在的理由:兩份對照表分別服務「鈴鐺點擊」與「service worker 導頁」,
    // 只要有人改了其中一份、忘了另一份,使用者就會從兩個入口被帶到不同的頁面。
    for (const targetType of NOTIFICATION_TARGET_TYPES) {
      expect(NOTIFICATION_TARGET_URLS[targetType]!).toBe(PUSH_TARGET_URLS[targetType]);
    }
    // 順便釘住「沒有多出/少掉角色」。
    expect(Object.keys(NOTIFICATION_TARGET_URLS).sort()).toEqual(
      Object.keys(PUSH_TARGET_URLS).sort(),
    );
  });

  it("目的地一律不是 /app/my-calendar(§〇.5 那個死連結 bug 的回歸測試)", () => {
    for (const url of Object.values(NOTIFICATION_TARGET_URLS)) {
      expect(url).not.toBe("/app/my-calendar");
    }
  });
});

describe("formatUnreadBadgeText(§13.5 顯示規則)", () => {
  it("0 筆不顯示 badge(回 null)", () => {
    expect(formatUnreadBadgeText(0)).toBeNull();
  });

  it("1~99 顯示數字本身", () => {
    expect(formatUnreadBadgeText(1)).toBe("1");
    expect(formatUnreadBadgeText(7)).toBe("7");
    expect(formatUnreadBadgeText(99)).toBe("99");
  });

  it("100 筆以上顯示 99+", () => {
    expect(formatUnreadBadgeText(100)).toBe("99+");
    expect(formatUnreadBadgeText(5000)).toBe("99+");
  });

  it("還沒查到數字(undefined / null)時不顯示 badge", () => {
    expect(formatUnreadBadgeText(undefined)).toBeNull();
    expect(formatUnreadBadgeText(null)).toBeNull();
  });
});

describe("mergeNotificationRows(§13.2 邊界情況 / §13.7)", () => {
  it("同一人同店以兩個身份命中同一事件(同一分鐘)→ 顯示層合併成一列,標出兩個身份", () => {
    const rows: UserNotification[] = [
      makeRow({
        id: "n-agent",
        target_type: "agent",
        target_id: "agent-1",
        created_at: "2026-09-25T10:00:05.000Z",
      }),
      makeRow({
        id: "n-staff",
        target_type: "staff",
        target_id: "staff-1",
        created_at: "2026-09-25T10:00:01.000Z",
      }),
    ];
    const merged = mergeNotificationRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ids.sort()).toEqual(["n-agent", "n-staff"]);
    // 固定順序 admin → agent → staff,不受輸入順序影響。
    expect(merged[0]!.targetTypes).toEqual(["agent", "staff"]);
    // 導航用優先權較高的身份(agent > staff),跟 §5.5 的 PUSH_TARGET_PRIORITY 一致。
    expect(merged[0]!.primaryTargetType).toBe("agent");
    expect(resolveNotificationLink({ target_type: merged[0]!.primaryTargetType })).toBe(
      "/app/orders",
    );
  });

  it("合併後只要還有任何一列未讀,整列就算未讀", () => {
    const merged = mergeNotificationRows([
      makeRow({ id: "a", target_type: "agent", read_at: "2026-09-25T11:00:00.000Z" }),
      makeRow({ id: "b", target_type: "staff", read_at: null }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.read_at).toBeNull();
  });

  it("兩列都已讀時合併結果是已讀", () => {
    const merged = mergeNotificationRows([
      makeRow({ id: "a", target_type: "agent", read_at: "2026-09-25T11:00:00.000Z" }),
      makeRow({ id: "b", target_type: "staff", read_at: "2026-09-25T11:00:00.000Z" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.read_at).not.toBeNull();
  });

  it("跨過一分鐘就**不**合併(兩件不同時間發生的事不該被當成同一則)", () => {
    const merged = mergeNotificationRows([
      makeRow({ id: "a", target_type: "agent", created_at: "2026-09-25T10:01:30.000Z" }),
      makeRow({ id: "b", target_type: "staff", created_at: "2026-09-25T10:00:30.000Z" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("不同商家 / 不同訂單 / 不同事件都不合併", () => {
    expect(
      mergeNotificationRows([
        makeRow({ id: "a", merchant_id: "m1" }),
        makeRow({ id: "b", merchant_id: "m2", target_type: "agent" }),
      ]),
    ).toHaveLength(2);
    expect(
      mergeNotificationRows([
        makeRow({ id: "a", booking_id: "b1" }),
        makeRow({ id: "b", booking_id: "b2", target_type: "agent" }),
      ]),
    ).toHaveLength(2);
    expect(
      mergeNotificationRows([
        makeRow({ id: "a", event_type: "booking_created" }),
        makeRow({ id: "b", event_type: "booking_cancelled", target_type: "agent" }),
      ]),
    ).toHaveLength(2);
  });

  it("單一身份的列不會被加工:ids 只有自己、targetTypes 只有一個", () => {
    const merged = mergeNotificationRows([makeRow()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ids).toEqual(["n1"]);
    expect(merged[0]!.targetTypes).toEqual(["staff"]);
    expect(merged[0]!.title).toBe("新訂單通知");
  });

  it("回傳順序一律是最新的在前(呼叫端傳進未排序的資料也一樣)", () => {
    const merged = mergeNotificationRows([
      makeRow({ id: "old", booking_id: "b-old", created_at: "2026-09-20T10:00:00.000Z" }),
      makeRow({ id: "new", booking_id: "b-new", created_at: "2026-09-25T10:00:00.000Z" }),
    ]);
    expect(merged.map((m) => m.key)).toEqual(["new", "old"]);
  });

  it("booking_id 為 null(訂單被硬刪除)的列不會被誤併到一起", () => {
    const merged = mergeNotificationRows([
      makeRow({ id: "a", booking_id: null }),
      makeRow({ id: "b", booking_id: "b1", target_type: "agent" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("空陣列回空陣列", () => {
    expect(mergeNotificationRows([])).toEqual([]);
  });
});

describe("formatRelativeNotificationTime(§13.7)", () => {
  const now = new Date(2026, 8, 25, 14, 30, 0); // 2026-09-25 14:30 本地時間

  it("一分鐘內顯示「剛剛」", () => {
    expect(
      formatRelativeNotificationTime(new Date(2026, 8, 25, 14, 29, 30).toISOString(), now),
    ).toBe("剛剛");
  });

  it("一小時內顯示「N 分鐘前」", () => {
    expect(
      formatRelativeNotificationTime(new Date(2026, 8, 25, 14, 27, 0).toISOString(), now),
    ).toBe("3 分鐘前");
  });

  it("今天但超過一小時顯示時刻", () => {
    expect(formatRelativeNotificationTime(new Date(2026, 8, 25, 9, 5, 0).toISOString(), now)).toBe(
      "09:05",
    );
  });

  it("昨天顯示「昨天 HH:mm」", () => {
    expect(
      formatRelativeNotificationTime(new Date(2026, 8, 24, 14, 30, 0).toISOString(), now),
    ).toBe("昨天 14:30");
  });

  it("更早顯示「M/D HH:mm」", () => {
    expect(formatRelativeNotificationTime(new Date(2026, 8, 20, 8, 0, 0).toISOString(), now)).toBe(
      "9/20 08:00",
    );
  });

  it("壞掉的時間字串回空字串,不丟錯", () => {
    expect(formatRelativeNotificationTime("not-a-date", now)).toBe("");
  });
});
