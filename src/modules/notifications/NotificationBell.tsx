// 站內通知中心(鈴鐺)。對應規格書 §13.5 / §13.6 / §13.7 / §13.8。
//
// 掛載位置只有一處:src/routes/AppLayout.tsx 的頁首**最右側**。
// (2026-09-29 之前右邊還有一顆「登出」按鈕、鈴鐺排在它左邊;#834 之後登出收進左上角的商家
// 切換器選單,右側只剩鈴鐺。)
//
// ❌ 超級管理員後台(/platform-admin/*)刻意**沒有**鈴鐺(§13.10):那是另一個外殼
//    (PlatformAdminShell),連「登出」按鈕都沒有,而且本批四種事件全部是「某間商家的訂單事件」,
//    超級管理員不是 admin/agent/staff 任何一種身份,一則通知都不會產生 —— 加上去只會做出一個
//    永遠空白的功能。PlatformAdminShell.test.tsx 有一條測試釘住這個決定。
//
// ⚠️ 版面是這個元件最大的風險(§13.6):頁首是全系統每一頁都會渲染的元件,320px 下餘裕很小。
//    兩個硬性要求,不是美術選擇:
//      ① 按鈕尺寸 h-8 w-8(32px),**不要**用 Button 的 size="icon"(那是 36px),跟左邊 32px 的
//         商家切換器 LOGO 按鈕齊平(左右等寬,標題才會自然置中);
//      ② 未讀 badge 一律 `absolute` 疊在鈴鐺右上角(按鈕本身 `relative`)。badge 如果排在 flex
//         流裡會再吃掉 20 多 px,而 §13.6 的寬度預算沒有那個空間。
//
// =========================================================================
// 2026-09-29 ui-v1-small(SPECS-INDEX #835,規範:.claude/skills/ui-overlay-patterns/SKILL.md
// 第五節,使用者定案的方案 D):**面板容器**依螢幕寬度分兩種,**面板裡面的內容與邏輯完全沒動**:
//
//   ・電腦(Tailwind `sm` = 640px 以上):維持 Popover 氣泡,但寬度改成**固定 380px**、align="end"
//     對齊鈴鐺右緣 —— 鈴鐺現在是頁首最右邊的東西,所以面板右緣就等於內容區右緣。
//   ・手機(640px 以下):改用 Sheet(side="bottom"),**從底部滑上來的全寬面板**,頂部一條
//     置中的拖曳握把。
//
//   🔴 為什麼不能再用原本的 `w-[calc(100vw-1.5rem)] max-w-sm`:那個寬度會隨螢幕變形,而且原本
//   的 bug 就是「面板貼著鈴鐺右緣展開,但鈴鐺右邊還有登出按鈕,所以面板右邊空出一塊、左邊貼邊」。
//   固定寬度 + 鈴鐺在最右邊,這個問題從結構上就不會再發生。
//
//   為什麼是「兩個 Radix 元件擇一渲染」而不是「一個 Popover 用 CSS 改成貼底」:Radix Popover 的
//   定位是用 inline style 的 transform 算出來的(floating-ui),CSS 硬蓋 position/inset 會跟它打架,
//   而且 Popover 沒有背景遮罩、不鎖捲動,不是「面板」該有的行為。Sheet 本來就是專案裡行事曆
//   預約詳情在用的底部面板元件(BookingDetailDialog.tsx / MyBookingDetailDialog.tsx),沿用它
//   改動最小、外觀也跟全站一致。
//
//   螢幕寬度用 src/hooks/use-media-query.ts 的 useMediaQuery(TAILWIND_SM_MEDIA_QUERY) 判斷,
//   跟全站 `sm:` class 用同一條 640px 的線(不是 use-mobile.tsx 的 768px)。
//
//   手機版關閉方式:點握把(它本身是一顆按鈕)、點背景遮罩、Escape、或點任一則通知(既有邏輯
//   會 setOpen(false))。SheetContent 內建的右上角 ✕ 在這裡用 class 藏掉:它會跟同一列的
//   「全部標為已讀」按鈕疊在一起,而握把已經是關閉入口。
// =========================================================================

import { Bell } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TAILWIND_SM_MEDIA_QUERY, useMediaQuery } from "@/hooks/use-media-query";
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
  // #835:640px 以上走 Popover 氣泡,以下走底部 Sheet(見檔頭說明)。
  const isDesktop = useMediaQuery(TAILWIND_SM_MEDIA_QUERY);
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

  // 觸發按鈕(鈴鐺)兩種容器共用同一顆,只是外面包的 Trigger 不同。
  const bellButton = (
    <Button
      type="button"
      variant="ghost"
      // h-8 w-8 = 32px,跟頁首左邊 32px 的商家切換器 LOGO 按鈕齊平。relative 是 badge 疊在右上角
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
  );

  // 面板標題。手機版的 Sheet 底層是 Radix Dialog,一定要有一個 DialogTitle 給讀螢幕的人當
  // 對話框名稱(沒有會在 console 警告),所以手機版把這行「通知」本身就當成 SheetTitle,
  // 不另外塞一個看不見的標題造成重複朗讀。電腦版維持原本的 <p>。
  const panelHeading = isDesktop ? (
    <p className="text-sm font-semibold text-foreground">通知</p>
  ) : (
    <SheetTitle className="text-sm font-semibold text-foreground">通知</SheetTitle>
  );

  // 面板內容(標題列 + 清單 + 底部提示):兩種容器共用,#835 沒有改這裡面的任何邏輯。
  const panelBody = (
    <>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        {panelHeading}
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
          /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。
             🔴 這裡**不能套頁面骨架**(LoadingSkeleton 的 cards/lines 是給頁面內容用的):
             這是頁首鈴鐺的通知面板,一列通知是「未讀圓點 + 事件名 + 時間 + 內文」,
             所以骨架照那個形狀做,列高與 px-4 py-3 的內距跟真正的通知列一致
             —— 資料進來時版面才不會跳(這就是骨架比四個字好的理由之一)。 */
          <ul className="divide-y divide-border" aria-busy="true" aria-live="polite">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-start gap-2 px-4 py-3">
                <div className="mt-1.5 flex w-2 shrink-0 justify-center">
                  <Skeleton className="h-2 w-2 rounded-full bg-muted" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Skeleton className="h-2.5 w-24 rounded-sm bg-muted/70" />
                    <Skeleton className="h-2.5 w-16 shrink-0 rounded-sm bg-muted/70" />
                  </div>
                  <Skeleton className="h-3 w-[80%] rounded-sm bg-muted" />
                </div>
              </li>
            ))}
          </ul>
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
    </>
  );

  if (!isDesktop) {
    // 手機:底部滑上來的全寬面板(#835)。
    //   ・rounded-t-2xl = 16px 上圓角,跟 ui-overlay-patterns 第三節「四角 16px」同一個數字。
    //   ・p-0 gap-0:蓋掉 sheet.tsx 預設的 p-6 gap-4,內距由面板內容自己控制(跟電腦版一致)。
    //   ・max-h-[85vh]:比照 MyBookingDetailDialog 的高度上限,不會蓋掉整個畫面。內容區本身
    //     已有 max-h-[60vh] overflow-y-auto,加上握把與標題列剛好在上限之內。
    //   ・[&>button.absolute]:hidden:藏掉 SheetContent 內建的右上角 ✕(理由見檔頭)。
    //     選擇器只認「直接子層 + absolute」那一顆,不會誤傷下面的握把按鈕或內容裡的按鈕。
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{bellButton}</SheetTrigger>
        <SheetContent
          side="bottom"
          // 這個面板沒有 Description,明確給 undefined 讓 Radix 不要對缺少 aria-describedby 警告。
          aria-describedby={undefined}
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-t-2xl p-0 [&>button.absolute]:hidden"
          data-testid="notification-panel"
        >
          {/* 拖曳握把:置中的小圓角橫條。做成按鈕是為了讓它真的能關閉面板(Radix 沒有手勢下拉),
              h-11 = 44px 是規範要求的最小觸控目標;視覺上只看得到中間那條 bg-border 的橫條。 */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="關閉通知面板"
            data-testid="notification-sheet-handle"
            className="flex h-11 w-full shrink-0 items-center justify-center"
          >
            <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-border" />
          </button>
          {panelBody}
        </SheetContent>
      </Sheet>
    );
  }

  // 電腦:固定 380px 的氣泡,對齊鈴鐺右緣(#835)。
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{bellButton}</PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0" data-testid="notification-panel">
        {panelBody}
      </PopoverContent>
    </Popover>
  );
}

export default NotificationBell;
