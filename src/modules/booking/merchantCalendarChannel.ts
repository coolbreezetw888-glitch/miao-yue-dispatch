// SPECS-INDEX #1003 / #1006(第 14 批,2026-10-07):商家端行事曆即時同步 —— 前端純邏輯。
//
// 背景:改版前商家端行事曆**沒有訂閱任何即時訊號**(全專案只有服務人員端訂了 staff:<id>:schedule)。
// 服務人員在手機改每週固定可預約時段、同集團另一家店替同一個人建單 / 拖拉改時間,商家端開著的行事曆
// 都不會變,一定要重新整理。migration 20261007160000 讓資料庫在這幾張表變動時,對受影響商家的私有頻道
// `merchant:<merchant_id>:calendar` 發一則**不帶任何內容**的 `calendar_changed` 訊號(payload 只有
// {v, reason, id})。前端收到後只做一件事:把行事曆相關的 query 標成過期,讓 React Query 重打
// get_merchant_day_schedule 等既有查詢 —— 資料可見範圍完全不變。
//
// ⚠️ 跟服務人員端 staffScheduleChannel.ts 同一套做法:這個檔案只放純函式(沒有 React、沒有 supabase client),
//    去抖排程器、訂閱狀態判斷(重連補查 / 被拒放棄 / 傳輸層斷線不算)直接共用那邊已經被 Vitest 鎖住的版本,
//    不另寫第二份。真正掛訂閱的 hook 在 useMerchantCalendarLiveSync.ts。

import type { QueryClient } from "@tanstack/react-query";

/** broadcast 事件名稱。資料庫端 `realtime.send(..., 'calendar_changed', ...)` 逐字對應。 */
export const MERCHANT_CALENDAR_EVENT = "calendar_changed";

/** payload 裡 `reason` 欄位的唯一合法值。 */
export const MERCHANT_CALENDAR_REASON = "calendar_changed";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 組商家行事曆頻道名:`merchant:<merchant_id 小寫 UUID>:calendar`。
 *
 * 🔴 全前端只能由這一支產生頻道名。頻道名差一個字元或大小寫不同,Realtime **不會報錯,只會安靜地收不到**
 *    (資料庫的授權函式 private.can_listen_merchant_calendar_topic 只認小寫)。
 */
export function merchantCalendarTopic(merchantId: string): string {
  return `merchant:${merchantId.toLowerCase()}:calendar`;
}

/** 決定現在該訂哪個頻道;回傳 null 代表「不要訂(已經訂的要退掉)」。merchantId 不是合法 UUID 一律不訂。 */
export function resolveMerchantCalendarSubscription(
  merchantId: string | null | undefined,
): string | null {
  if (typeof merchantId !== "string" || !UUID_PATTERN.test(merchantId)) return null;
  return merchantCalendarTopic(merchantId);
}

/**
 * 給 `.on('broadcast', { event }, (message) => ...)` 回呼用:事件名對、而且內層 payload.reason 是
 * 'calendar_changed' 才重查;其他任何形狀一律 false、不丟錯。刻意不要求 `v === 1`(理由同服務人員端)。
 */
export function shouldRefreshMerchantCalendar(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const { event, payload } = message as { event?: unknown; payload?: unknown };
  if (event !== MERCHANT_CALENDAR_EVENT) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return (payload as { reason?: unknown }).reason === MERCHANT_CALENDAR_REASON;
}

/**
 * 收到訊號要重查的 queryKey 前綴(都是商家端行事曆頁畫面上掛著的):
 * - day-schedule:時間軸格子(可約時段、單日例外、本店預約、跨店灰格)
 * - bookings-list:卡片列表 / 月曆日期格的數量
 * - month-badge-assistants:月曆日期格「協助」那一段的查詢
 * - booking-card-extras:卡片列表上的服務項目 / 金額
 * - staff-availability-windows:建單表單開著時,時段選單要跟著每週時段變
 * 刻意**不**整個 ["booking-module"] 一起洗:那會連訂單狀態顏色、營業時間設定、建單表單的選項都重抓,
 * 客服填到一半的建單表單選項會閃動。React Query 只會立刻重抓「目前畫面上掛著的那幾支」。
 */
export const MERCHANT_CALENDAR_INVALIDATE_KEYS = [
  ["booking-module", "day-schedule"],
  ["booking-module", "bookings-list"],
  ["booking-module", "month-badge-assistants"],
  ["booking-module", "booking-card-extras"],
  ["booking-module", "staff-availability-windows"],
] as const;

/** 對每個 key 呼叫 invalidateQueries。任何失敗只記 console.warn(即時同步只是加分項,不能讓畫面壞掉)。 */
export function invalidateMerchantCalendar(
  queryClient: Pick<QueryClient, "invalidateQueries"> | null | undefined,
): boolean {
  if (!queryClient) return false;
  for (const queryKey of MERCHANT_CALENDAR_INVALIDATE_KEYS) {
    try {
      const result = queryClient.invalidateQueries({ queryKey: [...queryKey] });
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          console.warn("[merchant-calendar-live-sync] 重新查詢行事曆失敗", error);
        });
      }
    } catch (error) {
      console.warn("[merchant-calendar-live-sync] 重新查詢行事曆失敗", error);
    }
  }
  return true;
}
