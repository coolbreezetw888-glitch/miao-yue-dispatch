// 模組 14:服務人員端 — 第五節「對外介面」的實作。
// 其他模組要判斷「目前使用者是不是這間店的服務人員本人」「這位服務人員有沒有被開放某個自助功能
// 區塊」,一律 import 這個檔案匯出的 hooks,不要自己 import supabase client 直接查
// merchant_staff_permissions 這張表。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  addStaffAvailabilityWindow,
  removeStaffAvailabilityWindow,
  setStaffDayOverride,
  clearStaffDayOverride,
  type AddStaffAvailabilityWindowInput,
} from "@/modules/booking/api";
import { useStaffAvailabilityWindows } from "@/modules/booking/context";
import { addDays, getTaipeiNow, toDateKey } from "@/modules/booking/dateUtils";
import type {
  BookingStatusColorMap,
  CalendarStateStyleMap,
  StaffAvailabilityWindow,
} from "@/modules/booking/types";
import { fetchMyStaffRow } from "@/modules/staff-agent/api";
import type { MerchantStaff } from "@/modules/staff-agent/types";
import { useStaffCommissionSummary, useStaffMonthlyPayrollSummary } from "@/modules/payroll/api";
import type { StaffCommissionSummary, StaffMonthlyPayrollSummary } from "@/modules/payroll/types";

import {
  fetchMyAvailabilityOverrides,
  fetchMyBookingSchedule,
  fetchMyBookingStatusColors,
  fetchMyCalendarStateStyles,
  fetchMyDayBusinessHours,
  fetchMyDayScheduleState,
  staffCancelBooking,
  staffCompleteBooking,
  staffConfirmBooking,
  type MyBookingScheduleItem,
  type MyDayBusinessHours,
  type MyDayScheduleState,
  type StaffAvailabilityOverride,
} from "./api";
import {
  createStaffScheduleRefreshScheduler,
  effectiveStaffScheduleStatus,
  INITIAL_STAFF_SCHEDULE_CHANNEL_STATE,
  invalidateStaffSchedule,
  nextStaffScheduleChannelState,
  resolveStaffScheduleSubscription,
  shouldRefreshFromBroadcast,
  STAFF_SCHEDULE_EVENT,
  type StaffScheduleChannelState,
} from "./staffScheduleChannel";
import { countMyPendingConfirmations, PENDING_REMINDER_RANGE_DAYS } from "./staffConfirmLogic";
import type { StaffPermissionSectionKey } from "./types";

/** 5.6 對外介面:唯讀,回傳目前登入者在指定商家的 merchant_staff 那一列(受模組 3 規格書 3.3
 * 疊加後的 RLS 保護)。供本模組所有其他 hook 內部取得 staff_id,也保留給之後任何模組需要判斷
 * 「目前使用者是不是這間商家的服務人員本人」時直接複用。 */
export function useMyStaffRecord(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantStaff | null> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    queryFn: async (): Promise<MerchantStaff | null> => {
      const user = await getVerifiedUser();
      if (!user) return null;
      return fetchMyStaffRow(merchantId as string, user.id);
    },
    enabled: Boolean(merchantId),
    staleTime: 30_000,
  });
}

/** 只有「目前是這間商家有效且已開通登入的服務人員」時,才回傳那一筆紀錄,否則回傳 null——
 * 內部給 5.1-5.5 各個自助功能 hook 共用,避免每個 hook 各自重複判斷 status/login_status。
 * 對外 export(比照 useMyStaffRecord)供頁面元件/路由守衛直接判斷「我現在算不算一個能用自助
 * 功能的服務人員」,不用自己重複寫一次 status/login_status 的判斷條件。 */
export function useActiveMyStaffRecord(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantStaff | null> {
  const query = useMyStaffRecord(merchantId);
  const isActiveStaff =
    query.data != null && query.data.status === "active" && query.data.login_status === "active";
  return {
    ...query,
    data: isActiveStaff ? query.data : null,
  } as UseQueryResult<MerchantStaff | null>;
}

/** 5.7 對外介面:回傳目前使用者(如果是「目前有效且已開通登入」的服務人員)是否被開放某個自助
 * 功能區塊。不是服務人員身份時回傳 null,代表「不適用這個判斷」(比照模組 3 useAgentPermission
 * 的既有精神)。
 *
 * 2026-09-24 深夜巡檢問題 6 的根因修正:enabled 原本只看 merchantId,但 queryFn 在 staffId 還
 * 沒解出來時是直接 `return null`。結果是「查詢明明還沒有答案,isLoading 卻已經轉成 false、data
 * 是 null」——呼叫端只要沒有另外等 useActiveMyStaffRecord 的載入狀態,就會先當成「沒有權限」渲染
 * 一次空狀態文字,網路慢的時候使用者真的看得到這一閃(手機端尤其明顯)。改成 staffId 解出來之前
 * 查詢根本不啟用,就不會再產生這種「假的 null 答案」,也不會在 staffId=null 的 queryKey 底下留
 * 一份沒有意義的快取。
 *
 * 呼叫端的行為不受影響:非服務人員身分時查詢維持停用,data 是 undefined(原本是 null),目前四個
 * 呼叫端(MyCalendarPage、RequireStaffPayrollAccess、RequireStaffAvailabilityAccess、
 * HomePage)判斷的都是「=== true 才放行」,undefined 跟 null 在這個判斷下完全等價。 */
export function useMyStaffPermission(
  sectionKey: StaffPermissionSectionKey | string,
): UseQueryResult<boolean | null> {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-staff-permission", staffId, sectionKey],
    queryFn: async (): Promise<boolean | null> => {
      if (!staffId) return null;

      const { data, error } = await supabase
        .from("merchant_staff_permissions")
        .select("granted")
        .eq("staff_id", staffId)
        .eq("section_key", sectionKey)
        .maybeSingle();
      if (error) throw error;

      return data?.granted ?? false;
    },
    enabled: Boolean(merchantId) && Boolean(staffId),
  });
}

// =========================================================================
// 5.1:我的行事曆彙整查詢(對應規格書 3.15/規則 2.5/2.6)。內部先呼叫 useMyStaffRecord 取得
// 自己的 staff_id,再呼叫 3.15,供 4.3 MyCalendarPage.tsx 使用。
// =========================================================================
export function useMyBookingSchedule(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<MyBookingScheduleItem[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-booking-schedule", staffId, startDate, endDate],
    queryFn: () =>
      fetchMyBookingSchedule(staffId as string, startDate as string, endDate as string),
    enabled: Boolean(staffId) && Boolean(startDate) && Boolean(endDate),
  });
}

// =========================================================================
// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認。
// =========================================================================

/**
 * 預約詳情「確認接單」按鈕用的 mutation。成功後**立刻** invalidate 行事曆查詢(列表、時間軸、詳情、鈴鐺待確認數
 * 都讀 my-booking-schedule),不只等即時同步(規格三之 1)。
 */
export function useStaffConfirmBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) => staffConfirmBooking(bookingId),
    onSuccess: () => {
      invalidateStaffSchedule(queryClient);
    },
  });
}

/**
 * SPECS-INDEX #977 第 7 批(2026-10-07):預約詳情「取消預約」「標記完成」(只限開關生效 + 自己是主要服務人員,
 * 後端 staff_cancel_booking / staff_complete_booking 再擋一次)。成功後**立刻** invalidate 行事曆查詢,不只等即時同步。
 */
export function useStaffCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { bookingId: string; reason: string | null }) =>
      staffCancelBooking(input.bookingId, input.reason),
    onSuccess: () => {
      invalidateStaffSchedule(queryClient);
    },
  });
}

export function useStaffCompleteBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) => staffCompleteBooking(bookingId),
    onSuccess: () => {
      invalidateStaffSchedule(queryClient);
    },
  });
}

/**
 * 鈴鐺「你有 N 筆訂單待確認」(規格三之 4,主腦裁決 ③):即時由行事曆資料計算,不寫進資料表。
 * 只在「服務人員視角」(AppLayout 的 isStaffView)而且有「行事曆檢視」權限時才查;其他情況回 0。
 * 查詢範圍是今天(台北)起 PENDING_REMINDER_RANGE_DAYS 天(get_my_booking_schedule 的上限)。
 * 共用 my-booking-schedule 這個 queryKey 前綴 ⇒ 確認接單 / 即時同步 invalidate 時這個數字也會跟著更新。
 */
export function useMyPendingConfirmationCount(enabled: boolean): number {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: hasCalendarAccess } = useMyStaffPermission("staff_calendar_view");
  const today = getTaipeiNow();
  const todayKey = toDateKey(today);
  const endKey = toDateKey(addDays(today, PENDING_REMINDER_RANGE_DAYS));
  const { data } = useMyBookingSchedule(
    enabled && hasCalendarAccess === true ? merchantId : null,
    todayKey,
    endKey,
  );
  if (!enabled || hasCalendarAccess !== true) return 0;
  return countMyPendingConfirmations(data, todayKey);
}

// =========================================================================
// 5.2:讀寫自己的 staff_availability_windows(受 3.13 疊加後的 RLS 保護,前端直接
// supabase.from(...) 操作即可)。內部複用模組 5 對外介面 useStaffAvailabilityWindows/
// addStaffAvailabilityWindow/removeStaffAvailabilityWindow,不重新實作一套查詢邏輯。
// =========================================================================
export function useMyAvailabilityWindows(
  merchantId: string | null | undefined,
): UseQueryResult<StaffAvailabilityWindow[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffAvailabilityWindows(staffRow?.id ?? null);
}

export async function upsertMyAvailabilityWindow(
  staffId: string,
  input: AddStaffAvailabilityWindowInput,
): Promise<StaffAvailabilityWindow> {
  return addStaffAvailabilityWindow(staffId, input);
}

export async function deleteMyAvailabilityWindow(windowId: string): Promise<void> {
  return removeStaffAvailabilityWindow(windowId);
}

// =========================================================================
// 5.3:單日例外自助讀寫。呼叫 3.14 疊加後的 set_staff_day_override/clear_staff_day_override
// (模組 5 既有對外介面,已疊加自助分支,呼叫端只要傳入自己的 staff_id 即可)+ 讀取自己的
// staff_availability_overrides。
//
// 命名跟規格書 5.3 字面(useMySetDayOverride/useMyClearDayOverride)差一個 use 前綴——這兩支
// 是單純的非同步寫入函式,不是 React hook(不呼叫任何其他 hook、可以在事件處理常式裡直接
// await),沿用 use 前綴會誤導成 hook、也會被 eslint-plugin-react-hooks 的 rules-of-hooks
// 檢查誤判。比照本檔案/booking 模組既有的 setStaffDayOverride/clearStaffDayOverride、
// createBooking 等寫入函式一律不加 use 前綴的既有命名慣例,已在回報中向主腦說明這個小幅偏離。
// =========================================================================
export async function setMyDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
  isAvailable: boolean,
): Promise<number> {
  return setStaffDayOverride(staffId, overrideDate, startTime, endTime, isAvailable);
}

export async function clearMyDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  return clearStaffDayOverride(staffId, overrideDate, startTime, endTime);
}

export function useMyAvailabilityOverrides(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffAvailabilityOverride[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-availability-overrides", staffId, startDate, endDate],
    queryFn: () =>
      fetchMyAvailabilityOverrides(staffId as string, startDate as string, endDate as string),
    enabled: Boolean(staffId) && Boolean(startDate) && Boolean(endDate),
  });
}

/** 供 4.4 頁面在寫入後 invalidate 相關查詢用,集中管理 query key 前綴,避免各頁面各自拼字串。 */
export function useInvalidateMyAvailability(): {
  invalidate: (merchantId: string, staffId: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  return {
    invalidate: async (merchantId: string, staffId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["booking-module", "staff-availability-windows", staffId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["staff-portal-module", "my-availability-overrides"],
        }),
      ]);
      void merchantId;
    },
  };
}

// =========================================================================
// 5.4:抽成/薪資報表自助檢視。內部取得自己的 staff_id 後呼叫模組 8 既有對外介面
// (已在 3.17 疊加自助檢視分支),直接複用同一套查詢邏輯,不另外開發平行的「自助版」函式。
// =========================================================================
export function useMyStaffCommissionSummary(
  merchantId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffCommissionSummary> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffCommissionSummary(staffRow?.id ?? null, year, month);
}

export function useMyStaffMonthlyPayrollSummary(
  merchantId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffMonthlyPayrollSummary> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffMonthlyPayrollSummary(staffRow?.id ?? null, year, month);
}

// =========================================================================
// v2 §10.2.1/§10.3.3(對外介面異動總結第十一節):我的商家某一天的營業時間。跟本檔案其他 hook
// 不同,這支直接接受呼叫端已經解出來的 staffId(不是 merchantId)——因為呼叫端
// (MyCalendarTimelineView/DayOffTabsSection)本來就已經從父層拿到 staffId,不需要再繞一次
// useActiveMyStaffRecord。
// =========================================================================
export function useMyDayBusinessHours(
  staffId: string | null | undefined,
  date: string | null | undefined,
): UseQueryResult<MyDayBusinessHours> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-day-business-hours", staffId, date],
    queryFn: () => fetchMyDayBusinessHours(staffId as string, date as string),
    enabled: Boolean(staffId) && Boolean(date),
  });
}

// =========================================================================
// SPECS-INDEX #644:服務人員自助行事曆的「全天休假/時段排休/跨店佔用」狀態(供
// MyCalendarTimelineView.tsx 渲染用)+ 對應的商家顏色設定,兩支都直接接受呼叫端已經解出來的
// staffId,跟上面 useMyDayBusinessHours 同一個既有慣例(呼叫端本來就已經從父層拿到 staffId,
// 不需要再繞一次 useActiveMyStaffRecord)。
// =========================================================================
export function useMyDayScheduleState(
  staffId: string | null | undefined,
  date: string | null | undefined,
): UseQueryResult<MyDayScheduleState> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-day-schedule-state", staffId, date],
    queryFn: () => fetchMyDayScheduleState(staffId as string, date as string),
    enabled: Boolean(staffId) && Boolean(date),
  });
}

/** SPECS-INDEX #860:服務人員端行事曆的預約色塊,改讀商家自訂的訂單狀態顏色(跟商家端
 * CalendarPage.tsx 的 useMerchantBookingStatusColors 對應同一張表)。走 SECURITY DEFINER 的
 * get_my_booking_status_colors,理由見 api.ts 的 fetchMyBookingStatusColors 說明。
 * 參數刻意是 staffId(不是 merchantId),跟同檔 useMyCalendarStateStyles / useMyDayBusinessHours
 * 的既有慣例一致 —— 呼叫端本來就已經從父層拿到 staffId。 */
export function useMyBookingStatusColors(
  staffId: string | null | undefined,
): UseQueryResult<BookingStatusColorMap> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-booking-status-colors", staffId],
    queryFn: () => fetchMyBookingStatusColors(staffId as string),
    enabled: Boolean(staffId),
  });
}

export function useMyCalendarStateStyles(
  staffId: string | null | undefined,
): UseQueryResult<CalendarStateStyleMap> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-calendar-state-styles", staffId],
    queryFn: () => fetchMyCalendarStateStyles(staffId as string),
    enabled: Boolean(staffId),
  });
}

// =========================================================================
// SPECS-INDEX #874 服務人員端行事曆即時同步 —— 批次 4:前端接線(#895 ~ #899、#903)。
//
// 商家端改單時,資料庫 trigger 會對受影響的服務人員私有頻道 `staff:<staff_id>:schedule` 發一則
// 不含任何內容的 `schedule_changed` 訊號(批次 1/2)。這支 hook 只負責「收到就把行事曆標成過期」,
// 資料照舊 100% 走 get_my_booking_schedule,可見範圍完全不變。所有判斷都在 staffScheduleChannel.ts
// (純函式、Vitest 已鎖住),這裡只做 supabase channel 的接線與生命週期。
// =========================================================================

/** 這支 hook 需要的 supabase client 介面(測試時可以注入替身,正式環境一律用全站共用的 supabase)。 */
export type StaffScheduleRealtimeClient = {
  channel: (topic: string, opts: { config: { private: boolean } }) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => unknown;
};

export interface StaffScheduleLiveSyncOptions {
  /** `useMyStaffPermission('staff_calendar_view').data`。只有明確 `true` 才訂閱(#895 啟用條件 2)。 */
  hasCalendarView: boolean | null | undefined;
  /** 只給測試注入用;不傳就用 `@/integrations/supabase/client` 的 supabase。 */
  client?: StaffScheduleRealtimeClient;
}

const LIVE_SYNC_LOG_PREFIX = "[staff-schedule-live-sync]";

/**
 * 5.x 對外介面(#895):在服務人員行事曆頁掛上「班表即時同步」訂閱。無回傳值,副作用是掛訂閱。
 *
 * - **只在 MyCalendarPage 與 MyAvailabilityPage(休假設定,#1036)呼叫**,刻意不放 AppLayout:只有真的開著
 *   這兩頁的人才佔一條 Realtime 連線(兩頁是不同路由,同一個分頁同時只會開一頁 ⇒ 仍是一條;
 *   Free 方案同時連線上限 200,見規格書 #901)。
 * - 啟用條件:staffId 是合法 UUID **而且**行事曆檢視權限明確為 true(resolveStaffScheduleSubscription)。
 *   權限中途被關掉(#903)⇒ 權限查詢重抓回 false ⇒ topic 變 null ⇒ effect cleanup 退訂。
 * - 換商家(staffId 變)⇒ topic 變 ⇒ 先跑舊的 cleanup(退舊頻道)再訂新頻道;離開頁面 / 登出 ⇒ 元件卸載 ⇒ cleanup。
 * - 🔴 `{ config: { private: true } }` 一定要帶:資料庫端是 private broadcast,兩邊不一致**不會報錯、只會安靜收不到**。
 * - #897:每一次 SUBSCRIBED(含斷線重連後)都重查一次,補上斷線期間漏掉的變更;重查一律經過去抖(#900)。
 * - #899:任何失敗只記 console.warn / console.info,**不彈 toast、不顯示錯誤區塊**;行事曆照舊靠既有三個
 *   觸發點(掛載、視窗聚焦、推播)運作。連續**被拒**(伺服器回覆的 CHANNEL_ERROR)達上限(批次 3 的 giveUp)
 *   就退掉頻道,不讓 supabase-js 對一個註定被拒的頻道無限重試;**傳輸層斷線**造成的 CHANNEL_ERROR
 *   不算(視同 CLOSED),否則手機訊號不穩幾次就永久失去即時同步(#897 失效)。
 * - #898:不手動 setAuth。supabase-js 會在 join 前用目前 session 的 access token 授權,並在 token 續期時
 *   自動送新 token(本機 e2e E1 實測:訂自己的頻道拿到 SUBSCRIBED = token 帶對了)。
 */
export function useStaffScheduleLiveSync(
  staffId: string | null | undefined,
  options: StaffScheduleLiveSyncOptions,
): void {
  const queryClient = useQueryClient();
  const topic = resolveStaffScheduleSubscription({
    staffId,
    hasCalendarView: options.hasCalendarView,
  });
  const client: StaffScheduleRealtimeClient =
    options.client ?? (supabase as unknown as StaffScheduleRealtimeClient);

  useEffect(() => {
    if (!topic) return undefined;

    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let channelState: StaffScheduleChannelState = INITIAL_STAFF_SCHEDULE_CHANNEL_STATE;

    const scheduler = createStaffScheduleRefreshScheduler(() => {
      if (!disposed) invalidateStaffSchedule(queryClient);
    });

    // 退掉目前的頻道(重複呼叫安全)。removeChannel 失敗(同步丟錯或 Promise reject)只記 warn。
    const releaseChannel = () => {
      const current = channel;
      channel = null;
      if (!current) return;
      try {
        const result = client.removeChannel(current);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch((error: unknown) => {
            console.warn(`${LIVE_SYNC_LOG_PREFIX} 退訂頻道失敗`, error);
          });
        }
      } catch (error) {
        console.warn(`${LIVE_SYNC_LOG_PREFIX} 退訂頻道失敗`, error);
      }
    };

    try {
      const created = client.channel(topic, { config: { private: true } });
      channel = created;
      created.on("broadcast", { event: STAFF_SCHEDULE_EVENT }, (message: unknown) => {
        if (disposed) return;
        if (shouldRefreshFromBroadcast(message)) scheduler.trigger();
      });
      created.subscribe((status: string, error?: Error) => {
        if (disposed) return;
        // 傳輸層斷線(socket closed / 心跳逾時)造成的 CHANNEL_ERROR 視同 CLOSED:交給 supabase-js
        // 自己重連,不算進「連續被拒就放棄」(見 staffScheduleChannel.ts isTransportChannelError)。
        const decision = nextStaffScheduleChannelState(
          channelState,
          effectiveStaffScheduleStatus(status, error),
        );
        channelState = decision.state;
        if (decision.log === "warn") {
          console.warn(
            `${LIVE_SYNC_LOG_PREFIX} 即時同步頻道狀態 ${status}(行事曆照常可用,只是暫時不會自動更新)`,
            error?.message ?? "",
          );
        } else if (decision.log === "info") {
          console.info(`${LIVE_SYNC_LOG_PREFIX} 即時同步頻道狀態 ${status}`, error?.message ?? "");
        }
        if (decision.refresh) scheduler.trigger();
        if (decision.giveUp) {
          console.warn(`${LIVE_SYNC_LOG_PREFIX} 連續被拒,停止即時同步(重新進入行事曆頁會再試一次)`);
          scheduler.cancel();
          releaseChannel();
        }
      });
    } catch (error) {
      // #899:建頻道 / 訂閱本身丟錯(例如瀏覽器封鎖 WebSocket)⇒ 靜默降級,行事曆照常。
      console.warn(`${LIVE_SYNC_LOG_PREFIX} 無法建立即時同步頻道(行事曆照常可用)`, error);
      releaseChannel();
    }

    return () => {
      disposed = true;
      scheduler.cancel();
      releaseChannel();
    };
  }, [topic, queryClient, client]);
}
