// 站內通知中心(鈴鐺)純函式的單元測試。對應規格書 §十之二 的:
//   §13.5 未讀數(0 筆不顯示 badge / 1~99 顯示數字 / ≥100 顯示 99+)
//   §13.7 合併顯示的純函式、resolveNotificationLink 三種角色
import { describe, expect, it } from "vitest";

// 🔴 刻意從**另一個模組**把對照表 import 進來比對:§13.7 記載「目的地規則在推播端活在
//    Edge Function(Deno)裡、在鈴鐺端活在前端(Vite)裡,兩個執行環境不共用程式碼」,而前端這一側
//    其實已經有一份(pushPayload.ts 給 service worker 邏輯用的)。三份實作不共用是刻意的,
//    但**不可以靜默分岔** —— 這條測試就是那道防護。
import { PUSH_TARGET_URLS } from "@/modules/push-notifications/pushPayload";

import { PUSH_NOTIFICATION_EVENT_LABELS } from "@/modules/push-notifications/types";

import {
  BELL_ONLY_EVENT_LABELS,
  COMPLETED_CANCELLATION_MERGE_WINDOW_MS,
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

// #986 第 9 批(9-16):服務人員確認接單後,有「訂單管理」權限的客服也會收到 booking_confirmed(target_type agent)。
describe("確認接單鈴鐺給客服(#986 第 9 批)", () => {
  it("agent + booking_confirmed ⇒ 點下去到 /app/orders(跟管理員那則同一個目的地)", () => {
    expect(resolveNotificationLink({ target_type: "agent" })).toBe("/app/orders");
    expect(resolveNotificationLink({ target_type: "admin" })).toBe("/app/orders");
  });

  it("同一則確認接單同時以 agent 身分存在時,合併後仍算得出 /app/orders", () => {
    const row = {
      id: "n-agent",
      user_id: "u1",
      merchant_id: "m1",
      target_type: "agent",
      target_id: "agent-1",
      event_type: "booking_confirmed",
      booking_id: "b1",
      title: "服務人員已確認訂單",
      body: "服務人員「甲」已確認 2036/01/05 10:00「陳小美」的訂單。",
      read_at: null,
      created_at: "2036-01-05T02:00:00Z",
    } as unknown as UserNotification;
    const merged = mergeNotificationRows([row]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.primaryTargetType).toBe("agent");
    expect(resolveNotificationLink({ target_type: merged[0]!.primaryTargetType })).toBe(
      "/app/orders",
    );
  });
});

// SPECS-INDEX #997 第 11 批 H:已完成訂單被取消 / 被還原的鈴鐺。
describe("#997 第 11 批 H:新事件標籤", () => {
  it("兩個新標籤只在鈴鐺專用清單,不進推播設定(否則推播設定頁會多兩張不能用的卡)", () => {
    expect(BELL_ONLY_EVENT_LABELS["booking_completed_cancelled"]).toBe("已完成訂單被取消時");
    expect(BELL_ONLY_EVENT_LABELS["booking_completed_reverted"]).toBe("已完成訂單被還原時");
    expect(Object.keys(PUSH_NOTIFICATION_EVENT_LABELS)).not.toContain(
      "booking_completed_cancelled",
    );
    expect(Object.keys(PUSH_NOTIFICATION_EVENT_LABELS)).not.toContain("booking_completed_reverted");
  });
});

describe("#997 第 11 批 H:booking_cancelled 併進 booking_completed_cancelled(§15.4)", () => {
  const completedRow = (overrides: Partial<UserNotification> = {}) =>
    makeRow({
      id: "db",
      target_type: "admin",
      event_type: "booking_completed_cancelled",
      title: "已完成訂單被取消",
      body: "管理員甲 將 2027/03/03 10:00「客戶二號」的已完成訂單取消。原因：客人不要了",
      created_at: "2026-10-07T10:00:00.000Z",
      read_at: "2026-10-07T10:05:00.000Z",
      ...overrides,
    });
  const pushRow = (overrides: Partial<UserNotification> = {}) =>
    makeRow({
      id: "push",
      target_type: "admin",
      event_type: "booking_cancelled",
      title: "預約已取消",
      body: "推播那則",
      created_at: "2026-10-07T10:01:30.000Z",
      read_at: "2026-10-07T10:05:00.000Z",
      ...overrides,
    });

  it("時間窗是 120 秒", () => {
    expect(COMPLETED_CANCELLATION_MERGE_WINDOW_MS).toBe(120_000);
  });

  it("① 120 秒內、同一張訂單 ⇒ 併成一組:ids 兩個、顯示 completed 那組的標題 / 內文 / 時間", () => {
    const merged = mergeNotificationRows([pushRow(), completedRow()]);
    expect(merged).toHaveLength(1);
    expect([...merged[0]!.ids].sort()).toEqual(["db", "push"]);
    expect(merged[0]!.event_type).toBe("booking_completed_cancelled");
    expect(merged[0]!.title).toBe("已完成訂單被取消");
    expect(merged[0]!.body).toContain("的已完成訂單取消。");
    expect(merged[0]!.created_at).toBe("2026-10-07T10:00:00.000Z");
    expect(merged[0]!.key).toBe("db");
  });

  it("① 剛好 120 秒、差 0 秒都算", () => {
    expect(
      mergeNotificationRows([pushRow({ created_at: "2026-10-07T10:02:00.000Z" }), completedRow()]),
    ).toHaveLength(1);
    expect(
      mergeNotificationRows([pushRow({ created_at: "2026-10-07T10:00:00.000Z" }), completedRow()]),
    ).toHaveLength(1);
  });

  it("② 121 秒 ⇒ 兩組各自顯示", () => {
    expect(
      mergeNotificationRows([pushRow({ created_at: "2026-10-07T10:02:01.000Z" }), completedRow()]),
    ).toHaveLength(2);
  });

  it("③ 不同訂單 ⇒ 兩組", () => {
    expect(mergeNotificationRows([pushRow({ booking_id: "b2" }), completedRow()])).toHaveLength(2);
  });

  it("③ 不同商家 ⇒ 兩組", () => {
    expect(mergeNotificationRows([pushRow({ merchant_id: "m2" }), completedRow()])).toHaveLength(2);
  });

  it("④ booking_cancelled 比 completed 早 ⇒ 兩組", () => {
    expect(
      mergeNotificationRows([pushRow({ created_at: "2026-10-07T09:59:59.000Z" }), completedRow()]),
    ).toHaveLength(2);
  });

  it("⑤ 任一列未讀 ⇒ 整組未讀(兩種方向都驗)", () => {
    const a = mergeNotificationRows([pushRow({ read_at: null }), completedRow()]);
    expect(a).toHaveLength(1);
    expect(a[0]!.read_at).toBeNull();
    const b = mergeNotificationRows([pushRow(), completedRow({ read_at: null })]);
    expect(b).toHaveLength(1);
    expect(b[0]!.read_at).toBeNull();
  });

  it("身份聯集:completed 以管理員、推播以客服 ⇒ 兩個身份都列出,目的地仍是訂單管理", () => {
    const merged = mergeNotificationRows([pushRow({ target_type: "agent" }), completedRow()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.targetTypes).toEqual(["admin", "agent"]);
    expect(resolveNotificationLink({ target_type: merged[0]!.primaryTargetType })).toBe(
      "/app/orders",
    );
  });

  it("只有其中一種 ⇒ 照舊各自顯示", () => {
    const onlyPush = mergeNotificationRows([pushRow()]);
    expect(onlyPush).toHaveLength(1);
    expect(onlyPush[0]!.event_type).toBe("booking_cancelled");
    expect(mergeNotificationRows([completedRow()])).toHaveLength(1);
  });

  it("還原(booking_completed_reverted)不會吸收 booking_cancelled", () => {
    expect(
      mergeNotificationRows([
        pushRow(),
        completedRow({ event_type: "booking_completed_reverted" }),
      ]),
    ).toHaveLength(2);
  });
});

describe("客戶端第 2 批:會員用 LINE 登入接上的鈴鐺", () => {
  it("有中文標籤(不會顯示成英文代碼),而且只在鈴鐺專用清單", () => {
    expect(BELL_ONLY_EVENT_LABELS["member_line_login_linked"]).toBe("會員用 LINE 登入接上時");
    expect(Object.keys(PUSH_NOTIFICATION_EVENT_LABELS)).not.toContain("member_line_login_linked");
  });

  it("點了到會員列表(不看身份);其他事件照舊依身份", () => {
    for (const t of ["admin", "agent"]) {
      expect(
        resolveNotificationLink({ target_type: t, event_type: "member_line_login_linked" }),
      ).toBe("/app/members");
    }
    expect(resolveNotificationLink({ target_type: "admin", event_type: "booking_created" })).toBe(
      NOTIFICATION_TARGET_URLS.admin,
    );
  });
});
