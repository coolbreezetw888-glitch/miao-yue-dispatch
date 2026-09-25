// 站內通知中心(鈴鐺)。對應規格書 §13.5 / §13.6 / §13.7 / §13.8。
//
// 掛載位置只有一處:src/routes/AppLayout.tsx 的頁首右側群組,排在「登出」按鈕**前面**
// (DOM 順序即視覺順序,鈴鐺在左 —— 使用者原話「登出的左側要有一個鈴鐺圖示」)。
//
// ❌ 超級管理員後台(/platform-admin/*)刻意**沒有**鈴鐺(§13.10):那是另一個外殼
//    (PlatformAdminShell),連「登出」按鈕都沒有,而且本批四種事件全部是「某間商家的訂單事件」,
//    超級管理員不是 admin/agent/staff 任何一種身份,一則通知都不會產生 —— 加上去只會做出一個
//    永遠空白的功能。PlatformAdminShell.test.tsx 有一條測試釘住這個決定。
//
// ⚠️ 版面是這個元件最大的風險(§13.6):頁首是全系統每一頁都會渲染的元件,320px 下餘裕很小。
//    兩個硬性要求,不是美術選擇:
//      ① 按鈕尺寸 h-8 w-8(32px),**不要**用 Button 的 size="icon"(那是 36px),視覺上也要跟
//         旁邊 32px 高的登出按鈕齊平;
//      ② 未讀 badge 一律 `absolute` 疊在鈴鐺右上角(按鈕本身 `relative`)。badge 如果排在 flex
//         流裡會再吃掉 20 多 px,而 §13.6 的寬度預算沒有那個空間。

import { Bell } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useMerchantSwitcherState } from "@/modules/merchant/context";
// §13.7:「事件標籤沿用既有的 PUSH_NOTIFICATION_EVENT_LABELS,不要重寫一套白話名稱」。
// 身份標籤同理沿用 PUSH_TARGET_TYPE_LABELS,避免同一個角色在兩個地方叫不同的名字。
import {
  PUSH_NOTIFICATION_EVENT_LABELS,
  PUSH_TARGET_TYPE_LABELS,
  type PushNotificationEventType,
} from "@/modules/push-notifications/types";

import {
  MY_NOTIFICATIONS_DEFAULT_LIMIT,
  useMarkNotificationsRead,
  useMyNotifications,
  useMyUnreadNotificationCount,
} from "./api";
import {
  formatRelativeNotificationTime,
  formatUnreadBadgeText,
  mergeNotificationRows,
  resolveNotificationLink,
} from "./notificationLink";
import type { MergedNotification } from "./types";

function eventLabel(eventType: string): string {
  return PUSH_NOTIFICATION_EVENT_LABELS[eventType as PushNotificationEventType] ?? eventType;
}

/** §13.7:合併顯示時標出兩個身份,例如「以客服、服務人員身份」。單一身份時不顯示(是雜訊)。 */
function multiIdentityLabel(item: MergedNotification): string | null {
  if (item.targetTypes.length <= 1) return null;
  return `以${item.targetTypes.map((t) => PUSH_TARGET_TYPE_LABELS[t]).join("、")}身份`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { merchants, currentMerchantId, setCurrentMerchantId } = useMerchantSwitcherState();

  const unreadQuery = useMyUnreadNotificationCount();
  // 面板沒打開就不查清單:未讀數字(head:true 的 count)本來就很省,但 20 列完整資料沒必要
  // 在每一頁載入時都撈一次。
  const listQuery = useMyNotifications(MY_NOTIFICATIONS_DEFAULT_LIMIT, open);
  const markRead = useMarkNotificationsRead();

  const badgeText = formatUnreadBadgeText(unreadQuery.data);
  const rows = listQuery.data ?? [];
  const merged = mergeNotificationRows(rows);
  // §13.7:商家名稱只有在「這個使用者可存取的商家超過一間」時才顯示,單一商家不需要這行雜訊。
  const showMerchantName = merchants.length > 1;
  const merchantNameById = new Map(merchants.map((m) => [m.id, m.name]));

  function handleRowClick(item: MergedNotification) {
    // ① 先標為已讀(合併顯示的那一列要把底下兩列一起標掉)。
    if (item.read_at === null) markRead.mutate(item.ids);

    // ② §13.7 第 2 點:這一列不是目前正在操作的商家 → 先切過去。**這一步不能省** —— 不切商家就
    //    直接導到 /app/orders,使用者會看到另一間店的訂單列表,以為系統壞了。
    if (item.merchant_id !== currentMerchantId) {
      setCurrentMerchantId(item.merchant_id);
    }

    // ③ 用純函式算出目的地並導航(跟 §5.5 的推播 payload url 完全同一套規則)。
    navigate(resolveNotificationLink({ target_type: item.primaryTargetType }));

    // ④ 關閉面板。
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // h-8 w-8 = 32px,跟旁邊的登出按鈕(size="sm",h-8)齊平。relative 是 badge 疊在右上角
          // 的定位基準(§13.6 第 5 點:badge 佔 0px 版面)。
          className="relative h-8 w-8 shrink-0 p-0"
          aria-label={badgeText ? `通知(${badgeText} 則未讀)` : "通知"}
          data-testid="notification-bell"
        >
          <Bell className="h-5 w-5" />
          {badgeText === null ? null : (
            <span
              data-testid="notification-unread-badge"
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
            >
              {badgeText}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      {/* §13.7:320px 下就是 296px,剛好在頁首內距之內,不會撐出橫向捲軸
          (e2e/mobile-overflow.spec.ts 與 e2e/app-header-320.spec.ts 都在守這件事)。 */}
      <PopoverContent
        align="end"
        className="w-[calc(100vw-1.5rem)] max-w-sm p-0"
        data-testid="notification-panel"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">通知</p>
          {/* §13.8:「全部標為已讀」 = p_ids 為 null,把自己全部未讀一次標完(**包含不在目前
              這 20 則裡面的**,這是刻意的:使用者按這顆按鈕的意思就是「全部清掉」)。 */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="notification-mark-all-read"
            disabled={markRead.isPending || !badgeText}
            onClick={() => markRead.mutate(null)}
          >
            全部標為已讀
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {listQuery.isLoading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">載入中⋯</p>
          ) : listQuery.isError ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" data-testid="notification-error">
              通知載入失敗,請稍後再試。
            </p>
          ) : merged.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" data-testid="notification-empty">
              目前沒有通知。手機推播的內容會同步留在這裡,滑掉了也找得回來。
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {merged.map((item) => {
                const identity = multiIdentityLabel(item);
                const merchantName = merchantNameById.get(item.merchant_id) ?? null;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      data-testid="notification-row"
                      data-notification-ids={item.ids.join(",")}
                      onClick={() => handleRowClick(item)}
                      className="flex w-full items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-accent"
                    >
                      {/* 未讀圓點:已讀的不顯示。用固定寬度的容器佔位,已讀/未讀兩種列的文字才會對齊。 */}
                      <span className="mt-1.5 flex w-2 shrink-0 justify-center">
                        {item.read_at === null ? (
                          <span
                            data-testid="notification-unread-dot"
                            className="h-2 w-2 rounded-full bg-destructive"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-xs text-muted-foreground">
                            {eventLabel(item.event_type)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatRelativeNotificationTime(item.created_at)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "block truncate text-sm text-foreground",
                            item.read_at === null ? "font-semibold" : null,
                          )}
                        >
                          {item.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.body}
                        </span>
                        {identity ? (
                          <span
                            data-testid="notification-identity"
                            className="block text-xs text-muted-foreground"
                          >
                            {identity}
                          </span>
                        ) : null}
                        {showMerchantName && merchantName ? (
                          <span
                            data-testid="notification-merchant-name"
                            className="block truncate text-xs text-muted-foreground"
                          >
                            {merchantName}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* §13.7:超過 20 則就在底部說清楚,不做分頁、不做無限捲動(v1 範圍控制)。 */}
        {rows.length >= MY_NOTIFICATIONS_DEFAULT_LIMIT ? (
          <p
            data-testid="notification-limit-hint"
            className="border-t border-border px-4 py-2 text-xs text-muted-foreground"
          >
            只顯示最近 {MY_NOTIFICATIONS_DEFAULT_LIMIT} 則
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export default NotificationBell;
