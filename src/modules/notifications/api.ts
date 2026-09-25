// 站內通知中心(鈴鐺)— 資料存取層 + §13.11 對外介面的實作。
//
// 這裡是**唯一**直接呼叫 supabase.from('user_notifications') 與
// supabase.rpc('mark_my_notifications_read') 的地方(比照 push-notifications/api.ts 的既有慣例)。
//
// ⚠️ 所有查詢都**不帶 user_id 條件**:RLS(`user_id = auth.uid()`)已經保證只拿得到自己的列,
//    在前端再帶一次只是製造「以為自己在控制範圍」的錯覺(§13.2)。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import type { UserNotification } from "./types";

/** §13.7:面板最多顯示最近 20 則(已讀未讀一起,依 created_at desc)。v1 不做分頁/無限捲動。 */
export const MY_NOTIFICATIONS_DEFAULT_LIMIT = 20;

export const MY_NOTIFICATIONS_QUERY_KEY = ["notifications-module", "my-notifications"] as const;
export const MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY = [
  "notifications-module",
  "my-unread-notification-count",
] as const;

export async function fetchMyNotifications(
  limit = MY_NOTIFICATIONS_DEFAULT_LIMIT,
): Promise<UserNotification[]> {
  const { data, error } = await supabase
    .from("user_notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export function useMyNotifications(
  limit = MY_NOTIFICATIONS_DEFAULT_LIMIT,
  enabled = true,
): UseQueryResult<UserNotification[]> {
  return useQuery({
    queryKey: [...MY_NOTIFICATIONS_QUERY_KEY, limit],
    queryFn: () => fetchMyNotifications(limit),
    enabled,
  });
}

/**
 * §13.5:未讀數字 = `read_at is null` 的列數。
 *
 * ⚠️ 用 `{ count: 'exact', head: true }`:`head: true` 代表只回 count、不回任何資料列,很省。
 *    **刻意不引進 realtime、也絕對不要用 refetchInterval 輪詢**(§13.5 最後一段:209 間商家
 *    每隔幾秒打一次資料庫的成本不是零,而換來的體感改善很小)。重新查詢靠三個現成的觸發點:
 *      ① 元件掛載(react-query 標準行為);
 *      ② 切回這個分頁(refetchOnWindowFocus 維持官方預設 true,main.tsx 沒有覆寫);
 *      ③ service worker 收到推播時 postMessage → AppLayout 收到就 invalidate。
 */
export async function fetchMyUnreadNotificationCount(): Promise<number> {
  const { count, error } = await supabase
    .from("user_notifications")
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  if (error) throw error;
  return count ?? 0;
}

export function useMyUnreadNotificationCount(enabled = true): UseQueryResult<number> {
  return useQuery({
    queryKey: MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY,
    queryFn: fetchMyUnreadNotificationCount,
    enabled,
  });
}

/**
 * §13.8:標為已讀。**前端唯一的寫入管道。**
 *
 * 🔴 這張表刻意沒有 UPDATE 政策(§13.2 第 5 點)—— PostgreSQL 的 RLS 不做欄位層級權限,
 *    一旦開了 UPDATE 政策,使用者就能把自己那一列的 title / body 改成任何內容。所以標已讀一律
 *    走這支 SECURITY DEFINER 函式,它只寫 read_at 一個欄位。**不要為了圖方便改成
 *    `supabase.from('user_notifications').update(...)`,那條路會被 GRANT 直接擋掉,而且擋得對。**
 *
 * @param ids 省略 / null 時 = 把自己**全部**未讀標完(「全部標為已讀」按鈕)。
 */
export async function markMyNotificationsRead(ids?: string[] | null): Promise<number> {
  // ⚠️ `exactOptionalPropertyTypes` 之下不能傳 `{ p_ids: undefined }` —— 那跟「這個欄位不存在」
  //    是兩件不同的事。沒有指定 ids 時整個屬性都不要帶,讓資料庫套用 `default null`
  //    (= 全部未讀都標成已讀)。
  const { data, error } = await supabase.rpc(
    "mark_my_notifications_read",
    Array.isArray(ids) ? { p_ids: ids } : {},
  );
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[] | null) => markMyNotificationsRead(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MY_NOTIFICATIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MY_UNREAD_NOTIFICATION_COUNT_QUERY_KEY });
    },
  });
}
