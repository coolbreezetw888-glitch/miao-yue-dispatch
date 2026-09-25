// §十之二「§13.5 重新查詢的觸發」那一條:收到 postMessage({type:'push-received'}) 會
// invalidateQueries;收到其他 type 不會。
import { describe, expect, it, vi } from "vitest";

import { MY_NOTIFICATIONS_QUERY_KEY, MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY } from "./api";
import {
  handleServiceWorkerNotificationMessage,
  shouldRefreshNotifications,
} from "./serviceWorkerBridge";

function makeQueryClient() {
  return { invalidateQueries: vi.fn(() => Promise.resolve()) };
}

describe("shouldRefreshNotifications", () => {
  it("push-received → true", () => {
    expect(shouldRefreshNotifications({ type: "push-received" })).toBe(true);
  });

  it("push-test-received → false(測試推播刻意不寫入 user_notifications,重查只是白打資料庫)", () => {
    expect(shouldRefreshNotifications({ type: "push-test-received" })).toBe(false);
  });

  it("其他/畸形訊息一律 false,不丟錯", () => {
    expect(shouldRefreshNotifications({ type: "sw-update" })).toBe(false);
    expect(shouldRefreshNotifications({})).toBe(false);
    expect(shouldRefreshNotifications(null)).toBe(false);
    expect(shouldRefreshNotifications(undefined)).toBe(false);
    expect(shouldRefreshNotifications("push-received")).toBe(false);
    expect(shouldRefreshNotifications(42)).toBe(false);
  });
});

describe("handleServiceWorkerNotificationMessage", () => {
  it("收到 push-received 時 invalidate 鈴鐺的兩個 query", () => {
    const queryClient = makeQueryClient();
    const handled = handleServiceWorkerNotificationMessage(queryClient, {
      type: "push-received",
    });
    expect(handled).toBe(true);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: MY_NOTIFICATIONS_QUERY_KEY,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY,
    });
  });

  it("收到其他 type 時完全不呼叫 invalidateQueries", () => {
    const queryClient = makeQueryClient();
    expect(
      handleServiceWorkerNotificationMessage(queryClient, { type: "push-test-received" }),
    ).toBe(false);
    expect(handleServiceWorkerNotificationMessage(queryClient, { type: "whatever" })).toBe(false);
    expect(handleServiceWorkerNotificationMessage(queryClient, null)).toBe(false);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
