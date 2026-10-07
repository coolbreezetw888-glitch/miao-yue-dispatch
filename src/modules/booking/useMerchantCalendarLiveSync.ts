// SPECS-INDEX #1003 / #1006(第 14 批,2026-10-07):商家端行事曆即時同步 —— 訂閱接線。
//
// 資料庫(migration 20261007160000)在「每週固定可預約時段 / 單日例外 / 訂單 / 助手」變動時,對受影響
// 商家的私有頻道 `merchant:<merchant_id>:calendar` 發一則不含任何內容的 `calendar_changed` 訊號
// (同集團同一個人在別家店的訂單變動,也會發給這家店 ⇒ 灰色「外店預約中」即時出現)。
// #1011(第 17 批,migration 20261008100000)起,請假、營業時間、服務人員資料(名字 / 在職 / 後台無時段限制 /
// 電話)變動也發同一種訊號,收到後做的事不變。
// 這支 hook 只負責「收到就把行事曆標成過期」,資料照舊 100% 走 get_merchant_day_schedule 等既有查詢。
//
// 生命週期與錯誤處理**逐條照抄服務人員端 useStaffScheduleLiveSync**(staff-realtime-sync skill),
// 判斷全部共用 staffScheduleChannel.ts 已被 Vitest 鎖住的純函式:
// - 只在 CalendarPageInner 呼叫(進行事曆頁才訂閱、離開退訂),不放 AppLayout ⇒ 只有真的開著行事曆的人佔連線。
// - 🔴 `{ config: { private: true } }` 一定要帶:資料庫端是 private broadcast,兩邊不一致不會報錯、只會安靜收不到。
// - 每一次 SUBSCRIBED(含斷線重連後)都重查一次,補上斷線期間漏掉的變更;重查一律經過去抖(400ms / 最多 2 秒)。
// - 被拒(伺服器回覆的 CHANNEL_ERROR)連續 3 次就退訂放棄;傳輸層斷線不算(視同 CLOSED,交給 supabase-js 重連)。
// - 任何失敗只記 console.warn / info,不彈 toast、不顯示錯誤區塊;行事曆照舊靠「掛載 / 切回分頁 / 自己操作完」更新。
// - 不手動 setAuth(supabase-js 會在 join 前用目前 session 的 token 授權,token 續期也會自動送)。

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import {
  createStaffScheduleRefreshScheduler,
  effectiveStaffScheduleStatus,
  INITIAL_STAFF_SCHEDULE_CHANNEL_STATE,
  nextStaffScheduleChannelState,
  type StaffScheduleChannelState,
} from "@/modules/staff-portal/staffScheduleChannel";

import {
  invalidateMerchantCalendar,
  MERCHANT_CALENDAR_EVENT,
  resolveMerchantCalendarSubscription,
  shouldRefreshMerchantCalendar,
} from "./merchantCalendarChannel";

/** 這支 hook 需要的 supabase client 介面(測試時注入替身,正式環境一律用全站共用的 supabase)。 */
export type MerchantCalendarRealtimeClient = {
  channel: (topic: string, opts: { config: { private: boolean } }) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => unknown;
};

const LOG_PREFIX = "[merchant-calendar-live-sync]";

/**
 * 在商家端行事曆頁掛上「行事曆即時同步」訂閱。無回傳值,副作用是掛訂閱。
 * merchantId 不是合法 UUID(還沒載入、沒選商家)⇒ 不訂;換商家 ⇒ 先退舊頻道再訂新頻道。
 * 能不能加入頻道由資料庫政策決定(商家管理員 / 開了訂單管理的客服),前端不另外判斷權限 ——
 * 這一頁本來就只有這兩種人進得來(RequireBookingAccess)。
 */
export function useMerchantCalendarLiveSync(
  merchantId: string | null | undefined,
  options: { client?: MerchantCalendarRealtimeClient } = {},
): void {
  const queryClient = useQueryClient();
  const topic = resolveMerchantCalendarSubscription(merchantId);
  const client: MerchantCalendarRealtimeClient =
    options.client ?? (supabase as unknown as MerchantCalendarRealtimeClient);

  useEffect(() => {
    if (!topic) return undefined;

    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let channelState: StaffScheduleChannelState = INITIAL_STAFF_SCHEDULE_CHANNEL_STATE;

    const scheduler = createStaffScheduleRefreshScheduler(() => {
      if (!disposed) invalidateMerchantCalendar(queryClient);
    });

    const releaseChannel = () => {
      const current = channel;
      channel = null;
      if (!current) return;
      try {
        const result = client.removeChannel(current);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch((error: unknown) => {
            console.warn(`${LOG_PREFIX} 退訂頻道失敗`, error);
          });
        }
      } catch (error) {
        console.warn(`${LOG_PREFIX} 退訂頻道失敗`, error);
      }
    };

    try {
      const created = client.channel(topic, { config: { private: true } });
      channel = created;
      created.on("broadcast", { event: MERCHANT_CALENDAR_EVENT }, (message: unknown) => {
        if (disposed) return;
        if (shouldRefreshMerchantCalendar(message)) scheduler.trigger();
      });
      created.subscribe((status: string, error?: Error) => {
        if (disposed) return;
        const decision = nextStaffScheduleChannelState(
          channelState,
          effectiveStaffScheduleStatus(status, error),
        );
        channelState = decision.state;
        if (decision.log === "warn") {
          console.warn(
            `${LOG_PREFIX} 即時同步頻道狀態 ${status}(行事曆照常可用,只是暫時不會自動更新)`,
            error?.message ?? "",
          );
        } else if (decision.log === "info") {
          console.info(`${LOG_PREFIX} 即時同步頻道狀態 ${status}`, error?.message ?? "");
        }
        if (decision.refresh) scheduler.trigger();
        if (decision.giveUp) {
          console.warn(`${LOG_PREFIX} 連續被拒,停止即時同步(重新進入行事曆頁會再試一次)`);
          scheduler.cancel();
          releaseChannel();
        }
      });
    } catch (error) {
      console.warn(`${LOG_PREFIX} 無法建立即時同步頻道(行事曆照常可用)`, error);
      releaseChannel();
    }

    return () => {
      disposed = true;
      scheduler.cancel();
      releaseChannel();
    };
  }, [topic, queryClient, client]);
}
